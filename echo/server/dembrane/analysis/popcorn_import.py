"""Import saved popcorn sessions into analysis objects, and hand the scopes over.

Two halves of one migration, in this order per scope:

1. **Claim.** The scope is marked `legacy`, which fences the executor: a run
   requested for it is refused and a queued one fails at its claim. A scope that
   already has a ready run is left alone, because the executor owns it already.
2. **Import.** The session's phrases, tensions and stakeholders become published
   revisions of the scope they belong to, with legacy provenance and no model
   call. Ids are `uuid5` of the import key, so a second run writes nothing.
3. **Transfer.** The popcorn run lock is drained, the scope is marked
   `analysis` and its fence is bumped, so this importer is refused from then on
   and the executor may publish. `transfer_to_legacy` reverses it.

What is imported, and what is not:

- Phrases go to `popcorn@conversation:<id>` under the same lineage key the
  popcorn recipe emits, so a later run of that recipe is a new revision of the
  same object rather than a second object for the same phrase.
- Stakeholders go to `stakeholders@project` under the recipe's lineage key
  (the room's name for the group), with their saved relations, quotes and
  aspects. A slide's `s1` is a position in a list and is never an identity.
- Tensions go to `tensions@project` under a lineage of their own poles. They
  get no argument relationships, because the session never recorded which
  arguments hold each pole, and none is invented: they are marked legacy and
  the tensions recipe can regenerate them over saved arguments.
- No model call and no producer run: an import writes revisions, and a scope
  reaches the Map only once it has a ready run. `--place` publishes each
  imported conversation through the popcorn recipe, which reads the saved
  phrases and embeds them without asking a language model. Tensions and
  stakeholders have no such path, because their recipes do call one, so they
  stay off the Map until someone runs them.

Run inside the dev container:

    uv run python -m dembrane.analysis.popcorn_import [--project <id>] [--dry-run] [--no-transfer]
"""

from __future__ import annotations

import sys
import json
import uuid
import asyncio
import logging
import argparse
from typing import Any, Mapping, Callable, Protocol, Awaitable
from dataclasses import field, asdict, dataclass

from dembrane.analysis import db
from dembrane.map.recipe import sha256_hex
from dembrane.popcorn.analysis import norm
from dembrane.analysis.contracts import (
    Writer,
    RunStatus,
    ScopeKind,
    SourceRef,
    AnalysisStore,
    RelationBasis,
    AnalysisStoreError,
    ReferenceViolation,
    AnalysisValidationError,
)
from dembrane.analysis.revisions import RevisionService
from dembrane.analysis.recipes.popcorn import (
    RECIPE_ID as POPCORN_RECIPE_ID,
    phrase_key,
    scope_key_for,
)
from dembrane.analysis.recipes.stakeholders import (
    RECIPE_ID as STAKEHOLDERS_RECIPE_ID,
    lineage_key as stakeholder_lineage_key,
)

logger = logging.getLogger("dembrane.analysis.popcorn_import")

# Fixed forever: every id this importer mints is a uuid5 name in this namespace.
POPCORN_NAMESPACE = uuid.UUID("2f8d0f1c-6a45-5d7e-9b3c-0e1a7d6c4b52")
TENSIONS_RECIPE_ID = "tensions"
PROJECT_SCOPE = "project"

LEGACY_POPCORN = "popcorn.legacy_phrases"
LEGACY_TENSIONS = "popcorn.legacy_tensions"
LEGACY_STAKEHOLDERS = "popcorn.legacy_stakeholders"
# How a legacy tension can become one with evidenced poles again.
REGENERATE_TENSIONS = "tensions"

# How long a transfer waits for a running tick to finish before it gives up.
DRAIN_SECONDS = 180
DRAIN_POLL_SECONDS = 2.0


class TransferBusy(RuntimeError):
    """A tick is still running for this session; the scope was not transferred."""


# ── writer ownership ────────────────────────────────────────────────────


@dataclass(frozen=True)
class WriterTransfer:
    """One scope's writer, before and after. `changed` is false when the scope
    already had that writer, which makes a repeated transfer harmless."""

    project_id: str
    recipe_id: str
    scope_key: str
    scope_id: str
    previous: str
    writer: str
    fence: int
    changed: bool

    def as_json(self) -> dict[str, Any]:
        return asdict(self)


