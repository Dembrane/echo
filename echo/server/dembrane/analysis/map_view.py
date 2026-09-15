"""The project map as an analysis view: snapshot assembly and the v2 payload.

The map view (`map`, scope `project`) pins in one immutable snapshot the
current ready output of every registered producer of a map type (arguments,
deduplicated arguments, popcorn, tensions, stakeholders), the latest assessment
of each displayed fact-checkable revision and one embedding configuration. A
project without a ready arguments output shows its newest imported legacy
result instead (see `backfill`), so old results render through the same view.

Advancement. `advance_map_view` assembles a successor against the view's
current snapshot and assembles again when another assembly advanced it first;
identical content keeps the current snapshot. It runs from the outbox hook
registered here, after a completed fact-check, and when a read finds the
snapshot behind its producers or assessments (`needs_advance`), so a following
view catches up even in a process where the hook is not registered. Every map
snapshot gets one v2 `map_result` row keyed by the snapshot id, so result
URLs, fact-checks and titles keep working. The snapshot is the durable,
event-keyed effect ((scope, source event) is unique) and the row is keyed by
the snapshot, so a repeated dispatch writes neither twice.

The payload (`graph_payload`). The snapshot's objects are counted per type
before anything else is read. A selection above the node budget returns the
counts only: no revisions and no vectors are loaded. Otherwise the selected
revisions are projected (label, detail, attributes, fact-check capability,
provenance) with their vectors in the snapshot's embedding configuration. A
vector reference to another configuration is never used: the vector is looked
up again by the revision's projection text within the snapshot's configuration,
and a revision without one is listed as unplaced. Relations are the
snapshot's relations between displayed nodes; a relation pinned to an older
revision is never drawn, the snapshot lists it as stale.

Known limits: authored edits (`revision_published`) do not advance the view,
and selection titles are cached by snapshot and revisions, not pinned as
revisions of their own.
"""

from __future__ import annotations

import uuid
import logging
from typing import Any, Callable, Iterable, Protocol, Awaitable
from datetime import datetime
from collections import Counter
from dataclasses import dataclass

from psycopg.types.json import Json

from dembrane.analysis import db, types
from dembrane.map.recipe import claim_key
from dembrane.analysis.outbox import register_snapshot_hook
from dembrane.analysis.budgets import ResolvedBudgets
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.registry import UnknownRecipe, get_recipe
from dembrane.analysis.contracts import (
    Snapshot,
    ScopeKind,
    NewSnapshot,
    OutboxEvent,
    AnalysisStore,
    ObjectRevision,
    SnapshotConflict,
    AnalysisStoreError,
)
from dembrane.analysis.snapshots import (
    SNAPSHOT_MANIFEST_VERSION,
    ProducerRef,
    SnapshotRequest,
    build_manifest,
)
from dembrane.analysis.embeddings import input_hash

logger = logging.getLogger("dembrane.analysis.map_view")

MAP_VIEW_ID = "map"
# One snapshot per imported legacy result, chained apart from the live view.
LEGACY_VIEW_ID = "map.legacy"
VIEW_SCOPE_KEY = "project"
PAYLOAD_VERSION = 2
MAP_TYPES: tuple[str, ...] = ("argument", "deduplicated_argument", "popcorn", "tension", "stakeholder")
ARGUMENT_TYPES = frozenset({"argument", "deduplicated_argument"})
ARGUMENTS_RECIPE_ID = "arguments"
# The provenance recipe id of arguments imported from v1 map results.
LEGACY_RECIPE_ID = "map.legacy_arguments"
# Fixed forever: backfill ids are uuid5 names in this namespace.
LEGACY_NAMESPACE = uuid.UUID("7d0c5a3e-2f6b-5c1d-9e8a-4b3c2d1e0f9a")
ADVANCE_RETRIES = 3
V2_RESULT_RECIPE_VERSION = "map-view-v2"


class UnknownMapType(ValueError):
    pass


class UnknownResultScope(ValueError):
    pass


def legacy_revision_id(result_id: str, node_id: str, *, variant: str = "") -> str:
    """The revision id a legacy node is imported under when its content is new.
    A `variant` names a successor of that revision, such as the one that
    carries the stored vector a first import could not attach."""
    name = f"map_result:{result_id}:node:{node_id}"
    return str(uuid.uuid5(LEGACY_NAMESPACE, f"{name}:{variant}" if variant else name))


def legacy_lineage_key(node_id: str) -> str:
    """A legacy node id is the identity v1 kept for one statement and kind
    across its results, so it is the imported object's lineage key."""
    return f"legacy-map:{uuid.uuid5(LEGACY_NAMESPACE, f'node:{node_id}')}"


def legacy_object_id(node_id: str) -> str:
    """The object id a legacy node's lineage is created under. Only a lineage
    that has no object yet may be given one, so an import that predates fixed
    ids keeps the id it already has."""
    return str(uuid.uuid5(LEGACY_NAMESPACE, f"object:{node_id}"))


def is_v2_manifest(manifest: Any) -> bool:
    """A v2 `map_result` row's manifest is a pointer to its snapshot, never a copy."""
    return isinstance(manifest, dict) and manifest.get("version") == PAYLOAD_VERSION and bool(manifest.get("snapshotId"))


# ── reads the lifecycle store does not offer ────────────────────────────


