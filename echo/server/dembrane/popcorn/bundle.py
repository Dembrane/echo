"""Read side shared by the in-app and public popcorn pages.

Connected presentations reload this authoritative bundle when the existing
session SSE channel says that the tick wrote. Many viewers can react to the
same nudge together, so the bundle is memoised briefly per report. Writers
invalidate their local cache before publishing; readers retain a short delay
to cover a nudge and bundle request landing on different API processes.

Where the analysis writer owns a session's producer scopes, the deck's phrases,
tensions and stakeholders are projected from the published revisions instead of
from the tick's state: the same objects the Map draws, under the field names the
deck reads (`poleA`, `poleB`, `knot`, `toResolve`, `quoteIds`, `evidence.rung`,
`weight.stake`). The state still says what is happening right now, which
conversation is still being read and which second pass is owed, because that is
a fact about the session and not about an object. A scope the legacy writer
still owns is served from the state, unchanged.
"""

from __future__ import annotations

import time
import logging
from typing import Any, Callable
from dataclasses import field, dataclass

from dembrane.analysis import db
from dembrane.settings import get_settings
from dembrane.legal_basis import fetch_cascade_rows, resolve_effective_legal_basis
from dembrane.directus_async import async_directus
from dembrane.analysis.outbox import register_snapshot_hook
from dembrane.popcorn.service import (
    TOGGLEABLE_TABS,
    build_bundle,
    normalize_state,
    conversation_url,
    get_latest_config,
    normalize_settings,
    get_loop_for_report,
    mark_synthetic_files,
    resolve_presentation_settings,
)
from dembrane.popcorn.analysis import norm
from dembrane.popcorn.translate import translated_bundle
from dembrane.analysis.contracts import (
    OutboxEvent,
    AnalysisStore,
    ObjectRevision,
    AnalysisStoreError,
)
from dembrane.analysis.snapshots import (
    ProducerRef,
    SnapshotRequest,
    read_snapshot,
    resolve_snapshot,
    assemble_snapshot,
    excluded_object_ids,
)

logger = logging.getLogger("dembrane.popcorn.bundle")

BUNDLE_CACHE_SECONDS = 0.5
_cache: dict[str, tuple[float, dict[str, Any]]] = {}

POPCORN_RECIPE_ID = "popcorn"
TENSIONS_RECIPE_ID = "tensions"
STAKEHOLDERS_RECIPE_ID = "stakeholders"
DECK_RECIPES = (POPCORN_RECIPE_ID, TENSIONS_RECIPE_ID, STAKEHOLDERS_RECIPE_ID)
DECK_VIEW_ID = "deck"
DECK_SCOPE_KEY = "project"


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value is not None else None


async def load_settings(report: dict[str, Any]) -> dict[str, Any]:
    config = await get_latest_config(str(report["id"]))
    return normalize_settings(
        (config or {}).get("popcorn_settings"),
        fallback_title=str(report.get("user_instructions") or "Popcorn"),
    )


# ── the published objects behind the deck ────────────────────────────────


@dataclass(frozen=True)
class DeckObjects:
    """One project's published deck objects, by the scope that owns them. Only
    scopes whose writer is the executor are here: anything else stays the
    session state's to serve."""

    popcorn: dict[str, list[ObjectRevision]] = field(default_factory=dict)
    tensions: list[ObjectRevision] = field(default_factory=list)
    stakeholders: list[ObjectRevision] = field(default_factory=list)
    relations: list[Any] = field(default_factory=list)
    owns_tensions: bool = False
    owns_stakeholders: bool = False

    @property
    def empty(self) -> bool:
        return not (self.popcorn or self.owns_tensions or self.owns_stakeholders)