class WriterStore(Protocol):
    """The one write this package makes outside the lifecycle store: a scope's
    writer and its fence, which every lease check compares against."""

    async def set_writer(self, scope_id: str, writer: Writer) -> tuple[Writer, int]: ...


class SqlWriterStore:
    def __init__(self, dsn: str | None = None) -> None:
        self._dsn = dsn

    async def set_writer(self, scope_id: str, writer: Writer) -> tuple[Writer, int]:
        """Set the writer and bump the fence in one statement. A scope already
        written by `writer` keeps its fence, so repeating a transfer is a no-op
        rather than a fence bump that would fail a healthy run."""
        async with db.transaction(self._dsn, AnalysisStoreError) as cursor:
            await cursor.execute(
                """UPDATE analysis_scope
                      SET writer = %s, writer_fence = writer_fence + 1, updated_at = now()
                    WHERE id = %s AND writer <> %s
                RETURNING writer, writer_fence""",
                (str(writer), scope_id, str(writer)),
            )
            row = await cursor.fetchone()
            if row is not None:
                return Writer(row["writer"]), int(row["writer_fence"])
            await cursor.execute(
                "SELECT writer, writer_fence FROM analysis_scope WHERE id = %s", (scope_id,)
            )
            current = await cursor.fetchone()
        if current is None:
            raise AnalysisStoreError(f"scope {scope_id} does not exist")
        return Writer(current["writer"]), int(current["writer_fence"])


async def _transfer(
    *,
    project_id: str,
    recipe_id: str,
    scope_key: str,
    writer: Writer,
    store: AnalysisStore,
    writers: WriterStore,
) -> WriterTransfer:
    scope = await store.ensure_scope(
        project_id=project_id, kind=ScopeKind.PRODUCER, owner_id=recipe_id, scope_key=scope_key
    )
    if scope.writer == writer:
        return WriterTransfer(
            project_id=project_id,
            recipe_id=recipe_id,
            scope_key=scope_key,
            scope_id=scope.id,
            previous=str(scope.writer),
            writer=str(writer),
            fence=scope.writer_fence,
            changed=False,
        )
    current, fence = await writers.set_writer(scope.id, writer)
    transfer = WriterTransfer(
        project_id=project_id,
        recipe_id=recipe_id,
        scope_key=scope_key,
        scope_id=scope.id,
        previous=str(scope.writer),
        writer=str(current),
        fence=fence,
        changed=True,
    )
    logger.info(
        "analysis scope %s (%s %s, project %s) transferred from %s to %s at fence %d",
        transfer.scope_id,
        recipe_id,
        scope_key,
        project_id,
        transfer.previous,
        transfer.writer,
        transfer.fence,
    )
    return transfer


async def claim_legacy(
    *,
    project_id: str,
    recipe_id: str,
    scope_key: str,
    store: AnalysisStore,
    writers: WriterStore,
) -> WriterTransfer | None:
    """Fence the executor off a scope so this importer can write it. None when
    the scope already has a ready run: the executor owns it, and an import
    would be a second writer of the same objects."""
    scope = await store.ensure_scope(
        project_id=project_id, kind=ScopeKind.PRODUCER, owner_id=recipe_id, scope_key=scope_key
    )
    if scope.current_run_id is not None:
        return None
    return await _transfer(
        project_id=project_id,
        recipe_id=recipe_id,
        scope_key=scope_key,
        writer=Writer.LEGACY,
        store=store,
        writers=writers,
    )


async def transfer_to_analysis(
    *,
    project_id: str,
    recipe_id: str,
    scope_key: str,
    store: AnalysisStore,
    writers: WriterStore,
    drain: Callable[[], Awaitable[bool]] | None = None,
) -> WriterTransfer:
    """Hand a scope to the executor. `drain` waits for the legacy writer to be
    idle and answers whether it is; a tick still running refuses the transfer,
    so the two writers never overlap."""
    if drain is not None and not await drain():
        raise TransferBusy(
            f"a popcorn tick is still running for project {project_id}; {recipe_id}@{scope_key} was not transferred"
        )
    return await _transfer(
        project_id=project_id,
        recipe_id=recipe_id,
        scope_key=scope_key,
        writer=Writer.ANALYSIS,
        store=store,
        writers=writers,
    )