@dataclass(frozen=True)
class ProducerHead:
    recipe_id: str
    scope_key: str
    scope_id: str
    run_id: str


@dataclass(frozen=True)
class ResultLink:
    """A `map_result` row's version columns, without its manifest."""

    id: str
    project_id: str
    status: str
    manifest_version: int
    snapshot_id: str | None
    recipe_version: str | None = None
    embedding_config: dict[str, Any] | None = None
    created_at: datetime | None = None
    completed_at: datetime | None = None


@dataclass(frozen=True)
class LineageHead:
    """An imported object and the revision that is its head, if any."""

    object_id: str
    revision_id: str | None


class MapViewReads(Protocol):
    async def producer_heads(self, project_id: str) -> list[ProducerHead]: ...
    async def lineage_heads(
        self, project_id: str, type_id: str, lineage_keys: list[str]
    ) -> dict[str, LineageHead]: ...
    async def embedding_identity(self, project_id: str, config_key: str) -> tuple[str, int] | None: ...
    async def result_link(self, result_id: str) -> ResultLink | None: ...
    async def legacy_results(self, project_id: str | None) -> list[ResultLink]: ...
    async def ensure_v2_result(self, snapshot: Snapshot) -> str: ...
    async def link_legacy_snapshot(self, result_id: str, snapshot_id: str) -> bool: ...
    async def revision_history(self, project_id: str, object_id: str) -> list[str]: ...


def _is_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


LINK_COLUMNS = (
    "id::text AS id, project_id::text AS project_id, status, manifest_version, "
    "snapshot_id::text AS snapshot_id, recipe_version, embedding_config, created_at, completed_at"
)


def _link(row: dict[str, Any]) -> ResultLink:
    return ResultLink(
        id=row["id"],
        project_id=row["project_id"],
        status=row["status"],
        manifest_version=int(row["manifest_version"] or 1),
        snapshot_id=row["snapshot_id"],
        recipe_version=row.get("recipe_version"),
        embedding_config=row.get("embedding_config"),
        created_at=row.get("created_at"),
        completed_at=row.get("completed_at"),
    )


class SqlMapViewReads:
    def __init__(self, dsn: str | None = None) -> None:
        self._dsn = dsn

    async def producer_heads(self, project_id: str) -> list[ProducerHead]:
        async with db.autocommit_cursor(self._dsn, AnalysisStoreError) as cursor:
            await cursor.execute(
                """SELECT recipe_id, scope_key, id::text AS scope_id, current_run_id::text AS run_id
                   FROM analysis_scope
                   WHERE project_id = %s AND kind = 'producer' AND current_run_id IS NOT NULL
                   ORDER BY recipe_id, scope_key""",
                (project_id,),
            )
            rows = await cursor.fetchall()
        return [ProducerHead(r["recipe_id"], r["scope_key"], r["scope_id"], r["run_id"]) for r in rows]

    async def embedding_identity(self, project_id: str, config_key: str) -> tuple[str, int] | None:
        async with db.autocommit_cursor(self._dsn, AnalysisStoreError) as cursor:
            await cursor.execute(
                "SELECT model, dims FROM map_embedding WHERE project_id = %s AND config_key = %s LIMIT 1",
                (project_id, config_key),
            )
            row = await cursor.fetchone()
        return (str(row["model"]), int(row["dims"])) if row else None

    async def result_link(self, result_id: str) -> ResultLink | None:
        if not _is_uuid(result_id):
            return None
        async with db.autocommit_cursor(self._dsn, AnalysisStoreError) as cursor:
            await cursor.execute(f"SELECT {LINK_COLUMNS} FROM map_result WHERE id = %s", (result_id,))
            row = await cursor.fetchone()
        return _link(row) if row else None

    async def legacy_results(self, project_id: str | None) -> list[ResultLink]:
        """Ready v1 results, oldest first (of one project, or of every project)."""
        where = "status = 'ready' AND manifest_version = 1"
        params: tuple[Any, ...] = ()
        if project_id is not None:
            where += " AND project_id = %s"
            params = (project_id,)
        async with db.autocommit_cursor(self._dsn, AnalysisStoreError) as cursor:
            await cursor.execute(
                f"SELECT {LINK_COLUMNS} FROM map_result WHERE {where} ORDER BY project_id, created_at, id", params
            )
            return [_link(row) for row in await cursor.fetchall()]

    async def ensure_v2_result(self, snapshot: Snapshot) -> str:
        """The v2 row of a map snapshot, written once per snapshot."""
        async with db.transaction(self._dsn, AnalysisStoreError) as cursor:
            await cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"map_result:{snapshot.id}",))
            await cursor.execute(
                "SELECT id::text AS id FROM map_result WHERE snapshot_id = %s AND manifest_version = 2 LIMIT 1",
                (snapshot.id,),
            )
            existing = await cursor.fetchone()
            if existing:
                return str(existing["id"])
            result_id = str(uuid.uuid4())
            await cursor.execute(
                """INSERT INTO map_result
                       (id, project_id, status, recipe_version, embedding_config, progress, manifest,
                        requested_by, manifest_version, snapshot_id, created_at, updated_at, completed_at)
                   VALUES (%s, %s, 'ready', %s, %s, %s, %s, %s, 2, %s, now(), now(), now())""",
                (
                    result_id,
                    snapshot.project_id,
                    V2_RESULT_RECIPE_VERSION,
                    Json(snapshot.embedding_config) if snapshot.embedding_config else None,
                    Json({"stage": "ready"}),
                    Json({"version": PAYLOAD_VERSION, "snapshotId": snapshot.id}),
                    snapshot.created_by,
                    snapshot.id,
                ),
            )
            return result_id

    async def lineage_heads(
        self, project_id: str, type_id: str, lineage_keys: list[str]
    ) -> dict[str, LineageHead]:
        """The object and head revision of each lineage that already exists."""
        if not lineage_keys:
            return {}
        async with db.autocommit_cursor(self._dsn, AnalysisStoreError) as cursor:
            await cursor.execute(
                """SELECT lineage_key, id::text AS object_id, current_revision_id::text AS revision_id
                   FROM analysis_object
                   WHERE project_id = %s AND type = %s AND lineage_key = ANY(%s)""",
                (project_id, type_id, list(lineage_keys)),
            )
            return {
                str(row["lineage_key"]): LineageHead(str(row["object_id"]), row["revision_id"])
                for row in await cursor.fetchall()
            }

    async def link_legacy_snapshot(self, result_id: str, snapshot_id: str) -> bool:
        """The backfill watermark: a v1 result names the snapshot it was
        imported into. A later import of the same result (one that attached the
        vectors an earlier import could not) moves it to that snapshot; False
        when the result already names it."""
        async with db.autocommit_cursor(self._dsn, AnalysisStoreError) as cursor:
            await cursor.execute(
                """UPDATE map_result SET snapshot_id = %s, updated_at = now()
                   WHERE id = %s AND manifest_version = 1 AND snapshot_id IS DISTINCT FROM %s""",
                (snapshot_id, result_id, snapshot_id),
            )
            return cursor.rowcount == 1

    async def revision_history(self, project_id: str, object_id: str) -> list[str]:
        if not _is_uuid(object_id):
            return []
        async with db.autocommit_cursor(self._dsn, AnalysisStoreError) as cursor:
            await cursor.execute(
                """SELECT id::text AS id FROM analysis_object_revision
                   WHERE project_id = %s AND object_id = %s AND status = 'published'
                   ORDER BY revision_number""",
                (project_id, object_id),
            )
            return [row["id"] for row in await cursor.fetchall()]