async def analysis_heads(
    project_id: str,
    dsn: str | None = None,
    *,
    store: AnalysisStore | None = None,
) -> list[dict[str, Any]]:
    """Each deck producer scope the executor owns, with its ready output. One
    query: the deck is polled, and a scope read per conversation would not do."""
    in_memory_scopes = getattr(store, "scopes", None)
    if isinstance(in_memory_scopes, dict):
        return [
            {
                "recipe_id": scope.recipe_id,
                "scope_key": scope.scope_key,
                "scope_id": scope.id,
                "run_id": scope.current_run_id,
            }
            for scope in in_memory_scopes.values()
            if scope.project_id == project_id
            and str(scope.kind) == "producer"
            and str(scope.writer) == "analysis"
            and scope.recipe_id in DECK_RECIPES
            and scope.current_run_id
        ]
    async with db.autocommit_cursor(dsn, AnalysisStoreError) as cursor:
        await cursor.execute(
            """SELECT s.recipe_id, s.scope_key, s.id::text AS scope_id,
                      s.current_run_id::text AS run_id
                 FROM analysis_scope s
                 JOIN analysis_run r ON r.id = s.current_run_id
                WHERE s.project_id = %s AND s.kind = 'producer' AND s.writer = 'analysis'
                  AND s.recipe_id = ANY(%s)""",
            (project_id, list(DECK_RECIPES)),
        )
        return [dict(row) for row in await cursor.fetchall()]


async def assemble_deck_snapshot(
    project_id: str,
    *,
    store: AnalysisStore,
    dsn: str | None = None,
    source_event_id: str | None = None,
):
    heads = await analysis_heads(project_id, dsn, store=store)
    if not heads:
        return None
    return await assemble_snapshot(
        SnapshotRequest(
            project_id=project_id,
            view_id=DECK_VIEW_ID,
            scope_key=DECK_SCOPE_KEY,
            producers=tuple(
                ProducerRef(str(head["recipe_id"]), str(head["scope_key"])) for head in heads
            ),
            versions={"deckProjection": 1},
            source_event_id=source_event_id,
        ),
        store=store,
    )


async def current_deck_snapshot(project_id: str, *, store: AnalysisStore):
    return await resolve_snapshot(
        store=store,
        project_id=project_id,
        view_id=DECK_VIEW_ID,
        scope_key=DECK_SCOPE_KEY,
    )


async def load_deck_objects(
    project_id: str,
    *,
    store: AnalysisStore | None = None,
    dsn: str | None = None,
    snapshot_id: str | None = None,
) -> DeckObjects:
    """The deck's objects as the analysis store holds them. An empty result
    means the session is still the legacy writer's, and the deck is built from
    its state as before."""
    from dembrane.analysis.executor import default_store

    store = store or default_store()
    snapshot = (
        await resolve_snapshot(store=store, project_id=project_id, snapshot_id=snapshot_id)
        if snapshot_id
        else await current_deck_snapshot(project_id, store=store)
    )
    # Older projects may predate the publication hook that materializes deck
    # views. Seed their first immutable view once; events advance it afterward.
    if snapshot is None and snapshot_id is None:
        snapshot = await assemble_deck_snapshot(project_id, store=store, dsn=dsn)
    if snapshot is None:
        return DeckObjects()
    contents = await read_snapshot(snapshot, store=store)
    producers = snapshot.manifest.get("producers") or []
    popcorn: dict[str, list[ObjectRevision]] = {}
    tensions: list[ObjectRevision] = []
    stakeholders: list[ObjectRevision] = []
    for revision in contents.revisions.values():
        if revision.type == "popcorn":
            conversation_id = next(
                (
                    source.conversation_id
                    for source in revision.provenance.source_refs
                    if source.conversation_id
                ),
                str(revision.provenance.extra.get("conversationId") or ""),
            )
            if conversation_id:
                popcorn.setdefault(conversation_id, []).append(revision)
        elif revision.type == "tension":
            tensions.append(revision)
        elif revision.type == "stakeholder":
            stakeholders.append(revision)

    return DeckObjects(
        popcorn=popcorn,
        tensions=tensions,
        stakeholders=stakeholders,
        relations=list(contents.relations.values()),
        owns_tensions=any(p.get("recipeId") == TENSIONS_RECIPE_ID for p in producers),
        owns_stakeholders=any(p.get("recipeId") == STAKEHOLDERS_RECIPE_ID for p in producers),
    )


# ── the deck's own shapes ────────────────────────────────────────────────