async def transfer_to_legacy(
    *,
    project_id: str,
    recipe_id: str,
    scope_key: str,
    store: AnalysisStore,
    writers: WriterStore,
) -> WriterTransfer:
    """The reverse: the executor is fenced off and the legacy writer owns the
    scope again. Published objects and runs are kept; nothing is deleted."""
    return await _transfer(
        project_id=project_id,
        recipe_id=recipe_id,
        scope_key=scope_key,
        writer=Writer.LEGACY,
        store=store,
        writers=writers,
    )


async def analysis_owns(
    project_id: str, recipe_id: str, scope_key: str, *, store: AnalysisStore
) -> bool:
    """Whether the executor may write this scope. The tick asks before it
    publishes, so a scope being imported is never written by both.

    A scope that does not exist yet is the executor's: that is the writer a new
    scope is created with, and a session with nothing to import has no legacy
    writer to wait for. So import an existing session before the tick starts
    publishing it, or take the scope back with `transfer_to_legacy` first."""
    scope = await store.find_scope(
        project_id=project_id, kind=ScopeKind.PRODUCER, owner_id=recipe_id, scope_key=scope_key
    )
    return scope is None or scope.writer == Writer.ANALYSIS


def popcorn_run_lock_drain(
    loop_id: str, *, seconds: int = DRAIN_SECONDS
) -> Callable[[], Awaitable[bool]]:
    """Wait for the tick's own run lock to be free, which is what serialises
    ticks for a session. True once it is, false when it never was."""

    async def drain() -> bool:
        from dembrane.redis_async import get_redis_client

        client = await get_redis_client()
        for _ in range(max(1, int(seconds / DRAIN_POLL_SECONDS))):
            if not await client.exists(f"popcorn:run:{loop_id}"):
                return True
            await asyncio.sleep(DRAIN_POLL_SECONDS)
        return not await client.exists(f"popcorn:run:{loop_id}")

    return drain


# ── the import ──────────────────────────────────────────────────────────


@dataclass
class ImportReport:
    sessions: int = 0
    conversations: int = 0
    phrases: int = 0
    tensions: int = 0
    stakeholders: int = 0
    relations: int = 0
    revisions_written: int = 0
    revisions_already_present: int = 0
    scopes_claimed: int = 0
    scopes_transferred: int = 0
    scopes_owned_by_analysis: int = 0
    # Objects an earlier import created under an id minted from the lineage
    # alone; they keep that id, and only new objects get the scoped one.
    objects_under_earlier_ids: int = 0
    quotes_missing: int = 0
    transfers: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def _uuid5(name: str) -> str:
    return str(uuid.uuid5(POPCORN_NAMESPACE, name))


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value else None


def quote_registry(state: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(q["id"]): dict(q)
        for q in state.get("quotes") or []
        if isinstance(q, dict) and q.get("id") and q.get("text")
    }


def _quote_refs(
    quote_ids: Any, quotes: Mapping[str, Mapping[str, Any]], report: ImportReport
) -> list[dict[str, Any]]:
    refs = []
    for quote_id in quote_ids or []:
        quote = quotes.get(str(quote_id))
        if quote is None:
            report.quotes_missing += 1
            continue
        refs.append(
            {"text": str(quote["text"]), "conversationId": str(quote.get("transcript") or "")}
        )
    return [ref for ref in refs if ref["conversationId"]]


def _source_refs(refs: list[dict[str, Any]]) -> list[SourceRef]:
    # No source fingerprint: the session kept the quote, never the transcript
    # it was checked against, and today's text is not substituted for it.
    return [SourceRef(conversation_id=ref["conversationId"], quote=ref["text"]) for ref in refs]


def popcorn_lineage_key(conversation_id: str, phrase: str) -> str:
    """Exactly the lineage key the popcorn recipe emits for this phrase, so the
    import and the recipe are the same object."""
    return f"{POPCORN_RECIPE_ID}/{scope_key_for(conversation_id)}/{conversation_id}:{phrase_key(phrase)}"


def poles_hash(pole_a: str, pole_b: str) -> str:
    return sha256_hex(norm(pole_a) + "\x1e" + norm(pole_b))[:40]