# ── projections ─────────────────────────────────────────────────────────


def _quotes_as_evidence(quotes: Iterable[Any]) -> list[dict[str, Any]]:
    """Quote references grouped per conversation in the evidence shape."""
    grouped: dict[str, list[str]] = {}
    for quote in quotes:
        if isinstance(quote, dict) and quote.get("conversationId") and quote.get("text"):
            grouped.setdefault(str(quote["conversationId"]), []).append(str(quote["text"]))
    return [{"conversationId": cid, "quotes": texts} for cid, texts in grouped.items()]


def claim_of(revision: ObjectRevision) -> tuple[str, list[str], str] | None:
    """A fact-checkable revision's statement, evidence quotes and claim key.
    The key is Map's, so a claim keeps the check state it had as a v1 node."""
    definition = types.get_object_type(revision.type)
    if definition.fact_check is None or not definition.fact_check.eligible(revision.payload, revision.attributes):
        return None
    statement = definition.fact_check.statement(revision.payload)
    quotes = [str(q) for item in revision.payload.get("evidence") or [] for q in item.get("quotes") or []]
    return statement, quotes, claim_key(statement, quotes)


def project_detail(revision: ObjectRevision) -> dict[str, Any]:
    capability = types.get_object_type(revision.type).map
    detail = dict(capability.detail(revision.payload)) if capability else {}
    if "evidence" not in detail and isinstance(detail.get("quotes"), list):
        detail["evidence"] = _quotes_as_evidence(detail["quotes"])
    created = [str(e["createdAt"]) for e in revision.payload.get("evidence") or [] if e.get("createdAt")]
    if created:
        detail["createdAt"] = max(created)
    claim = claim_of(revision)
    if claim is not None:
        detail["claimKey"] = claim[2]
    return detail


def label_of(revision: ObjectRevision) -> str:
    capability = types.get_object_type(revision.type).map
    return capability.label(revision.payload) if capability else revision.type


def provenance_doc(revision: ObjectRevision) -> dict[str, Any]:
    provenance = revision.provenance
    doc: dict[str, Any] = {
        "runId": provenance.run_id or str(provenance.extra.get("legacyResultId") or ""),
        "origin": str(provenance.origin),
    }
    if provenance.recipe_id:
        doc["recipeId"] = provenance.recipe_id
    if provenance.recipe_version:
        doc["recipeVersion"] = provenance.recipe_version
    return doc


def node_doc(revision: ObjectRevision, vector: list[float] | None, assessment_id: str | None) -> dict[str, Any]:
    claim = claim_of(revision)
    fact_check: dict[str, Any] = {"eligible": claim is not None}
    if claim is not None:
        fact_check["claimKey"] = claim[2]
    if assessment_id:
        fact_check["assessmentRevisionId"] = assessment_id
    return {
        "objectId": revision.object_id,
        "revisionId": revision.id,
        "type": revision.type,
        "label": label_of(revision),
        "detail": project_detail(revision),
        "attributes": {k: revision.attributes[k] for k in ("valence", "epistemicKind") if revision.attributes.get(k)},
        "factCheck": fact_check,
        "provenance": provenance_doc(revision),
        "embedding": [round(value, 6) for value in vector] if vector is not None else None,
    }


