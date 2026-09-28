"""View snapshots: the one immutable manifest every rendered or shared view reads.

Assembly resolves each requested producer's current ready output once, keeps
exactly one displayed revision per object identity, keeps a relation only when
both of its endpoints are displayed revisions of this snapshot, pins the latest
assessment of each displayed fact-checkable revision, and records what is stale:
a relation or an output that was established against an older revision than the
one displayed. A stale support edge is listed, never redrawn to newer text.

The view's current snapshot is captured before assembly and is the expected
previous snapshot, so an older assembly never overwrites a newer view: on a
conflict the caller reassembles from scratch. Identical content returns the
current snapshot instead of a new one, and a snapshot assembled for an outbox
event records that event, so a repeated dispatch finds it.

Reading an existing snapshot (`read_snapshot`) loads exactly the revisions,
relations and assessments it pins, never the latest ones.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Callable, Awaitable
from dataclasses import field, replace, dataclass

from dembrane.analysis import types
from dembrane.analysis.hashing import HASH_VERSION, content_hash
from dembrane.analysis.contracts import (
    Origin,
    Relation,
    Snapshot,
    ScopeKind,
    NewSnapshot,
    OutboxEvent,
    AnalysisStore,
    ObjectRevision,
    SnapshotConflict,
)

logger = logging.getLogger("dembrane.analysis.snapshots")

SNAPSHOT_MANIFEST_VERSION = 1
CONFLICT_RETRIES = 3


@dataclass(frozen=True)
class ProducerRef:
    recipe_id: str
    scope_key: str


@dataclass(frozen=True)
class SnapshotRequest:
    project_id: str
    view_id: str
    scope_key: str
    producers: tuple[ProducerRef, ...]
    settings: Mapping[str, Any] = field(default_factory=dict)
    versions: Mapping[str, Any] = field(default_factory=dict)
    embedding_config: Mapping[str, Any] | None = None
    created_by: str | None = None
    # The outbox event this assembly answers, recorded as its durable effect.
    source_event_id: str | None = None


@dataclass(frozen=True)
class SnapshotContents:
    """A snapshot with exactly the rows it pins."""

    snapshot: Snapshot
    revisions: dict[str, ObjectRevision]
    relations: dict[str, Relation]
    assessments: dict[str, ObjectRevision]
    # Pinned ids that no longer resolve (source deletion): shown as missing.
    missing: tuple[str, ...]


class _Current:
    pass


CURRENT = _Current()


async def excluded_object_ids(
    project_id: str,
    *,
    store: AnalysisStore,
    scope_ids: list[str] | None = None,
) -> set[str]:
    """Current durable withdrawals, applied even to pinned audience views."""
    heads = await store.current_revisions(project_id, scope_ids)
    return {
        object_id
        for object_id, revision in heads.items()
        if revision.provenance.extra.get("membershipExcluded")
    }


async def build_manifest(request: SnapshotRequest, *, store: AnalysisStore) -> dict[str, Any]:
    producers: list[dict[str, Any]] = []
    candidates: dict[str, list[dict[str, Any]]] = {}
    relation_entries: dict[str, dict[str, Any]] = {}
    pinned_inputs: list[tuple[dict[str, Any], str]] = []
    producer_scope_ids: list[str] = []
    for ref in request.producers:
        scope = await store.find_scope(
            project_id=request.project_id, kind=ScopeKind.PRODUCER, owner_id=ref.recipe_id, scope_key=ref.scope_key
        )
        run = await store.get_run(scope.current_run_id) if scope and scope.current_run_id else None
        if scope is None or run is None or not run.output_manifest:
            producers.append({"recipeId": ref.recipe_id, "scopeKey": ref.scope_key, "runId": None, "available": False})
            continue
        manifest = run.output_manifest
        entry = {
            "recipeId": ref.recipe_id,
            "scopeKey": ref.scope_key,
            "scopeId": scope.id,
            "runId": run.id,
            "recipeVersion": run.recipe_version,
            "manifestHash": manifest.get("contentHash"),
            "publicationSequence": manifest.get("publicationSequence"),
            "available": True,
        }
        producer_scope_ids.append(scope.id)
        producers.append(entry)
        for obj in manifest.get("objects") or []:
            candidates.setdefault(str(obj["objectId"]), []).append({**obj, "producer": entry})
        for relation in manifest.get("relations") or []:
            relation_entries[str(relation["relationId"])] = relation
        for rid in (manifest.get("inputs") or {}).get("revisionIds") or []:
            pinned_inputs.append((entry, str(rid)))

    current = await store.current_revisions(request.project_id, producer_scope_ids)
    wanted = {str(o["revisionId"]) for group in candidates.values() for o in group}
    wanted |= {str(r[end]) for r in relation_entries.values() for end in ("from", "to")}
    wanted |= {rid for _entry, rid in pinned_inputs}
    revisions = await store.get_revisions(request.project_id, sorted(wanted))

    displayed: dict[str, ObjectRevision] = {}
    for object_id, group in candidates.items():
        head = current.get(object_id)
        if head is not None and head.provenance.origin == Origin.AUTHORED:
            if not head.provenance.extra.get("membershipExcluded"):
                displayed[object_id] = head
            continue
        options = [revisions[str(o["revisionId"])] for o in group if str(o["revisionId"]) in revisions]
        if options:
            # One displayed revision per identity: the newest.
            displayed[object_id] = max(options, key=lambda r: r.revision_number)
    # An authored head remains a member of its producer scope even when a
    # later whole-scope run no longer emits that identity. Exclusion is an
    # authored, reversible membership revision and is resolved here once.
    for object_id, head in current.items():
        if (
            head.provenance.origin == Origin.AUTHORED
            and not head.provenance.extra.get("membershipExcluded")
            and object_id not in displayed
        ):
            displayed[object_id] = head
    displayed_ids = {r.id for r in displayed.values()}

    relations: list[dict[str, Any]] = []
    stale: list[dict[str, Any]] = []
    historical: list[dict[str, Any]] = []
    for relation_id, relation in sorted(relation_entries.items()):
        ends = [str(relation["from"]), str(relation["to"])]
        if all(end in displayed_ids for end in ends):
            relations.append({"relationId": relation_id, "type": relation["type"], "from": ends[0], "to": ends[1]})
            continue
        newer = [
            (end, displayed[revisions[end].object_id].id)
            for end in ends
            if end in revisions and revisions[end].object_id in displayed and end not in displayed_ids
        ]
        if newer:
            for pinned_id, shown_id in newer:
                stale.append(
                    {
                        "kind": "relation",
                        "relationId": relation_id,
                        "objectId": revisions[pinned_id].object_id,
                        "pinnedRevisionId": pinned_id,
                        "displayedRevisionId": shown_id,
                    }
                )
        else:
            historical.append({"relationId": relation_id, "reason": "endpoint_not_displayed"})

    for entry, rid in pinned_inputs:
        revision = revisions.get(rid)
        if revision is None or revision.object_id not in displayed:
            continue
        shown = displayed[revision.object_id]
        if shown.id != rid:
            stale.append(
                {
                    "kind": "output",
                    "recipeId": entry["recipeId"],
                    "scopeKey": entry["scopeKey"],
                    "runId": entry["runId"],
                    "objectId": revision.object_id,
                    "pinnedRevisionId": rid,
                    "displayedRevisionId": shown.id,
                }
            )

    checkable = [r.id for r in displayed.values() if types.fact_check_eligible(r.type, r.payload, r.attributes)]
    assessments = [
        {
            "targetRevisionId": target,
            "revisionId": assessment.id,
            "relationId": assessment.provenance.extra.get("assessesRelationId"),
        }
        for target, assessment in sorted((await store.assessments_for(request.project_id, checkable)).items())
    ]

    # With an embedding configuration, each displayed map-capable revision is
    # placed by its vector of that configuration, or listed as unplaced.
    config_key = (request.embedding_config or {}).get("key")
    vectors: list[dict[str, Any]] = []
    unplaced: list[str] = []
    if config_key:
        for revision in sorted(displayed.values(), key=lambda r: r.id):
            if types.get_object_type(revision.type).map is None:
                continue
            refs = revision.embedding_refs or {}
            if refs.get("configKey") == config_key and refs.get("embeddingId"):
                vectors.append({"revisionId": revision.id, "embeddingId": refs["embeddingId"]})
            else:
                unplaced.append(revision.id)

    body: dict[str, Any] = {
        "version": SNAPSHOT_MANIFEST_VERSION,
        "hashVersion": HASH_VERSION,
        "view": {"id": request.view_id, "scopeKey": request.scope_key},
        "producers": producers,
        "objects": sorted(
            ({"objectId": r.object_id, "revisionId": r.id, "type": r.type} for r in displayed.values()),
            key=lambda o: o["objectId"],
        ),
        "relations": relations,
        "assessments": assessments,
        "stale": sorted(
            stale, key=lambda s: (s["kind"], s.get("relationId") or s.get("runId") or "", s["pinnedRevisionId"])
        ),
        "historicalRelations": historical,
        "embeddingConfig": dict(request.embedding_config) if request.embedding_config else None,
        "settings": dict(request.settings),
        "versions": dict(request.versions),
    }
    if config_key:
        body["vectors"] = vectors
        body["unplaced"] = unplaced
    return {**body, "contentHash": content_hash(body)}


async def assemble_snapshot(
    request: SnapshotRequest,
    *,
    store: AnalysisStore,
    expected_previous_id: str | None | _Current = CURRENT,
) -> Snapshot:
    """Build and publish a snapshot. The expected previous snapshot is the
    view's current one as read before assembly began. Raises
    `SnapshotConflict` when the view moved past it (reassemble, never resubmit
    this manifest), and `PublicationRejected` when a reference fails."""
    scope = await store.ensure_scope(
        project_id=request.project_id, kind=ScopeKind.VIEW, owner_id=request.view_id, scope_key=request.scope_key
    )
    expected = scope.current_snapshot_id if isinstance(expected_previous_id, _Current) else expected_previous_id
    manifest = await build_manifest(request, store=store)
    # Identical content returns the current snapshot, decided by the store
    # under the view lock once the expected previous snapshot is confirmed.
    # The manifest owns every setting and version it pins; the columns repeat
    # them for queries, never with different values.
    return await store.publish_snapshot(
        NewSnapshot(
            project_id=request.project_id,
            scope_id=scope.id,
            view_id=request.view_id,
            manifest=manifest,
            content_hash=manifest["contentHash"],
            manifest_version=SNAPSHOT_MANIFEST_VERSION,
            settings=dict(request.settings),
            versions=dict(request.versions),
            embedding_config=dict(request.embedding_config) if request.embedding_config else None,
            created_by=request.created_by,
            source_event_id=request.source_event_id,
        ),
        expected_previous_id=expected,
    )


async def resolve_snapshot(
    *,
    store: AnalysisStore,
    project_id: str,
    snapshot_id: str | None = None,
    view_id: str | None = None,
    scope_key: str | None = None,
) -> Snapshot | None:
    """A pinned snapshot by id, or a view's current snapshot. None when it is
    not this project's."""
    if snapshot_id:
        snapshot = await store.get_snapshot(snapshot_id)
        return snapshot if snapshot and snapshot.project_id == project_id else None
    if not (view_id and scope_key):
        return None
    scope = await store.find_scope(project_id=project_id, kind=ScopeKind.VIEW, owner_id=view_id, scope_key=scope_key)
    if scope is None or not scope.current_snapshot_id:
        return None
    return await store.get_snapshot(scope.current_snapshot_id)