def tension_lineage_key(pole_a: str, pole_b: str) -> str:
    """A legacy tension's identity: its own poles. The tensions recipe keys a
    tension by the arguments holding each pole, which a saved session never
    recorded, so an imported tension keeps a lineage of its own."""
    return f"{TENSIONS_RECIPE_ID}/{PROJECT_SCOPE}/legacy:{poles_hash(pole_a, pole_b)}"


def stakeholder_lineage(name: str) -> str:
    return f"{STAKEHOLDERS_RECIPE_ID}/{PROJECT_SCOPE}/{stakeholder_lineage_key(name)}"


def object_id_for(project_id: str, lineage: str) -> str:
    """A new imported object's id: deterministic, and named after its project
    as well as its lineage. A lineage key carries its producer scope, but a
    scope key of `project` is the same string in every project, so the name
    alone would give one group in two projects one row."""
    return _uuid5(f"object:{project_id}:{lineage}")


async def _import_one(
    revisions: RevisionService,
    *,
    project_id: str,
    type_id: str,
    lineage: str,
    payload: dict[str, Any],
    import_key: str,
    scope_id: str,
    recipe_id: str,
    recipe_version: str,
    refs: list[dict[str, Any]],
    extra: dict[str, Any],
    report: ImportReport,
) -> Any:
    fixed = _uuid5(import_key)
    known = await revisions.store.get_revisions(project_id, [fixed])
    fields: dict[str, Any] = {
        "project_id": project_id,
        "type_id": type_id,
        "lineage_key": lineage,
        "payload": payload,
        "import_key": import_key,
        "scope_id": scope_id,
        "source_refs": _source_refs(refs),
        "recipe_id": recipe_id,
        "recipe_version": recipe_version,
        "revision_id": fixed,
        "extra": extra,
    }
    try:
        revision = await revisions.import_revision(
            **fields, object_id=object_id_for(project_id, lineage)
        )
    except ReferenceViolation:
        # An earlier import minted this object's id from its lineage alone, so
        # the same group name in two projects wanted one row. A row keeps the
        # id it has; only an object written from here on gets the scoped one.
        report.objects_under_earlier_ids += 1
        revision = await revisions.import_revision(**fields)
    if fixed in known or revision.id != fixed:
        report.revisions_already_present += 1
    else:
        report.revisions_written += 1
    return revision


async def _already_imported(store: AnalysisStore, project_id: str, import_keys: list[str]) -> bool:
    """Whether every revision these keys mint is already in the store. A repeat
    import then writes nothing and moves no fence, so it can never fence a
    healthy run out of a scope an earlier run handed over."""
    if not import_keys:
        return False
    ids = sorted({_uuid5(key) for key in import_keys})
    found = await store.get_revisions(project_id, ids)
    return len(found) == len(ids)