def _usable(vector: list[float] | None, dims: int) -> bool:
    return bool(vector) and (not dims or len(vector or []) == dims) and any(vector or [])


async def load_vectors(
    project_id: str,
    revisions: Iterable[ObjectRevision],
    config: dict[str, Any] | None,
    *,
    store: AnalysisStore,
) -> dict[str, list[float]]:
    """Vectors by revision id in exactly one embedding configuration.

    A reference to this configuration and projection is read by id; anything
    else (no reference, another configuration, another projection, a vector
    that no longer loads) is looked up by its projection text's hash within
    this configuration. Nothing is embedded here."""
    if not config or not config.get("key"):
        return {}
    key = str(config["key"])
    dims = int(config.get("dims") or 0)
    by_reference: dict[str, str] = {}
    by_text: dict[str, str] = {}
    texts: dict[str, str] = {}
    for revision in revisions:
        capability = types.get_object_type(revision.type).map
        if capability is None:
            continue
        texts[revision.id] = input_hash(capability.embedding_text(revision.payload))
        ref = revision.embedding_refs or {}
        if (
            ref.get("embeddingId")
            and ref.get("configKey") == key
            and ref.get("projectionVersion") in (None, capability.projection_version)
        ):
            by_reference[revision.id] = str(ref["embeddingId"])
        else:
            by_text[revision.id] = texts[revision.id]
    out: dict[str, list[float]] = {}
    if by_reference:
        loaded = await store.vectors_by_ids(project_id, sorted(set(by_reference.values())))
        for revision_id, embedding_id in by_reference.items():
            vector = loaded.get(embedding_id)
            if vector is None:
                by_text[revision_id] = texts[revision_id]
            else:
                out[revision_id] = vector
    if by_text:
        stored = await store.load_embeddings(project_id, key, sorted(set(by_text.values())))
        for revision_id, hashed in by_text.items():
            if hashed in stored:
                out[revision_id] = stored[hashed][1]
    return {rid: vector for rid, vector in out.items() if _usable(vector, dims)}


# ── the graph payload ───────────────────────────────────────────────────


@dataclass(frozen=True)
class GraphQuery:
    # None: the server chooses. Empty: no types selected.
    types: tuple[str, ...] | None
    scope: str | None
    budgets: ResolvedBudgets


def parse_types(raw: str | None) -> tuple[str, ...] | None:
    if raw is None:
        return None
    names = [part.strip() for part in raw.split(",") if part.strip()]
    unknown = sorted({name for name in names if name not in MAP_TYPES})
    if unknown:
        raise UnknownMapType(f"unknown object types: {', '.join(unknown)}")
    return tuple(t for t in MAP_TYPES if t in names)


def zero_counts() -> dict[str, int]:
    return {t: 0 for t in MAP_TYPES}


def default_types(counts: dict[str, int], node_limit: int) -> list[str]:
    """The frontend's default: available types that fit the node budget
    together, deduplicated arguments standing in for raw ones; every available
    type when none fits, so the over-budget state can explain it."""
    available = [t for t in MAP_TYPES if counts.get(t)]
    candidates = [t for t in available if t != "argument"] if "deduplicated_argument" in available else available
    selected: list[str] = []
    total = 0
    for type_id in candidates:
        if total + counts[type_id] > node_limit:
            continue
        selected.append(type_id)
        total += counts[type_id]
    return selected or candidates


def _producer_names(producer: dict[str, Any]) -> set[str]:
    names = {str(producer["recipeId"]), f"{producer['recipeId']}@{producer['scopeKey']}"}
    if producer.get("runId"):
        names.add(f"run:{producer['runId']}")
    return names


async def scope_object_ids(snapshot: Snapshot, scope: str, *, store: AnalysisStore) -> set[str]:
    """The objects of one producer output in this snapshot. `scope` names it as
    `<recipe id>`, `<recipe id>@<scope key>` or `run:<run id>`."""
    for producer in snapshot.manifest.get("producers") or []:
        if not producer.get("available") or scope not in _producer_names(producer):
            continue
        if not producer.get("runId"):
            return {str(o) for o in producer.get("objectIds") or []}
        run = await store.get_run(str(producer["runId"]))
        manifest = (run.output_manifest if run else None) or {}
        return {str(o["objectId"]) for o in manifest.get("objects") or []}
    raise UnknownResultScope(f"this map has no output named {scope!r}")


def _budget_state(counts: dict[str, int], query: GraphQuery) -> tuple[list[str], bool]:
    selected = list(query.types) if query.types is not None else default_types(counts, query.budgets.budgets.node_limit)
    total = sum(counts.get(t, 0) for t in selected)
    return selected, total > query.budgets.budgets.node_limit


def _embedding_doc(config: dict[str, Any] | None) -> dict[str, Any]:
    config = config or {}
    return {"key": str(config.get("key") or ""), "model": str(config.get("model") or ""), "dims": int(config.get("dims") or 0)}


