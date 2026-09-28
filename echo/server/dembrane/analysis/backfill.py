"""Import ready v1 Map results into analysis objects, without a model call.

For every ready v1 `map_result`, oldest first per project:

1. Each node becomes a published `argument` revision through the revision
   service's import path. The object's lineage key comes from the node id,
   which v1 kept for one statement and kind across its results, and a new
   lineage is created under a deterministic object id. The revision id is a
   uuid5 of the result and node ids. Content and evidence identical to the
   object's head share that revision instead of writing another.
2. The vector v1 saved is attached by reference: the embedding row it recorded,
   under the result's own configuration key. Nothing is embedded or recomputed
   here, and a node whose result saved no vector is imported without one.
3. The provenance names the legacy recipe (`map.legacy_arguments` at the
   result's recipe version) and records the result, node and candidate ids.
4. The imported revisions are pinned in a `map.legacy` snapshot whose manifest
   maps each node id to its revision id and is labelled incomplete for
   assessments (v1 kept none as history, and today's verdicts are not
   substituted). The result row then names that snapshot.
5. Each project's map view is advanced, so old results render through v2.

Repair. A revision imported before references could be carried keeps no vector,
and a published revision is immutable, so the reference arrives as one more
imported revision of the same object under its own deterministic id
(`variant="embedded"`). The revision it succeeds stays in the history, the
result's legacy snapshot is rebuilt to pin the successor, and the map view
follows. An authored head is never replaced by an import.

Consolidated v1 nodes are imported as they were published, marked by their
candidate ids. Their pre-consolidation candidates are not reconstructed: v1
drops saved extractions when it publishes, and nothing is fabricated.

A repeat run finds every revision present with the reference it should carry,
so it writes nothing. Run inside the dev container:

    uv run python -m dembrane.analysis.backfill [--project <id>] [--dry-run]
"""

from __future__ import annotations

import sys
import json
import asyncio
import logging
import argparse
from typing import Any
from dataclasses import field, asdict, dataclass

from dembrane.analysis.types import ARGUMENT
from dembrane.analysis.hashing import HASH_VERSION, content_hash
from dembrane.analysis.map_view import (
    LEGACY_VIEW_ID,
    VIEW_SCOPE_KEY,
    PAYLOAD_VERSION,
    LEGACY_RECIPE_ID,
    ResultLink,
    MapViewReads,
    SqlMapViewReads,
    advance_map_view,
    legacy_object_id,
    legacy_lineage_key,
    legacy_revision_id,
)
from dembrane.analysis.contracts import (
    Origin,
    Snapshot,
    ScopeKind,
    SourceRef,
    NewSnapshot,
    AnalysisStore,
    ObjectRevision,
    SnapshotConflict,
)
from dembrane.analysis.revisions import RevisionService
from dembrane.analysis.snapshots import SNAPSHOT_MANIFEST_VERSION

logger = logging.getLogger("dembrane.analysis.backfill")

RETRIES = 3
# The successor revision that carries a vector an earlier import could not.
EMBEDDED_VARIANT = "embedded"
PROJECTION_VERSION = ARGUMENT.map.projection_version if ARGUMENT.map else ""


@dataclass
class BackfillReport:
    projects: int = 0
    results_seen: int = 0
    results_imported: int = 0
    results_already_imported: int = 0
    results_unreadable: int = 0
    results_relinked: int = 0
    nodes_seen: int = 0
    consolidated_nodes: int = 0
    revisions_written: int = 0
    revisions_repaired: int = 0
    revisions_shared: int = 0
    revisions_already_present: int = 0
    embedding_refs_attached: int = 0
    arguments_without_vector: int = 0
    authored_heads_kept: int = 0
    legacy_snapshots_written: int = 0
    map_views_advanced: int = 0
    unreadable: list[str] = field(default_factory=list)


def argument_payload(argument: dict[str, Any]) -> dict[str, Any]:
    return {
        "statement": argument["statement"],
        "epistemicKind": argument["kind"],
        "valence": argument.get("valence"),
        "evidence": [
            {
                "conversationId": item["conversation_id"],
                "label": item.get("label") or None,
                "createdAt": item.get("created_at"),
                "quotes": list(item.get("quotes") or []),
            }
            for item in argument.get("evidence") or []
        ],
    }


def source_refs(argument: dict[str, Any]) -> list[SourceRef]:
    return [
        SourceRef(conversation_id=str(item["conversation_id"]), quote=str(quote))
        for item in argument.get("evidence") or []
        for quote in item.get("quotes") or []
    ]


def embedding_refs_for(argument: dict[str, Any], config: dict[str, Any]) -> dict[str, Any] | None:
    """The vector v1 already saved for this statement, by reference. An
    imported argument's projection text is exactly the text Map embedded, so
    this row is the one Map wrote for it; nothing is computed here. None when
    the result saved no vector or names no configuration."""
    embedding_id, key = argument.get("embedding_id"), config.get("key")
    if not embedding_id or not key:
        return None
    return {
        "embeddingId": str(embedding_id),
        "inputHash": argument.get("input_hash"),
        "configKey": str(key),
        "projectionVersion": PROJECTION_VERSION,
    }