async def import_session(
    loop: Mapping[str, Any],
    *,
    store: AnalysisStore,
    writers: WriterStore,
    report: ImportReport,
    transfer: bool = True,
    drain: Callable[[], Awaitable[bool]] | None = None,
) -> None:
    """Import one popcorn session and hand its scopes to the executor."""
    from dembrane.popcorn.service import normalize_state

    project_id = _as_id(loop.get("project_id"))
    loop_id = _as_id(loop.get("id"))
    if not project_id or not loop_id:
        return
    state = normalize_state(loop.get("popcorn_state"))
    version = f"state-v{state.get('version')}"
    run = int(state.get("run") or 0)
    quotes = quote_registry(state)
    revisions = RevisionService(store)
    report.sessions += 1

    async def claim(recipe_id: str, scope_key: str) -> str | None:
        claimed = await claim_legacy(
            project_id=project_id,
            recipe_id=recipe_id,
            scope_key=scope_key,
            store=store,
            writers=writers,
        )
        if claimed is None:
            report.scopes_owned_by_analysis += 1
            report.skipped.append(f"{recipe_id}@{scope_key}: the executor already published it")
            return None
        if claimed.changed:
            report.scopes_claimed += 1
            report.transfers.append(claimed.as_json())
        return claimed.scope_id

    async def hand_over(recipe_id: str, scope_key: str) -> None:
        if not transfer:
            return
        handed = await transfer_to_analysis(
            project_id=project_id,
            recipe_id=recipe_id,
            scope_key=scope_key,
            store=store,
            writers=writers,
            drain=drain,
        )
        if handed.changed:
            report.scopes_transferred += 1
            report.transfers.append(handed.as_json())

    # phrases, one scope per conversation
    for conversation_id, entry in sorted((state.get("conversations") or {}).items()):
        phrases: list[tuple[str, str, dict[str, Any]]] = []
        seen: set[str] = set()
        for item in entry.get("items") or []:
            if not isinstance(item, dict):
                continue
            phrase = " ".join(str(item.get("phrase") or "").split())
            key = phrase_key(phrase)
            if not phrase or key in seen:
                continue
            seen.add(key)
            phrases.append((phrase, key, item))
        if not phrases:
            continue
        scope_key = scope_key_for(conversation_id)
        import_keys = [f"popcorn:{loop_id}:{conversation_id}:{key}" for _p, key, _i in phrases]
        if await _already_imported(store, project_id, import_keys):
            report.revisions_already_present += len(import_keys)
            await hand_over(POPCORN_RECIPE_ID, scope_key)
            continue
        scope_id = await claim(POPCORN_RECIPE_ID, scope_key)
        if scope_id is None:
            continue
        report.conversations += 1
        for phrase, key, item in phrases:
            refs = _quote_refs([item.get("quoteId")] if item.get("quoteId") else [], quotes, report)
            await _import_one(
                revisions,
                project_id=project_id,
                type_id="popcorn",
                lineage=popcorn_lineage_key(conversation_id, phrase),
                payload={
                    "phrase": phrase,
                    "question": bool(item.get("question")),
                    "evidence": [
                        {
                            "conversationId": conversation_id,
                            "label": str(entry.get("label") or "") or None,
                            "createdAt": str(entry.get("created_at") or "") or None,
                            "quotes": [ref["text"] for ref in refs],
                        }
                    ],
                },
                import_key=f"popcorn:{loop_id}:{conversation_id}:{key}",
                scope_id=scope_id,
                recipe_id=LEGACY_POPCORN,
                recipe_version=version,
                refs=refs,
                extra={
                    "legacy": True,
                    "legacyLoopId": loop_id,
                    "legacyRun": run,
                    "legacyPhraseId": str(item.get("id") or ""),
                    "legacyQuoteId": str(item.get("quoteId") or "") or None,
                    "kind": str(item.get("kind") or "") or None,
                    "qualifiers": [str(q) for q in item.get("qualifiers") or []],
                    "verbatim": bool(item.get("verbatim")),
                },
                report=report,
            )
            report.phrases += 1
        await hand_over(POPCORN_RECIPE_ID, scope_key)

    analysis = state.get("analysis") or {}

    # tensions, without a single invented argument relationship
    saved_tensions = [
        t for t in ((analysis.get("tensions") or {}).get("tensions") or []) if isinstance(t, dict)
    ]
    writable: list[tuple[dict[str, Any], str, str, str]] = []
    for tension in saved_tensions:
        knot = str(tension.get("knot") or tension.get("narrative") or "")
        pole_a, pole_b = str(tension.get("poleA") or ""), str(tension.get("poleB") or "")
        if pole_a and pole_b and knot and tension.get("toResolve"):
            writable.append((tension, knot, pole_a, pole_b))
    if writable:
        tension_keys = [f"tension:{loop_id}:{poles_hash(a, b)}" for _t, _k, a, b in writable]
        scope_id = None
        if await _already_imported(store, project_id, tension_keys):
            report.revisions_already_present += len(tension_keys)
            await hand_over(TENSIONS_RECIPE_ID, PROJECT_SCOPE)
        else:
            scope_id = await claim(TENSIONS_RECIPE_ID, PROJECT_SCOPE)
        if scope_id is not None:
            for tension, knot, pole_a, pole_b in writable:
                refs = _quote_refs(tension.get("quoteIds"), quotes, report)
                await _import_one(
                    revisions,
                    project_id=project_id,
                    type_id="tension",
                    lineage=tension_lineage_key(pole_a, pole_b),
                    payload={
                        "poleA": pole_a,
                        "poleB": pole_b,
                        "knot": knot,
                        "toResolve": str(tension["toResolve"]),
                        "quotes": refs,
                    },
                    import_key=f"tension:{loop_id}:{poles_hash(pole_a, pole_b)}",
                    scope_id=scope_id,
                    recipe_id=LEGACY_TENSIONS,
                    recipe_version=version,
                    refs=refs,
                    extra={
                        "legacy": True,
                        "legacyLoopId": loop_id,
                        "legacyRun": run,
                        "legacySlideId": str(tension.get("id") or ""),
                        # The session never recorded which arguments hold each
                        # pole, so this tension has none and none is invented.
                        "argumentRelations": "none_recorded",
                        "regenerate": REGENERATE_TENSIONS,
                    },
                    report=report,
                )
                report.tensions += 1
            await hand_over(TENSIONS_RECIPE_ID, PROJECT_SCOPE)

    # stakeholders, with the relations the session did record
    saved = analysis.get("stakeholders") or {}
    people = [s for s in (saved.get("stakeholders") or []) if isinstance(s, dict) and s.get("name")]
    if not people:
        return
    people_keys = [f"stakeholder:{loop_id}:{sha256_hex(norm(str(p['name'])))[:40]}" for p in people]
    if await _already_imported(store, project_id, people_keys):
        report.revisions_already_present += len(people_keys)
        await hand_over(STAKEHOLDERS_RECIPE_ID, PROJECT_SCOPE)
        return
    scope_id = await claim(STAKEHOLDERS_RECIPE_ID, PROJECT_SCOPE)
    if scope_id is None:
        return
    emitted: dict[str, Any] = {}
    for person in people:
        name = str(person["name"]).strip()
        evidence = person.get("evidence") or {}
        weight = person.get("weight") or {}
        refs = _quote_refs(person.get("quoteIds"), quotes, report)
        try:
            revision = await _import_one(
                revisions,
                project_id=project_id,
                type_id="stakeholder",
                lineage=stakeholder_lineage(name),
                payload={
                    "name": name,
                    "role": str(person.get("role") or ""),
                    "stake": str(person.get("stake") or ""),
                    "rung": str(evidence.get("rung") or "named"),
                    **(
                        {"invokedBy": str(evidence["invokedBy"])}
                        if evidence.get("invokedBy")
                        else {}
                    ),
                    "weight": {
                        "stake": float(weight.get("stake") or 0.0),
                        "mentions": float(weight.get("mentions") or 0.0),
                    },
                    "quotes": refs,
                },
                import_key=f"stakeholder:{loop_id}:{sha256_hex(norm(name))[:40]}",
                scope_id=scope_id,
                recipe_id=LEGACY_STAKEHOLDERS,
                recipe_version=version,
                refs=refs,
                extra={
                    "legacy": True,
                    "legacyLoopId": loop_id,
                    "legacyRun": run,
                    "legacySlideId": str(person.get("id") or ""),
                },
                report=report,
            )
        except AnalysisValidationError as exc:
            report.skipped.append(f"stakeholder {name!r}: {exc}")
            continue
        emitted[str(person.get("id") or "")] = revision
        report.stakeholders += 1

    for relation in saved.get("relations") or []:
        if not isinstance(relation, dict):
            continue
        ends = [emitted.get(str(end)) for end in relation.get("between") or []]
        if len(ends) != 2 or ends[0] is None or ends[1] is None or ends[0].id == ends[1].id:
            continue
        aspects = []
        quote_ids: list[str] = []
        for aspect in relation.get("aspects") or []:
            if not isinstance(aspect, dict):
                continue
            aspect_refs = _quote_refs(aspect.get("quoteIds"), quotes, report)
            quote_ids += [str(q) for q in aspect.get("quoteIds") or []]
            aspects.append(
                {
                    "kind": str(aspect.get("kind") or "power"),
                    "note": str(aspect.get("note") or ""),
                    "quotes": aspect_refs,
                }
            )
        try:
            await revisions.import_relation(
                project_id=project_id,
                type_id="stakeholder_relation",
                from_revision_id=ends[0].id,
                to_revision_id=ends[1].id,
                basis=RelationBasis.EXTRACTED,
                import_key=f"stakeholder_relation:{loop_id}:{ends[0].id}:{ends[1].id}",
                attributes={
                    "label": str(relation.get("label") or ""),
                    "intensity": float(relation.get("intensity") or 0.0),
                    "sentiment": float(relation.get("sentiment") or 0.0),
                    "unowned": bool(relation.get("unowned")),
                    "detail": str(relation.get("detail") or ""),
                    "aspects": aspects,
                },
                source_refs=_source_refs(_quote_refs(quote_ids, quotes, report)),
                recipe_id=LEGACY_STAKEHOLDERS,
                recipe_version=version,
                relation_id=_uuid5(f"stakeholder_relation:{loop_id}:{ends[0].id}:{ends[1].id}"),
                extra={
                    "legacy": True,
                    "legacyLoopId": loop_id,
                    "legacySlideId": str(relation.get("id") or ""),
                },
            )
        except AnalysisValidationError as exc:
            report.skipped.append(f"stakeholder relation {relation.get('id')}: {exc}")
            continue
        report.relations += 1
    await hand_over(STAKEHOLDERS_RECIPE_ID, PROJECT_SCOPE)


