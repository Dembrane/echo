"""Read side shared by the in-app and public popcorn pages.

The presentation polls its data at up to five times a second while the stage
is empty, and every viewer in the room may hold a tab open, so the bundle is
memoised for a moment per report. The tick nudges the channel when it writes,
and the stale window is shorter than the page's own poll interval.

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
from dembrane.popcorn.service import (
    TOGGLEABLE_TABS,
    build_bundle,
    normalize_state,
    conversation_url,
    get_latest_config,
    normalize_settings,
    get_loop_for_report,
    mark_synthetic_files,
)
from dembrane.popcorn.analysis import norm
from dembrane.popcorn.translate import translated_bundle
from dembrane.analysis.contracts import AnalysisStore, ObjectRevision, AnalysisStoreError

logger = logging.getLogger("dembrane.popcorn.bundle")

BUNDLE_CACHE_SECONDS = 0.5
_cache: dict[str, tuple[float, dict[str, Any]]] = {}

POPCORN_RECIPE_ID = "popcorn"
TENSIONS_RECIPE_ID = "tensions"
STAKEHOLDERS_RECIPE_ID = "stakeholders"
DECK_RECIPES = (POPCORN_RECIPE_ID, TENSIONS_RECIPE_ID, STAKEHOLDERS_RECIPE_ID)


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


async def analysis_heads(project_id: str, dsn: str | None = None) -> list[dict[str, Any]]:
    """Each deck producer scope the executor owns, with its ready output. One
    query: the deck is polled, and a scope read per conversation would not do."""
    async with db.autocommit_cursor(dsn, AnalysisStoreError) as cursor:
        await cursor.execute(
            """SELECT s.recipe_id, s.scope_key, r.output_manifest
                 FROM analysis_scope s
                 JOIN analysis_run r ON r.id = s.current_run_id
                WHERE s.project_id = %s AND s.kind = 'producer' AND s.writer = 'analysis'
                  AND s.recipe_id = ANY(%s)""",
            (project_id, list(DECK_RECIPES)),
        )
        return [dict(row) for row in await cursor.fetchall()]


def _manifest_ids(manifest: Any, type_id: str) -> list[str]:
    objects = (manifest or {}).get("objects") or []
    return [str(o["revisionId"]) for o in objects if o.get("type") == type_id]


async def load_deck_objects(
    project_id: str, *, store: AnalysisStore | None = None, dsn: str | None = None
) -> DeckObjects:
    """The deck's objects as the analysis store holds them. An empty result
    means the session is still the legacy writer's, and the deck is built from
    its state as before."""
    from dembrane.analysis.executor import default_store

    store = store or default_store()
    heads = await analysis_heads(project_id, dsn)
    if not heads:
        return DeckObjects()
    wanted: dict[str, list[str]] = {}
    relation_ids: list[str] = []
    owns_tensions = owns_stakeholders = False
    for head in heads:
        manifest = head.get("output_manifest") or {}
        recipe_id, scope_key = str(head["recipe_id"]), str(head["scope_key"])
        if recipe_id == POPCORN_RECIPE_ID and scope_key.startswith("conversation:"):
            wanted[scope_key] = _manifest_ids(manifest, "popcorn")
        elif recipe_id == TENSIONS_RECIPE_ID:
            owns_tensions = True
            wanted["tensions"] = _manifest_ids(manifest, "tension")
        elif recipe_id == STAKEHOLDERS_RECIPE_ID:
            owns_stakeholders = True
            wanted["stakeholders"] = _manifest_ids(manifest, "stakeholder")
            relation_ids = [
                str(r["relationId"])
                for r in manifest.get("relations") or []
                if r.get("type") == "stakeholder_relation"
            ]
    every = [rid for ids in wanted.values() for rid in ids]
    revisions = await store.get_revisions(project_id, every) if every else {}
    relations = await store.get_relations(project_id, relation_ids) if relation_ids else {}

    def found(key: str) -> list[ObjectRevision]:
        return [revisions[rid] for rid in wanted.get(key, []) if rid in revisions]

    return DeckObjects(
        popcorn={
            key.split(":", 1)[1]: found(key) for key in wanted if key.startswith("conversation:")
        },
        tensions=found("tensions"),
        stakeholders=found("stakeholders"),
        relations=[relations[rid] for rid in relation_ids if rid in relations],
        owns_tensions=owns_tensions,
        owns_stakeholders=owns_stakeholders,
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
) -> dict[str, Any]:
    report_id = str(report["id"])
    cache_key = f"{report_id}:{'host' if host else 'public'}"
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached and now - cached[0] < BUNDLE_CACHE_SECONDS:
        return cached[1]

    loop = await get_loop_for_report(report_id)
    settings = await load_settings(report)
    if project is None:
        project_id = _as_id(report.get("project_id"))
        project = (
            await async_directus.get_item("project", project_id) if project_id else None
        ) or {}
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
    bundle = await published_bundle(
        bundle,
        project_id=_as_id(project.get("id")) or _as_id(report.get("project_id")),
        settings=settings,
        project=project,
        host=host,
        admin_base_url=urls.admin_base_url,
    )
    bundle = translated_bundle(bundle, state, settings)
    _cache[cache_key] = (now, bundle)
    if len(_cache) > 512:
        oldest = sorted(_cache.items(), key=lambda item: item[1][0])[: len(_cache) - 256]
        for key, _ in oldest:
            _cache.pop(key, None)
    return bundle


def forget_bundle(report_id: str) -> None:
    for key in (f"{report_id}:host", f"{report_id}:public"):
        _cache.pop(key, None)