class _Quotes:
    """The registry the deck resolves `quoteId` and `quoteIds` against, minted
    over exactly the quotes these objects cite. One id per conversation and
    wording, as the session's own registry does."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []
        self._ids: dict[tuple[str, str], str] = {}

    def add(self, quote: Any) -> str | None:
        if not isinstance(quote, dict):
            return None
        text = str(quote.get("text") or "").strip()
        conversation_id = str(quote.get("conversationId") or "")
        if not text or not conversation_id:
            return None
        key = (conversation_id, norm(text))
        if key in self._ids:
            return self._ids[key]
        quote_id = f"q{len(self.entries) + 1}"
        self._ids[key] = quote_id
        self.entries.append({"id": quote_id, "transcript": conversation_id, "text": text})
        return quote_id

    def add_all(self, quotes: Any) -> list[str]:
        return [qid for qid in (self.add(q) for q in quotes or []) if qid]


# How a projection mints the quote id the deck resolves: the deck's own
# registry here, the tick's shared QuoteBook when the tick projects a slide
# back into its state, so ids the room already holds stay valid.
Register = Callable[[dict[str, Any]], str | None]


def _register_all(register: Register, quotes: Any) -> list[str]:
    return [qid for qid in (register(q) for q in quotes or [] if isinstance(q, dict)) if qid]


def _extra(revision: ObjectRevision) -> dict[str, Any]:
    return dict(revision.provenance.extra or {})


def _popcorn_item(
    revision: ObjectRevision,
    conversation_id: str,
    register: Register,
    sources: dict[str, Any],
    host: bool,
) -> dict[str, Any]:
    payload, extra = revision.payload, _extra(revision)
    phrase = str(payload["phrase"])
    entry: dict[str, Any] = {
        "id": str(extra.get("phraseId") or f"p-{conversation_id}-{revision.object_id[:8]}"),
        "phrase": phrase,
        "objectId": revision.object_id,
        "revisionId": revision.id,
    }
    if payload.get("question"):
        entry["question"] = True
    if extra.get("verbatim"):
        entry["verbatim"] = True
    if extra.get("kind"):
        entry["kind"] = str(extra["kind"])
        entry["qualifiers"] = [str(q) for q in extra.get("qualifiers") or []]
    quote_ids = _register_all(
        register,
        [
            {"text": quote, "conversationId": item.get("conversationId")}
            for item in payload.get("evidence") or []
            for quote in item.get("quotes") or []
        ],
    )
    if quote_ids:
        entry["quoteId"] = quote_ids[0]
    elif host and sources.get(phrase):
        # The closest passage is the host's reading aid, and belongs to the
        # session that computed it rather than to the object.
        entry["source"] = sources[phrase]
    return entry


def tension_slide(revision: ObjectRevision, index: int, register: Register) -> dict[str, Any]:
    payload = revision.payload
    return {
        "id": f"x{index}",
        "objectId": revision.object_id,
        "revisionId": revision.id,
        "poleA": payload["poleA"],
        "poleB": payload["poleB"],
        "knot": payload["knot"],
        "toResolve": payload["toResolve"],
        "quoteIds": _register_all(register, payload.get("quotes")),
    }


def _stakeholder(revision: ObjectRevision, index: int, register: Register) -> dict[str, Any]:
    payload = revision.payload
    evidence: dict[str, Any] = {"rung": payload["rung"]}
    return {
        "id": f"s{index}",
        "objectId": revision.object_id,
        "revisionId": revision.id,
        "name": payload["name"],
        "role": payload["role"],
        "stake": payload["stake"],
        "quoteIds": _register_all(register, payload.get("quotes")),
        "evidence": evidence,
        "weight": {
            "stake": round(float(payload["weight"]["stake"]), 2),
            "mentions": round(float(payload["weight"]["mentions"]), 2),
        },
    }


def _stakeholder_order(revision: ObjectRevision) -> tuple[float, str]:
    weight = revision.payload.get("weight") or {}
    return (-float(weight.get("stake") or 0.0), str(revision.payload.get("name") or ""))


def stakeholders_slide(
    people: list[ObjectRevision], relations: list[Any], register: Register
) -> dict[str, Any]:
    """The stakeholders slide as the deck reads it, ordered by what is at stake
    so the ranking is the same whichever run published it."""
    ordered = sorted(people, key=_stakeholder_order)
    by_revision = {revision.id: index for index, revision in enumerate(ordered, start=1)}
    slide = [_stakeholder(revision, by_revision[revision.id], register) for revision in ordered]
    by_name = {norm(str(entry["name"])): entry["id"] for entry in slide}
    for revision, entry in zip(ordered, slide, strict=True):
        invoked = revision.payload.get("invokedBy")
        # The payload names the group that spoke for this one; the deck wants
        # the id it drew that group under, and shows nothing when it is absent.
        if invoked and norm(str(invoked)) in by_name:
            entry["evidence"]["invokedBy"] = by_name[norm(str(invoked))]
    out: list[dict[str, Any]] = []
    for relation in relations:
        ends = [
            by_revision.get(relation.from_revision_id),
            by_revision.get(relation.to_revision_id),
        ]
        if None in ends:
            continue
        attributes = dict(relation.attributes or {})
        aspects = []
        for aspect in attributes.get("aspects") or []:
            quote_ids = _register_all(register, aspect.get("quotes"))
            if not quote_ids:
                continue  # no quote, no aspect: the deck's own rule
            aspects.append(
                {"kind": aspect.get("kind"), "note": aspect.get("note"), "quoteIds": quote_ids}
            )
        out.append(
            {
                "id": f"r{len(out) + 1}",
                "between": [f"s{ends[0]}", f"s{ends[1]}"],
                "label": attributes.get("label", ""),
                "intensity": round(float(attributes.get("intensity") or 0.0), 2),
                "sentiment": round(float(attributes.get("sentiment") or 0.0), 2),
                "unowned": bool(attributes.get("unowned")),
                "detail": attributes.get("detail", ""),
                "aspects": aspects,
            }
        )
    return {"stakeholders": slide, "relations": out}


def apply_published_objects(
    bundle: dict[str, Any],
    objects: DeckObjects,
    *,
    settings: dict[str, Any],
    project: dict[str, Any],
    host: bool,
    admin_base_url: str = "",
) -> dict[str, Any]:
    """The deck's files with every scope the executor owns served from its
    published revisions. The files of a scope it does not own are left exactly
    as the session state wrote them."""
    if objects.empty:
        return bundle
    files = dict(bundle["files"])
    quotes = _Quotes()
    tabs = settings.get("tabs") or {}
    for conversation_id, revisions in objects.popcorn.items():
        name = f"popcorn/{conversation_id}.json"
        current = dict(
            files.get(name) or {"transcript": conversation_id, "revision": 1, "done": True}
        )
        # The closest passage behind an unrooted phrase is the session's, and
        # the host reads it beside the phrase it was computed for.
        sources = {
            str(item.get("phrase")): item["source"]
            for item in current.get("items") or []
            if isinstance(item, dict) and item.get("source")
        }
        current["items"] = [
            _popcorn_item(revision, conversation_id, quotes.add, sources, host)
            for revision in revisions
        ]
        files[name] = current
    if objects.owns_tensions and tabs.get("tensions", True):
        ordered = sorted(objects.tensions, key=lambda r: (str(r.payload.get("poleA")), r.object_id))
        files["tensions.json"] = {
            "tensions": [
                tension_slide(r, index, quotes.add) for index, r in enumerate(ordered, start=1)
            ]
        }
    if objects.owns_stakeholders and tabs.get("stakeholders", True):
        files["stakeholders.json"] = stakeholders_slide(
            objects.stakeholders, objects.relations, quotes.add
        )
    if quotes.entries or "quotes.json" in files:
        entries = []
        for quote in quotes.entries:
            entry = dict(quote)
            if host and admin_base_url:
                entry["url"] = conversation_url(project, str(quote["transcript"]), admin_base_url)
            entries.append(entry)
        files["quotes.json"] = {"quotes": entries}
    for tab in TOGGLEABLE_TABS:
        if not tabs.get(tab, True):
            files.pop(f"{tab}.json", None)
    return {**bundle, "files": mark_synthetic_files(files)}


async def published_bundle(
    bundle: dict[str, Any],
    *,
    project_id: str | None,
    settings: dict[str, Any],
    project: dict[str, Any],
    host: bool,
    admin_base_url: str = "",
    store: AnalysisStore | None = None,
) -> dict[str, Any]:
    """`bundle` with the published objects applied where they exist. A store
    that cannot answer leaves the session's own deck standing: the room is mid
    session, and a database error is not a reason to empty the wall."""
    if not project_id:
        return bundle
    try:
        objects = await load_deck_objects(project_id, store=store)
    except Exception as exc:  # noqa: BLE001
        # The deck is polled several times a second, so this says what happened
        # plainly and once, never a traceback per read.
        logger.warning("popcorn deck: published objects unavailable (%s)", type(exc).__name__)
        return bundle
    return apply_published_objects(
        bundle,
        objects,
        settings=settings,
        project=project,
        host=host,
        admin_base_url=admin_base_url,
    )


def _without_objects(bundle: dict[str, Any], hidden: set[str]) -> dict[str, Any]:
    """`bundle` without the hidden objects, wherever its files list them. A
    stakeholder relation leaves with either of its ends: a line drawn to a
    stakeholder who is no longer on the wall says something nobody meant."""
    if not hidden:
        return bundle
    files = {
        name: dict(value) if isinstance(value, dict) else value
        for name, value in bundle["files"].items()
    }
    for name, file in files.items():
        if not isinstance(file, dict):
            continue
        for key in ("items", "tensions", "stakeholders"):
            if isinstance(file.get(key), list):
                file[key] = [
                    item for item in file[key] if item.get("objectId", item.get("id")) not in hidden
                ]
        if name == "stakeholders.json":
            kept = {item["id"] for item in file.get("stakeholders", [])}
            file["relations"] = [
                relation
                for relation in file.get("relations", [])
                if all(end in kept for end in relation.get("between", []))
            ]
    return {**bundle, "files": files}


async def apply_shared_withdrawals(
    bundle: dict[str, Any], project_id: str | None, *, store: AnalysisStore | None = None
) -> dict[str, Any]:
    """Remove current withdrawals even from an older presentation binding."""
    if not project_id:
        return bundle
    from dembrane.analysis.executor import default_store

    store = store or default_store()
    return _without_objects(bundle, await excluded_object_ids(project_id, store=store))


# ── the bundle the pages read ────────────────────────────────────────────


async def with_effective_legal_basis(
    project: dict[str, Any], settings: dict[str, Any]
) -> dict[str, Any]:
    """The project as the data screen must describe it: its legal basis
    resolved through workspace and owner, the way the portal resolves it.
    Only fetched when the screen is on."""
    if not (settings.get("data") or {}).get("enabled") or not project.get("id"):
        return project
    rows = await fetch_cascade_rows(project)
    effective = resolve_effective_legal_basis(
        project=project, workspace=rows.workspace, owner=rows.owner
    )
    return {
        **project,
        "legal_basis": effective.legal_basis,
        "privacy_policy_url": effective.privacy_policy_url,
    }


async def bundle_for_report(
    report: dict[str, Any],
    project: dict[str, Any] | None = None,
    *,
    host: bool = False,
    settings_override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    report_id = str(report["id"])
    cache_key = f"{report_id}:{'host' if host else 'public'}"
    now = time.monotonic()
    cached = _cache.get(cache_key) if settings_override is None else None
    if cached and now - cached[0] < BUNDLE_CACHE_SECONDS:
        return cached[1]

    loop = await get_loop_for_report(report_id)
    settings = settings_override if settings_override is not None else await load_settings(report)
    if project is None:
        project_id = _as_id(report.get("project_id"))
        project = (
            await async_directus.get_item("project", project_id) if project_id else None
        ) or {}
    settings = resolve_presentation_settings(settings, project)
    project = await with_effective_legal_basis(project, settings)
    state = normalize_state((loop or {}).get("popcorn_state"))
    urls = get_settings().urls
    bundle = build_bundle(
        state=state,
        settings=settings,
        report=report,
        project=project,
        participant_base_url=urls.participant_base_url,
        admin_base_url=urls.admin_base_url,
        host=host,
        dev=bool(get_settings().feature_flags.serve_api_docs),
    )
    resolved_project_id = _as_id(project.get("id")) or _as_id(report.get("project_id"))
    bundle = await published_bundle(
        bundle,
        project_id=resolved_project_id,
        settings=settings,
        project=project,
        host=host,
        admin_base_url=urls.admin_base_url,
    )
    bundle = await apply_result_bindings(
        bundle,
        report_id,
        settings,
        project_id=resolved_project_id,
    )
    bundle = translated_bundle(bundle, state, settings)
    bundle = await apply_shared_withdrawals(bundle, resolved_project_id)
    bundle = curate_presentation(bundle, settings)
    if settings_override is None:
        _cache[cache_key] = (now, bundle)
    if len(_cache) > 512:
        oldest = sorted(_cache.items(), key=lambda item: item[1][0])[: len(_cache) - 256]
        for key, _ in oldest:
            _cache.pop(key, None)
    return bundle


def forget_bundle(report_id: str) -> None:
    for key in (f"{report_id}:host", f"{report_id}:public"):
        _cache.pop(key, None)


async def deck_view_hook(event: OutboxEvent, store: AnalysisStore) -> None:
    """Advance the effective deck and wake connected screens after publication."""
    if event.event_type not in ("run_published", "revision_published"):
        return
    if event.event_type == "run_published" and event.payload.get("recipeId") not in DECK_RECIPES:
        return
    if event.event_type == "revision_published" and event.payload.get("type") not in (
        "popcorn",
        "tension",
        "stakeholder",
    ):
        return
    snapshot = await assemble_deck_snapshot(
        event.project_id,
        store=store,
        source_event_id=event.id,
    )
    if snapshot is None:
        return
    from dembrane.popcorn import service

    report = await service.get_popcorn_report(event.project_id)
    if report:
        report_id = str(report["id"])
        forget_bundle(report_id)
        from dembrane.canvas.events import publish_generation_nudge

        await publish_generation_nudge(report_id)


register_snapshot_hook(deck_view_hook)


def curate_presentation(bundle: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    """Presentation-local hiding never withdraws a shared finding."""
    hidden = set((settings.get("presentation") or {}).get("hidden_items") or [])
    return _without_objects(bundle, hidden)


async def apply_result_bindings(
    bundle: dict[str, Any],
    report_id: str,
    settings: dict[str, Any],
    *,
    project_id: str | None = None,
    store: AnalysisStore | None = None,
) -> dict[str, Any]:
    """Keep non-live slides on the host-adopted saved version.

    Namespace pinned quote IDs because live Popcorn's registry keeps growing.
    The immutable version remains scoped to its report by get_version_files.
    """
    from dembrane.popcorn.service import room_files, get_version_files

    bindings = (settings.get("presentation") or {}).get("result_bindings") or {}
    if not bindings:
        return bundle
    files = dict(bundle["files"])
    quotes = list((files.get("quotes.json") or {}).get("quotes") or [])
    loaded: dict[str, Any] = {}
    for block in ("stakeholders", "tensions"):
        version = bindings.get(block)
        if not version or not (settings.get("tabs") or {}).get(block):
            continue
        if version not in loaded:
            if str(version).startswith("analysis:") and project_id:
                objects = await load_deck_objects(
                    project_id,
                    store=store,
                    snapshot_id=str(version).split(":", 1)[1],
                )
                loaded[version] = apply_published_objects(
                    {"files": {}},
                    objects,
                    settings=settings,
                    project={"id": project_id},
                    host=False,
                )["files"]
            else:
                stored = await get_version_files(report_id, version)
                loaded[version] = (
                    room_files(stored, neutral_labels=settings.get("public_labels") != "names")
                    if stored
                    else None
                )
        pinned = loaded[version]
        if not pinned:
            continue
        name = f"{block}.json"
        if name not in pinned:
            files.pop(name, None)
            continue
        prefix = f"{block}:{version}:"

        def remap(value: Any, prefix: str = prefix) -> Any:
            if isinstance(value, list):
                return [remap(item) for item in value]
            if not isinstance(value, dict):
                return value
            return {
                key: [prefix + str(q) for q in val]
                if key == "quoteIds" and isinstance(val, list)
                else prefix + str(val)
                if key == "quoteId"
                else remap(val)
                for key, val in value.items()
            }

        files[name] = remap(pinned[name])
        quotes.extend(
            {**quote, "id": prefix + str(quote["id"])}
            for quote in (pinned.get("quotes.json") or {}).get("quotes", [])
            if quote.get("id")
        )
    files["quotes.json"] = {"quotes": quotes}
    return {**bundle, "files": files}