# ── vectors for what was imported ───────────────────────────────────────


@dataclass
class PlacementReport:
    """What reached the Map. An imported object is not on it until its scope
    has a ready run, so this publishes one from the session's saved phrases."""

    sessions: int = 0
    conversations: int = 0
    objects: int = 0
    by_session: dict[str, dict[str, int]] = field(default_factory=dict)
    failed: list[str] = field(default_factory=list)


class _SavedPhrases:
    """The popcorn recipe's source for one saved session: its phrases as the
    state holds them, beside the transcript each was read from."""

    def __init__(self, conversations: Mapping[str, Any]) -> None:
        self.conversations = dict(conversations)

    async def conversation(self, project_id: str, conversation_id: str) -> Any:  # noqa: ARG002
        return self.conversations.get(conversation_id)


async def saved_phrases(loop: Mapping[str, Any]) -> dict[str, Any]:
    """One session's conversations as `ConversationPhrases`, read once."""
    from dembrane.popcorn.model import POPCORN_PROMPT, VALIDATE_PROMPT
    from dembrane.popcorn.ticks import gather_transcripts
    from dembrane.popcorn.service import (
        normalize_state,
        voice_host_note,
        get_latest_config,
        normalize_settings,
    )
    from dembrane.analysis.recipes.popcorn import ConversationPhrases, phrase_records

    project_id = _as_id(loop.get("project_id")) or ""
    report_id = _as_id(loop.get("report_id"))
    state = normalize_state(loop.get("popcorn_state"))
    quotes = quote_registry(state)
    settings = normalize_settings(
        ((await get_latest_config(report_id)) or {}).get("popcorn_settings") if report_id else None,
        fallback_title=str(loop.get("name") or "Popcorn"),
    )
    transcripts = {
        str(t["id"]): t
        for t in await gather_transcripts(
            project_id=project_id,
            acting_directus_user_id=str(loop.get("acting_directus_user_id") or ""),
        )
    }
    out: dict[str, Any] = {}
    for conversation_id, entry in (state.get("conversations") or {}).items():
        transcript = transcripts.get(conversation_id)
        phrases = phrase_records(entry.get("items"), quotes) if transcript else []
        if not phrases or transcript is None:
            continue
        out[conversation_id] = ConversationPhrases(
            conversation_id=conversation_id,
            text=str(transcript["text"]),
            phrases=tuple(phrases),
            label=str(entry.get("label") or "") or None,
            created_at=str(entry.get("created_at") or "") or None,
            voice=voice_host_note(settings.get("voice")),
            prompts={"extract": POPCORN_PROMPT, "validate": VALIDATE_PROMPT},
        )
    return out