async def _stale_refs(snapshot: Snapshot, *, store: AnalysisStore) -> list[dict[str, Any]]:
    """The snapshot's stale entries, each naming the displayed revision whose
    freshness it affects: the dependent end of a relation pinned to an older
    revision, or every displayed output of a run that pinned an older input."""
    manifest = snapshot.manifest
    entries = list(manifest.get("stale") or [])
    if not entries:
        return []
    displayed = {str(o["revisionId"]) for o in manifest.get("objects") or []}
    by_object = {str(o["objectId"]): str(o["revisionId"]) for o in manifest.get("objects") or []}
    relation_ids = [str(e["relationId"]) for e in entries if e.get("kind") == "relation" and e.get("relationId")]
    relations = await store.get_relations(snapshot.project_id, relation_ids) if relation_ids else {}
    out: list[dict[str, Any]] = []
    for entry in entries:
        base = {**entry, "reason": "based_on_earlier_revision"}
        if entry.get("kind") == "relation":
            relation = relations.get(str(entry.get("relationId")))
            ends = [relation.from_revision_id, relation.to_revision_id] if relation else []
            dependents = [end for end in ends if end != entry.get("pinnedRevisionId") and end in displayed]
            out.append({**base, "revisionId": dependents[0] if dependents else entry.get("displayedRevisionId")})
            continue
        run = await store.get_run(str(entry.get("runId"))) if entry.get("runId") else None
        outputs = [by_object[str(o["objectId"])] for o in ((run.output_manifest if run else None) or {}).get("objects") or [] if str(o["objectId"]) in by_object]
        for revision_id in outputs or [entry.get("displayedRevisionId")]:
            out.append({**base, "revisionId": revision_id})
    return out


async def graph_payload(
    snapshot: Snapshot,
    query: GraphQuery,
    *,
    store: AnalysisStore,
    result_id: str | None = None,
) -> dict[str, Any]:
    manifest = snapshot.manifest
    entries = [o for o in manifest.get("objects") or [] if o.get("type") in MAP_TYPES]
    if query.scope:
        members = await scope_object_ids(snapshot, query.scope, store=store)
        entries = [o for o in entries if str(o["objectId"]) in members]
    counts = zero_counts()
    for entry in entries:
        counts[str(entry["type"])] += 1
    selected, over_budget = _budget_state(counts, query)
    config = snapshot.embedding_config or manifest.get("embeddingConfig")
    snapshot_doc: dict[str, Any] = {
        "id": snapshot.id,
        "createdAt": snapshot.created_at.isoformat() if snapshot.created_at else None,
        "parentId": snapshot.parent_snapshot_id,
        "stale": await _stale_refs(snapshot, store=store),
    }
    if result_id:
        snapshot_doc["resultId"] = result_id
    payload: dict[str, Any] = {
        "version": PAYLOAD_VERSION,
        "snapshot": snapshot_doc,
        "budgets": query.budgets.as_payload(),
        "counts": counts,
        "scope": {"types": selected, **({"resultScope": query.scope} if query.scope else {})},
        "overBudget": over_budget,
        "embedding": _embedding_doc(config),
        "nodes": [],
        "relations": [],
        "unplaced": [],
        "related": [],
    }
    if over_budget:
        # Counts only: no revision, relation or vector is read for an oversized scope.
        return payload

    chosen_entries = [o for o in entries if o["type"] in selected]
    chosen_ids = [str(o["revisionId"]) for o in chosen_entries]
    revisions = await store.get_revisions(snapshot.project_id, chosen_ids)
    vectors = await load_vectors(snapshot.project_id, revisions.values(), config, store=store)
    assessments = {str(a["targetRevisionId"]): str(a["revisionId"]) for a in manifest.get("assessments") or []}
    nodes = []
    for revision_id in chosen_ids:
        revision = revisions.get(revision_id)
        if revision is None:
            continue
        nodes.append(node_doc(revision, vectors.get(revision_id), assessments.get(revision_id)))
    shown = {node["revisionId"] for node in nodes}
    payload["nodes"] = nodes
    payload["unplaced"] = [node["revisionId"] for node in nodes if node["embedding"] is None]

    snapshot_relations = list(manifest.get("relations") or [])
    drawn = [r for r in snapshot_relations if str(r["from"]) in shown and str(r["to"]) in shown]
    rows = await store.get_relations(snapshot.project_id, [str(r["relationId"]) for r in drawn]) if drawn else {}
    payload["relations"] = [
        {
            "id": str(r["relationId"]),
            "type": r["type"],
            "from": str(r["from"]),
            "to": str(r["to"]),
            "basis": str(rows[str(r["relationId"])].basis) if str(r["relationId"]) in rows else "inferred",
        }
        for r in drawn
    ]
    in_snapshot = {str(o["revisionId"]) for o in manifest.get("objects") or [] if o.get("type") in MAP_TYPES}
    outside = sorted(
        {
            str(r[end])
            for r in snapshot_relations
            for end, other in (("from", "to"), ("to", "from"))
            if str(r[other]) in shown and str(r[end]) not in shown and str(r[end]) in in_snapshot
        }
    )
    if outside:
        related = await store.get_revisions(snapshot.project_id, outside)
        payload["related"] = [
            {"objectId": r.object_id, "revisionId": r.id, "type": r.type, "label": label_of(r)}
            for rid in outside
            if (r := related.get(rid)) is not None
        ]
    return payload