def _same_reference(one: dict[str, Any] | None, other: dict[str, Any] | None) -> bool:
    return str((one or {}).get("embeddingId") or "") == str((other or {}).get("embeddingId") or "")


def legacy_scope_key(result_id: str) -> str:
    """Each imported result keeps its own `map.legacy` view, so importing one
    result again never rewrites another's snapshot."""
    return f"result:{result_id}"


async def _publish_legacy_snapshot(
    project_id: str, result_id: str, manifest: dict[str, Any], *, store: AnalysisStore
) -> tuple[Snapshot, bool]:
    for attempt in range(RETRIES):
        scope = await store.ensure_scope(
            project_id=project_id,
            kind=ScopeKind.VIEW,
            owner_id=LEGACY_VIEW_ID,
            scope_key=legacy_scope_key(result_id),
        )
        expected = scope.current_snapshot_id
        previous = await store.get_snapshot(expected) if expected else None
        if previous is not None and previous.content_hash == manifest["contentHash"]:
            return previous, False
        try:
            snapshot = await store.publish_snapshot(
                NewSnapshot(
                    project_id=project_id,
                    scope_id=scope.id,
                    view_id=LEGACY_VIEW_ID,
                    manifest=manifest,
                    content_hash=manifest["contentHash"],
                    manifest_version=SNAPSHOT_MANIFEST_VERSION,
                    versions=dict(manifest["versions"]),
                    embedding_config=manifest.get("embeddingConfig"),
                ),
                expected_previous_id=expected,
            )
            return snapshot, True
        except SnapshotConflict:
            if attempt == RETRIES - 1:
                raise
    raise AssertionError("unreachable")


def _legacy_manifest(
    row: dict[str, Any],
    recipe_version: str | None,
    config: dict[str, Any],
    nodes: dict[str, str],
    objects: list[dict[str, str]],
) -> dict[str, Any]:
    body = {
        "version": SNAPSHOT_MANIFEST_VERSION,
        "hashVersion": HASH_VERSION,
        "view": {"id": LEGACY_VIEW_ID, "scopeKey": legacy_scope_key(str(row["id"]))},
        "producers": [
            {
                "recipeId": LEGACY_RECIPE_ID,
                "scopeKey": VIEW_SCOPE_KEY,
                "runId": None,
                "recipeVersion": recipe_version,
                "legacyResultId": row["id"],
                "available": True,
            }
        ],
        "objects": sorted(objects, key=lambda o: o["objectId"]),
        "relations": [],
        "assessments": [],
        "stale": [],
        "historicalRelations": [],
        "embeddingConfig": {"key": config.get("key"), "model": config.get("model"), "dims": config.get("dims")}
        if config.get("key")
        else None,
        "settings": {},
        "versions": {"mapPayload": PAYLOAD_VERSION},
        "legacy": {
            "resultId": row["id"],
            "recipeVersion": recipe_version,
            "sourceFingerprint": row.get("source_fingerprint"),
            "nodes": dict(sorted(nodes.items())),
            "stats": (row.get("manifest") or {}).get("stats") or {},
            "consolidation": (row.get("manifest") or {}).get("consolidation") or {},
            # v1 kept no assessment history; today's verdicts are not substituted.
            "incomplete": ["assessments"],
        },
    }
    return {**body, "contentHash": content_hash(body)}