async def place_session(
    loop: Mapping[str, Any], *, store: AnalysisStore, report: PlacementReport
) -> None:
    """Publish each imported conversation through the popcorn recipe, so its
    phrases carry a vector and the Map can place them. The recipe reads the
    saved phrases and calls no language model, only the embedding service."""
    from dembrane.analysis.executor import RunRequest, default_deps, execute_inline
    from dembrane.analysis.recipes.popcorn import RECIPE_ID, SOURCES_KEY

    project_id = _as_id(loop.get("project_id"))
    loop_id = _as_id(loop.get("id"))
    if not project_id or not loop_id:
        return
    sources = await saved_phrases(loop)
    if not sources:
        return
    report.sessions += 1
    counts = {"conversations": 0, "objects": 0}
    for conversation_id, source in sorted(sources.items()):
        scope_key = scope_key_for(conversation_id)
        if not await analysis_owns(project_id, RECIPE_ID, scope_key, store=store):
            report.failed.append(f"{scope_key}: the legacy writer still owns it")
            continue
        try:
            outcome = await execute_inline(
                RunRequest(project_id=project_id, recipe_id=RECIPE_ID, scope_key=scope_key),
                store=store,
                deps=default_deps({SOURCES_KEY: _SavedPhrases({conversation_id: source})}),
            )
        except Exception as exc:  # noqa: BLE001
            report.failed.append(f"{scope_key}: {type(exc).__name__}: {exc}")
            continue
        run = outcome.run
        if run.status != RunStatus.READY:
            report.failed.append(f"{scope_key}: {run.status} {run.error or ''}".strip())
            continue
        placed = len((run.output_manifest or {}).get("objects") or [])
        counts["conversations"] += 1
        counts["objects"] += placed
        report.conversations += 1
        report.objects += placed
    report.by_session[loop_id] = counts