def legacy_node(argument: dict[str, Any], row: dict[str, Any], vector: list[float] | None) -> dict[str, Any]:
    """A v1 node in the v2 node shape. Its node id stays the id fact-checks and
    titles use on the v1 routes."""
    evidence = [
        {
            "conversationId": item.get("conversation_id"),
            "label": item.get("label"),
            "createdAt": item.get("created_at"),
            "quotes": item.get("quotes") or [],
        }
        for item in argument.get("evidence") or []
    ]
    detail: dict[str, Any] = {
        "statement": argument["statement"],
        "epistemicKind": argument["kind"],
        "valence": argument.get("valence"),
        "evidence": evidence,
    }
    if argument.get("created_at"):
        detail["createdAt"] = argument["created_at"]
    fact_check: dict[str, Any] = {"eligible": argument.get("kind") == "claim"}
    if argument.get("claim_key"):
        detail["claimKey"] = argument["claim_key"]
        fact_check["claimKey"] = argument["claim_key"]
    provenance: dict[str, Any] = {"runId": row["id"], "origin": "imported", "recipeId": LEGACY_RECIPE_ID}
    if row.get("recipe_version"):
        provenance["recipeVersion"] = row["recipe_version"]
    return {
        "objectId": argument["id"],
        "revisionId": argument["id"],
        "type": "argument",
        "label": argument["statement"],
        "detail": detail,
        "attributes": {
            k: v for k, v in (("valence", argument.get("valence")), ("epistemicKind", argument.get("kind"))) if v
        },
        "factCheck": fact_check,
        "provenance": provenance,
        "embedding": [round(value, 6) for value in vector] if vector is not None else None,
    }


async def legacy_graph_payload(row: dict[str, Any], query: GraphQuery, *, store: Any) -> dict[str, Any]:
    """A ready v1 result not yet imported, in the v2 shape: every node an
    argument with legacy provenance, its snapshot id the result id (so the v1
    fact-check and title routes answer). `store` is Map's store."""
    if query.scope:
        raise UnknownResultScope(f"this map has no output named {query.scope!r}")
    arguments = list((row.get("manifest") or {}).get("arguments") or [])
    counts = zero_counts()
    counts["argument"] = len(arguments)
    selected, over_budget = _budget_state(counts, query)
    completed = row.get("completed_at")
    payload: dict[str, Any] = {
        "version": PAYLOAD_VERSION,
        "snapshot": {
            "id": row["id"],
            "createdAt": completed.isoformat() if isinstance(completed, datetime) else completed,
            "parentId": None,
            "stale": [],
            "resultId": row["id"],
            "legacy": True,
        },
        "budgets": query.budgets.as_payload(),
        "counts": counts,
        "scope": {"types": selected},
        "overBudget": over_budget,
        "embedding": _embedding_doc(row.get("embedding_config")),
        "nodes": [],
        "relations": [],
        "unplaced": [],
        "related": [],
    }
    if over_budget or "argument" not in selected:
        return payload
    vectors = await store.vectors_by_ids(row["project_id"], [a["embedding_id"] for a in arguments if a.get("embedding_id")])
    dims = int((row.get("embedding_config") or {}).get("dims") or 0)
    nodes = []
    for argument in arguments:
        vector = vectors.get(argument.get("embedding_id") or "")
        nodes.append(legacy_node(argument, row, vector if _usable(vector, dims) else None))
    payload["nodes"] = nodes
    payload["unplaced"] = [node["revisionId"] for node in nodes if node["embedding"] is None]
    return payload


# ── assembly and advancement ────────────────────────────────────────────


async def map_producers(project_id: str, *, reads: MapViewReads) -> list[ProducerHead]:
    """Producer scopes with a ready output whose registered recipe makes a map type."""
    out = []
    for head in await reads.producer_heads(project_id):
        try:
            recipe = get_recipe(head.recipe_id)
        except UnknownRecipe:
            continue
        if set(recipe.output_types) & set(MAP_TYPES):
            out.append(head)
    return out


async def legacy_source(
    project_id: str, *, store: AnalysisStore, reads: MapViewReads
) -> tuple[ResultLink, Snapshot] | None:
    """The newest ready v1 result and its import snapshot, when it was imported."""
    rows = await reads.legacy_results(project_id)
    if not rows or not rows[-1].snapshot_id:
        return None
    snapshot = await store.get_snapshot(str(rows[-1].snapshot_id))
    if snapshot is None or snapshot.project_id != project_id:
        return None
    return rows[-1], snapshot


async def _embedding_config(
    project_id: str,
    objects: list[dict[str, Any]],
    legacy: Snapshot | None,
    *,
    store: AnalysisStore,
    reads: MapViewReads,
) -> dict[str, Any] | None:
    """One configuration for the whole snapshot: the one most displayed
    revisions reference, else the imported result's."""
    ids = [str(o["revisionId"]) for o in objects if o.get("type") in MAP_TYPES]
    revisions = await store.get_revisions(project_id, ids) if ids else {}
    keys = Counter(
        str((r.embedding_refs or {})["configKey"]) for r in revisions.values() if (r.embedding_refs or {}).get("configKey")
    )
    legacy_config = (legacy.embedding_config if legacy else None) or {}
    if keys:
        key = max(keys.items(), key=lambda item: (item[1], item[0]))[0]
    elif legacy_config.get("key"):
        key = str(legacy_config["key"])
    else:
        return None
    if key == legacy_config.get("key"):
        return {"key": key, "model": legacy_config.get("model"), "dims": legacy_config.get("dims")}
    identity = await reads.embedding_identity(project_id, key)
    return {"key": key, "model": identity[0] if identity else None, "dims": identity[1] if identity else None}