async def import_result(
    row: dict[str, Any],
    *,
    store: AnalysisStore,
    reads: MapViewReads,
    report: BackfillReport,
    dry_run: bool = False,
) -> Snapshot | None:
    """Import one ready v1 result, attaching the vectors it saved, and pin the
    result in a `map.legacy` snapshot. Safe to repeat: an unchanged result
    writes nothing, and one imported without references gains them."""
    project_id = str(row["project_id"])
    manifest = row.get("manifest") or {}
    config = row.get("embedding_config") or {}
    recipe_version = row.get("recipe_version") or manifest.get("recipe_version")
    arguments = list(manifest.get("arguments") or [])
    revisions = RevisionService(store)

    lineages = {str(a["id"]): legacy_lineage_key(str(a["id"])) for a in arguments}
    heads = await reads.lineage_heads(project_id, "argument", sorted(set(lineages.values())))
    head_ids = [head.revision_id for head in heads.values() if head.revision_id]
    head_revisions = await store.get_revisions(project_id, head_ids) if head_ids else {}
    candidates = [
        legacy_revision_id(row["id"], node_id, variant=variant)
        for node_id in lineages
        for variant in ("", EMBEDDED_VARIANT)
    ]
    known = await store.get_revisions(project_id, candidates) if candidates else {}

    nodes: dict[str, str] = {}
    objects: list[dict[str, str]] = []
    for argument in arguments:
        report.nodes_seen += 1
        node_id = str(argument["id"])
        if len(argument.get("candidate_ids") or []) > 1:
            report.consolidated_nodes += 1
        refs = embedding_refs_for(argument, config)
        if refs is None:
            report.arguments_without_vector += 1
        lineage = lineages[node_id]
        entry = heads.get(lineage)
        head: ObjectRevision | None = head_revisions.get(entry.revision_id or "") if entry else None
        if head is not None and head.provenance.origin == Origin.AUTHORED:
            # An authored head is never replaced by an import.
            report.authored_heads_kept += 1
            nodes[node_id] = head.id
            objects.append({"objectId": head.object_id, "revisionId": head.id, "type": "argument"})
            continue

        first = legacy_revision_id(row["id"], node_id)
        existing = known.get(first)
        revision_id = first
        repair = False
        if existing is not None and refs is not None and not _same_reference(existing.embedding_refs, refs):
            revision_id = legacy_revision_id(row["id"], node_id, variant=EMBEDDED_VARIANT)
            repair = known.get(revision_id) is None
        if dry_run:
            if existing is None:
                report.revisions_written += 1
            elif repair:
                report.revisions_repaired += 1
            else:
                report.revisions_already_present += 1
            nodes[node_id] = revision_id
            continue

        revision = await revisions.import_revision(
            project_id=project_id,
            type_id="argument",
            lineage_key=lineage,
            payload=argument_payload(argument),
            import_key=f"map_result:{row['id']}:node:{node_id}",
            source_refs=source_refs(argument),
            recipe_id=LEGACY_RECIPE_ID,
            recipe_version=recipe_version,
            revision_id=revision_id,
            embedding_refs=refs,
            # A lineage that already has an object keeps the id it was created under.
            object_id=None if entry else legacy_object_id(node_id),
            extra={
                "legacyResultId": row["id"],
                "legacyNodeId": node_id,
                "legacyCandidateIds": list(argument.get("candidate_ids") or []),
                "legacyClaimKey": argument.get("claim_key"),
                "legacyEmbeddingId": argument.get("embedding_id"),
                "legacyInputHash": argument.get("input_hash"),
                "embeddingConfigKey": config.get("key"),
            },
        )
        if revision.id != revision_id:
            # The object's head already says exactly this, with this vector.
            report.revisions_shared += 1 if revision.id != first else 0
            report.revisions_already_present += 1 if revision.id == first else 0
        elif repair:
            report.revisions_repaired += 1
            report.embedding_refs_attached += 1
        elif existing is None:
            report.revisions_written += 1
            report.embedding_refs_attached += 1 if revision.embedding_refs else 0
        else:
            report.revisions_already_present += 1
        nodes[node_id] = revision.id
        objects.append({"objectId": revision.object_id, "revisionId": revision.id, "type": "argument"})

    if dry_run:
        return None
    snapshot, written = await _publish_legacy_snapshot(
        project_id, str(row["id"]), _legacy_manifest(row, recipe_version, config, nodes, objects), store=store
    )
    if written:
        report.legacy_snapshots_written += 1
    return snapshot


async def run_backfill(
    *,
    store: AnalysisStore,
    reads: MapViewReads,
    map_store: Any,
    project_id: str | None = None,
    dry_run: bool = False,
) -> BackfillReport:
    """Import every ready v1 result, attach the vectors of any imported before
    references could be carried, then advance each project's map view.
    `map_store` reads the full rows (Map's store)."""
    report = BackfillReport()
    links = await reads.legacy_results(project_id)
    projects: dict[str, list[ResultLink]] = {}
    for link in links:
        projects.setdefault(link.project_id, []).append(link)
    report.projects = len(projects)
    for pid, rows in projects.items():
        for link in rows:
            report.results_seen += 1
            row = await map_store.get_result(link.id)
            if not row or not isinstance(row.get("manifest"), dict):
                report.results_unreadable += 1
                report.unreadable.append(link.id)
                continue
            before = (report.revisions_written, report.revisions_repaired)
            snapshot = await import_result(row, store=store, reads=reads, report=report, dry_run=dry_run)
            wrote = (report.revisions_written, report.revisions_repaired) != before
            if link.snapshot_id and not wrote:
                report.results_already_imported += 1
            else:
                report.results_imported += 1
            if snapshot is not None and await reads.link_legacy_snapshot(link.id, snapshot.id) and link.snapshot_id:
                report.results_relinked += 1
        if dry_run:
            continue
        scope = await store.find_scope(
            project_id=pid, kind=ScopeKind.VIEW, owner_id="map", scope_key=VIEW_SCOPE_KEY
        )
        before_snapshot = scope.current_snapshot_id if scope else None
        snapshot = await advance_map_view(pid, store=store, reads=reads)
        if snapshot is not None and snapshot.id != before_snapshot:
            report.map_views_advanced += 1
    return report


async def _main(argv: list[str]) -> int:
    from dembrane.map.store import SqlMapStore
    from dembrane.analysis.store import SqlAnalysisStore

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", default=None, help="only this project's results")
    parser.add_argument("--dry-run", action="store_true", help="count what would be written")
    args = parser.parse_args(argv)
    report = await run_backfill(
        store=SqlAnalysisStore(),
        reads=SqlMapViewReads(),
        map_store=SqlMapStore(),
        project_id=args.project,
        dry_run=args.dry_run,
    )
    print(json.dumps(asdict(report), indent=2))
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sys.exit(asyncio.run(_main(sys.argv[1:])))