async def read_snapshot(snapshot: Snapshot, *, store: AnalysisStore) -> SnapshotContents:
    """Exactly what a snapshot pins: its displayed revisions, its relations and
    its assessments by id, whatever has been published since."""
    manifest = snapshot.manifest
    revision_ids = [str(o["revisionId"]) for o in manifest.get("objects") or []]
    assessment_ids = [str(a["revisionId"]) for a in manifest.get("assessments") or []]
    relation_ids = [str(r["relationId"]) for r in manifest.get("relations") or []]
    relation_ids += [str(a["relationId"]) for a in manifest.get("assessments") or [] if a.get("relationId")]
    revisions = await store.get_revisions(snapshot.project_id, [*revision_ids, *assessment_ids])
    relations = await store.get_relations(snapshot.project_id, relation_ids)
    assessments = {
        str(a["targetRevisionId"]): revisions[str(a["revisionId"])]
        for a in manifest.get("assessments") or []
        if str(a["revisionId"]) in revisions
    }
    missing = tuple(
        sorted({*[i for i in [*revision_ids, *assessment_ids] if i not in revisions], *[i for i in relation_ids if i not in relations]})
    )
    return SnapshotContents(
        snapshot=snapshot,
        revisions={rid: revisions[rid] for rid in revision_ids if rid in revisions},
        relations={rid: relations[rid] for rid in relation_ids if rid in relations},
        assessments=assessments,
        missing=missing,
    )


def following_view_hook(
    *,
    recipe_ids: frozenset[str],
    build_request: Callable[[OutboxEvent], SnapshotRequest | None],
) -> Callable[[OutboxEvent, AnalysisStore], Awaitable[None]]:
    """An outbox hook for a view that follows its producers: every publication
    of one of `recipe_ids` assembles a successor snapshot against the current
    one, recording the event as the snapshot's source, and reassembles when
    another assembly advanced the view first."""

    async def hook(event: OutboxEvent, store: AnalysisStore) -> None:
        if event.event_type not in ("run_published", "revision_published"):
            return
        if event.payload.get("recipeId") not in recipe_ids:
            return
        request = build_request(event)
        if request is None:
            return
        request = replace(request, source_event_id=event.id)
        for attempt in range(CONFLICT_RETRIES):
            try:
                await assemble_snapshot(request, store=store)
                return
            except SnapshotConflict:
                if attempt == CONFLICT_RETRIES - 1:
                    raise
                logger.info("view %s advanced during assembly; assembling again", request.view_id)

    return hook