async def build_map_manifest(project_id: str, *, store: AnalysisStore, reads: MapViewReads) -> dict[str, Any]:
    heads = await map_producers(project_id, reads=reads)
    request = SnapshotRequest(
        project_id=project_id,
        view_id=MAP_VIEW_ID,
        scope_key=VIEW_SCOPE_KEY,
        producers=tuple(ProducerRef(h.recipe_id, h.scope_key) for h in heads),
        versions={"mapPayload": PAYLOAD_VERSION},
    )
    manifest = await build_manifest(request, store=store)
    body = {k: v for k, v in manifest.items() if k != "contentHash"}
    arguments_ready = any(p["recipeId"] == ARGUMENTS_RECIPE_ID and p.get("available") for p in body["producers"])
    legacy = None if arguments_ready else await legacy_source(project_id, store=store, reads=reads)
    legacy_snapshot = legacy[1] if legacy else None
    if legacy is not None and legacy_snapshot is not None:
        row = legacy[0]
        shown = {str(o["objectId"]) for o in body["objects"]}
        imported = [
            {"objectId": str(o["objectId"]), "revisionId": str(o["revisionId"]), "type": str(o["type"])}
            for o in legacy_snapshot.manifest.get("objects") or []
            if str(o["objectId"]) not in shown
        ]
        body["objects"] = sorted([*body["objects"], *imported], key=lambda o: o["objectId"])
        body["producers"] = [
            *body["producers"],
            {
                "recipeId": LEGACY_RECIPE_ID,
                "scopeKey": VIEW_SCOPE_KEY,
                "runId": None,
                "recipeVersion": row.recipe_version,
                "legacyResultId": row.id,
                "legacySnapshotId": legacy_snapshot.id,
                "objectIds": sorted(o["objectId"] for o in imported),
                "available": True,
            },
        ]
        found = await store.assessments_for(project_id, [o["revisionId"] for o in imported])
        body["assessments"] = sorted(
            [
                *body["assessments"],
                *(
                    {
                        "targetRevisionId": target,
                        "revisionId": assessment.id,
                        "relationId": assessment.provenance.extra.get("assessesRelationId"),
                    }
                    for target, assessment in found.items()
                ),
            ],
            key=lambda a: a["targetRevisionId"],
        )
    body["embeddingConfig"] = await _embedding_config(
        project_id, body["objects"], legacy_snapshot, store=store, reads=reads
    )
    return {**body, "contentHash": content_hash(body)}


async def needs_advance(snapshot: Snapshot, *, store: AnalysisStore, reads: MapViewReads) -> bool:
    """Whether the view's current snapshot is behind: another producer output
    is current, another legacy result is newest, or a displayed claim has a
    newer assessment than the one pinned."""
    manifest = snapshot.manifest
    producers = list(manifest.get("producers") or [])
    heads = await map_producers(snapshot.project_id, reads=reads)
    pinned = {(p["recipeId"], p["scopeKey"], p["runId"]) for p in producers if p.get("runId")}
    if pinned != {(h.recipe_id, h.scope_key, h.run_id) for h in heads}:
        return True
    legacy_pinned = next((p.get("legacySnapshotId") for p in producers if p["recipeId"] == LEGACY_RECIPE_ID), None)
    if any(h.recipe_id == ARGUMENTS_RECIPE_ID for h in heads):
        if legacy_pinned:
            return True
    else:
        legacy = await legacy_source(snapshot.project_id, store=store, reads=reads)
        if (legacy[1].id if legacy else None) != legacy_pinned:
            return True
    checkable = [str(o["revisionId"]) for o in manifest.get("objects") or [] if o.get("type") in ARGUMENT_TYPES]
    if not checkable:
        return False
    latest = await store.assessments_for(snapshot.project_id, checkable)
    shown = {str(a["targetRevisionId"]): str(a["revisionId"]) for a in manifest.get("assessments") or []}
    return {target: a.id for target, a in latest.items()} != shown


EventPublisher = Callable[[str, dict[str, Any]], Awaitable[None]]


async def _publish_map_event(project_id: str, event: dict[str, Any]) -> None:
    from dembrane.map.events import publish_map_event

    await publish_map_event(project_id, event)