async def run_placement(
    *,
    store: AnalysisStore,
    project_id: str | None = None,
    loops: list[dict[str, Any]] | None = None,
) -> PlacementReport:
    report = PlacementReport()
    for loop in loops if loops is not None else await popcorn_loops(project_id):
        try:
            await place_session(loop, store=store, report=report)
        except Exception as exc:  # noqa: BLE001
            # A session whose transcripts cannot be read must not cost the
            # other sessions their vectors.
            session = _as_id(loop.get("id"))
            report.failed.append(f"session {session}: {type(exc).__name__}: {exc}")
    return report


async def popcorn_loops(project_id: str | None = None) -> list[dict[str, Any]]:
    from dembrane.directus_async import async_directus
    from dembrane.popcorn.service import is_popcorn_loop

    query: dict[str, Any] = {
        "fields": [
            "id",
            "project_id",
            "report_id",
            "name",
            "status",
            "caps",
            # Reading a session's transcripts is the tick's own read, made as
            # the host it runs for, so the placement pass needs this too.
            "acting_directus_user_id",
            "popcorn_state",
        ],
        "sort": ["created_at"],
        "limit": -1,
    }
    if project_id:
        query["filter"] = {"project_id": {"_eq": project_id}}
    rows = await async_directus.get_items("agent_loop", {"query": query})
    return [row for row in (rows or []) if isinstance(row, dict) and is_popcorn_loop(row)]


async def run_import(
    *,
    store: AnalysisStore,
    writers: WriterStore,
    project_id: str | None = None,
    dry_run: bool = False,
    transfer: bool = True,
    loops: list[dict[str, Any]] | None = None,
) -> ImportReport:
    report = ImportReport()
    for loop in loops if loops is not None else await popcorn_loops(project_id):
        if dry_run:
            state = loop.get("popcorn_state") or {}
            conversations = (state.get("conversations") or {}) if isinstance(state, dict) else {}
            report.sessions += 1
            report.conversations += sum(1 for c in conversations.values() if (c or {}).get("items"))
            continue
        drain = popcorn_run_lock_drain(str(loop["id"])) if transfer else None
        await import_session(
            loop, store=store, writers=writers, report=report, transfer=transfer, drain=drain
        )
    return report


async def _main(argv: list[str]) -> int:
    from dembrane.analysis.store import SqlAnalysisStore

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", default=None, help="only this project's sessions")
    parser.add_argument("--dry-run", action="store_true", help="count what would be imported")
    parser.add_argument(
        "--no-transfer",
        action="store_true",
        help="import but leave the scopes with the legacy writer",
    )
    parser.add_argument(
        "--place",
        action="store_true",
        help="after importing, publish each conversation's phrases so the Map can place them",
    )
    args = parser.parse_args(argv)
    store = SqlAnalysisStore()
    report = await run_import(
        store=store,
        writers=SqlWriterStore(),
        project_id=args.project,
        dry_run=args.dry_run,
        transfer=not args.no_transfer,
    )
    out: dict[str, Any] = {"import": asdict(report)}
    if args.place and not args.dry_run:
        out["placement"] = asdict(await run_placement(store=store, project_id=args.project))
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sys.exit(asyncio.run(_main(sys.argv[1:])))