async def advance_map_view(
    project_id: str,
    *,
    store: AnalysisStore,
    reads: MapViewReads,
    source_event_id: str | None = None,
    created_by: str | None = None,
    publish: EventPublisher | None = None,
) -> Snapshot | None:
    """Assemble the map view's successor snapshot, or keep the current one when
    nothing changed. None when the project has nothing to show and no view yet."""
    snapshot: Snapshot | None = None
    created = False
    for attempt in range(ADVANCE_RETRIES):
        scope = await store.ensure_scope(
            project_id=project_id, kind=ScopeKind.VIEW, owner_id=MAP_VIEW_ID, scope_key=VIEW_SCOPE_KEY
        )
        expected = scope.current_snapshot_id
        manifest = await build_map_manifest(project_id, store=store, reads=reads)
        if expected is None and not manifest["objects"] and not any(p.get("available") for p in manifest["producers"]):
            return None
        previous = await store.get_snapshot(expected) if expected else None
        if previous is not None and source_event_id is None and previous.content_hash == manifest["contentHash"]:
            snapshot = previous
            break
        try:
            snapshot = await store.publish_snapshot(
                NewSnapshot(
                    project_id=project_id,
                    scope_id=scope.id,
                    view_id=MAP_VIEW_ID,
                    manifest=manifest,
                    content_hash=manifest["contentHash"],
                    manifest_version=SNAPSHOT_MANIFEST_VERSION,
                    versions=dict(manifest.get("versions") or {}),
                    embedding_config=manifest.get("embeddingConfig"),
                    created_by=created_by,
                    source_event_id=source_event_id,
                ),
                expected_previous_id=expected,
            )
            created = snapshot.id != expected
            break
        except SnapshotConflict:
            if attempt == ADVANCE_RETRIES - 1:
                raise
            logger.info("map view of project %s advanced during assembly; assembling again", project_id)
    if snapshot is None:
        return None
    await reads.ensure_v2_result(snapshot)
    if created:
        await (publish or _publish_map_event)(project_id, {"type": "ready", "snapshot_id": snapshot.id})
    return snapshot


async def current_map_snapshot(
    project_id: str,
    *,
    store: AnalysisStore,
    reads: MapViewReads,
    follow: bool = True,
    publish: EventPublisher | None = None,
) -> Snapshot | None:
    """The map view's current snapshot, advanced first when it is behind (or
    assembled when producers or an imported result exist but no view does)."""
    scope = await store.find_scope(
        project_id=project_id, kind=ScopeKind.VIEW, owner_id=MAP_VIEW_ID, scope_key=VIEW_SCOPE_KEY
    )
    snapshot = await store.get_snapshot(scope.current_snapshot_id) if scope and scope.current_snapshot_id else None
    if not follow:
        return snapshot
    if snapshot is None or await needs_advance(snapshot, store=store, reads=reads):
        return await advance_map_view(project_id, store=store, reads=reads, publish=publish) or snapshot
    return snapshot


# ── reading what a snapshot pins ────────────────────────────────────────

MAX_LINEAGE_DEPTH = 4
MAX_LINEAGE_REVISIONS = 500


async def snapshot_revision(snapshot: Snapshot, revision_id: str, *, store: AnalysisStore) -> ObjectRevision | None:
    """A revision the snapshot displays, exactly as pinned; None otherwise."""
    if not any(str(o.get("revisionId")) == revision_id for o in snapshot.manifest.get("objects") or []):
        return None
    return (await store.get_revisions(snapshot.project_id, [revision_id])).get(revision_id)


async def pinned_lineage(snapshot: Snapshot, revision_id: str, *, store: AnalysisStore) -> dict[str, Any] | None:
    """The historical evidence behind one displayed revision: the exact input
    revisions its provenance names, and theirs, as they were pinned, never
    today's heads. Source references travel inside each revision's provenance.
    None when the snapshot does not display the revision."""
    manifest = snapshot.manifest
    pinned = {str(o.get("revisionId")) for o in manifest.get("objects") or []}
    pinned |= {str(a.get("revisionId")) for a in manifest.get("assessments") or []}
    if revision_id not in pinned:
        return None
    seen: dict[str, ObjectRevision] = {}
    edges: list[dict[str, str]] = []
    missing: list[str] = []
    frontier = [revision_id]
    truncated = False
    for _depth in range(MAX_LINEAGE_DEPTH + 1):
        wanted = [rid for rid in dict.fromkeys(frontier) if rid not in seen]
        if not wanted:
            break
        if len(seen) + len(wanted) > MAX_LINEAGE_REVISIONS:
            wanted = wanted[: MAX_LINEAGE_REVISIONS - len(seen)]
            truncated = True
        found = await store.get_revisions(snapshot.project_id, wanted)
        missing += [rid for rid in wanted if rid not in found]
        seen.update(found)
        frontier = []
        for revision in found.values():
            for input_id in revision.provenance.input_revision_ids:
                edges.append({"from": revision.id, "to": input_id})
                frontier.append(input_id)
        if truncated:
            break
    else:
        truncated = any(rid not in seen for rid in frontier)
    return {
        "snapshotId": snapshot.id,
        "root": revision_id,
        "revisions": [
            {**r.envelope(), "revisionNumber": r.revision_number, "status": str(r.status)} for r in seen.values()
        ],
        "edges": edges,
        # Pinned ids that no longer resolve (source deletion): shown as missing.
        "missing": sorted(set(missing)),
        "truncated": truncated,
    }


# ── the following-view hook ─────────────────────────────────────────────

# Assessments change what a view pins, so their publications advance it too.
HOOK_TYPES = frozenset({*MAP_TYPES, "fact_check_assessment"})


def default_reads() -> MapViewReads:
    return SqlMapViewReads()


async def map_view_hook(event: OutboxEvent, store: AnalysisStore) -> None:
    if event.event_type != "run_published":
        return
    try:
        recipe = get_recipe(str(event.payload.get("recipeId")))
    except UnknownRecipe:
        return
    if not set(recipe.output_types) & HOOK_TYPES:
        return
    await advance_map_view(event.project_id, store=store, reads=default_reads(), source_event_id=event.id)


register_snapshot_hook(map_view_hook)
