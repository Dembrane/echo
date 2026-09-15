"""Import ready v1 Map results into analysis objects, without a model call.

For every ready v1 `map_result` not imported yet (its `snapshot_id` is the
watermark), oldest first per project:

1. Each node becomes a published `argument` revision through the revision
   service's import path. The object's lineage key comes from the node id,
   which v1 kept for one statement and kind across its results; the revision id
   is a uuid5 of the result and node ids. Content and evidence identical to the
   object's head share that revision instead of writing another.
2. The provenance names the legacy recipe (`map.legacy_arguments` at the
   result's recipe version) and records the result, node, candidate ids and
   the v1 embedding row. The vector itself is reused by reference: an
   argument's projection text is exactly v1's embedding input, so the payload
   finds the stored row by (project, input hash, configuration).
3. The imported revisions are pinned in a `map.legacy` snapshot whose manifest
   maps each node id to its revision id and is labelled incomplete for
   assessments (v1 kept none as history, and today's verdicts are not
   substituted). The result row then names that snapshot.
4. Each project's map view is advanced, so old results render through v2.

Consolidated v1 nodes are imported as they were published, marked by their
candidate ids. Their pre-consolidation candidates are not reconstructed: v1
drops saved extractions when it publishes, and nothing is fabricated.

A repeat run finds every result watermarked and every revision id present, so
it writes nothing. Run inside the dev container:

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
    legacy_lineage_key,
    legacy_revision_id,
)
from dembrane.analysis.contracts import (
    Snapshot,
    ScopeKind,
    SourceRef,
    NewSnapshot,
    AnalysisStore,
    SnapshotConflict,
)
from dembrane.analysis.revisions import RevisionService
from dembrane.analysis.snapshots import SNAPSHOT_MANIFEST_VERSION

logger = logging.getLogger("dembrane.analysis.backfill")

RETRIES = 3


@dataclass
class BackfillReport:
    projects: int = 0
    results_seen: int = 0
    results_imported: int = 0
    results_already_imported: int = 0
    results_unreadable: int = 0
    nodes_seen: int = 0
    consolidated_nodes: int = 0
    revisions_written: int = 0
    revisions_shared: int = 0
    revisions_already_present: int = 0
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


async def _publish_legacy_snapshot(
    project_id: str, manifest: dict[str, Any], *, store: AnalysisStore
) -> tuple[Snapshot, bool]:
    for attempt in range(RETRIES):
        scope = await store.ensure_scope(
            project_id=project_id, kind=ScopeKind.VIEW, owner_id=LEGACY_VIEW_ID, scope_key=VIEW_SCOPE_KEY
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


async def import_result(
    row: dict[str, Any],
    *,
    store: AnalysisStore,
    reads: MapViewReads,
    report: BackfillReport,
) -> Snapshot:
    """Import one ready v1 result and watermark it. Safe to repeat."""
    project_id = str(row["project_id"])
    manifest = row.get("manifest") or {}
    config = row.get("embedding_config") or {}
    recipe_version = row.get("recipe_version") or manifest.get("recipe_version")
    revisions = RevisionService(store)
    nodes: dict[str, str] = {}
    objects: list[dict[str, str]] = []
    for argument in manifest.get("arguments") or []:
        report.nodes_seen += 1
        candidates = list(argument.get("candidate_ids") or [])
        if len(candidates) > 1:
            report.consolidated_nodes += 1
        fixed = legacy_revision_id(row["id"], argument["id"])
        present = fixed in await store.get_revisions(project_id, [fixed])
        revision = await revisions.import_revision(
            project_id=project_id,
            type_id="argument",
            lineage_key=legacy_lineage_key(argument["id"]),
            payload=argument_payload(argument),
            import_key=f"map_result:{row['id']}:node:{argument['id']}",
            source_refs=source_refs(argument),
            recipe_id=LEGACY_RECIPE_ID,
            recipe_version=recipe_version,
            revision_id=fixed,
            extra={
                "legacyResultId": row["id"],
                "legacyNodeId": argument["id"],
                "legacyCandidateIds": candidates,
                "legacyClaimKey": argument.get("claim_key"),
                "legacyEmbeddingId": argument.get("embedding_id"),
                "legacyInputHash": argument.get("input_hash"),
                "embeddingConfigKey": config.get("key"),
            },
        )
        if present:
            report.revisions_already_present += 1
        elif revision.id == fixed:
            report.revisions_written += 1
        else:
            report.revisions_shared += 1
        nodes[argument["id"]] = revision.id
        objects.append({"objectId": revision.object_id, "revisionId": revision.id, "type": "argument"})

    body = {
        "version": SNAPSHOT_MANIFEST_VERSION,
        "hashVersion": HASH_VERSION,
        "view": {"id": LEGACY_VIEW_ID, "scopeKey": VIEW_SCOPE_KEY},
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
            "stats": manifest.get("stats") or {},
            "consolidation": manifest.get("consolidation") or {},
            # v1 kept no assessment history; today's verdicts are not substituted.
            "incomplete": ["assessments"],
        },
    }
    snapshot, written = await _publish_legacy_snapshot(
        project_id, {**body, "contentHash": content_hash(body)}, store=store
    )
    if written:
        report.legacy_snapshots_written += 1
    await reads.link_legacy_snapshot(row["id"], snapshot.id)
    return snapshot


async def run_backfill(
    *,
    store: AnalysisStore,
    reads: MapViewReads,
    map_store: Any,
    project_id: str | None = None,
    dry_run: bool = False,
) -> BackfillReport:
    """Import every ready v1 result not imported yet, then advance each
    project's map view. `map_store` reads the full rows (Map's store)."""
    report = BackfillReport()
    links = await reads.legacy_results(project_id)
    projects: dict[str, list[ResultLink]] = {}
    for link in links:
        projects.setdefault(link.project_id, []).append(link)
    report.projects = len(projects)
    for pid, rows in projects.items():
        for link in rows:
            report.results_seen += 1
            if link.snapshot_id:
                report.results_already_imported += 1
                continue
            if dry_run:
                continue
            row = await map_store.get_result(link.id)
            if not row or not isinstance(row.get("manifest"), dict):
                report.results_unreadable += 1
                report.unreadable.append(link.id)
                continue
            await import_result(row, store=store, reads=reads, report=report)
            report.results_imported += 1
        if dry_run:
            continue
        scope = await store.find_scope(
            project_id=pid, kind=ScopeKind.VIEW, owner_id="map", scope_key=VIEW_SCOPE_KEY
        )
        before = scope.current_snapshot_id if scope else None
        snapshot = await advance_map_view(pid, store=store, reads=reads)
        if snapshot is not None and snapshot.id != before:
            report.map_views_advanced += 1
    return report


async def _main(argv: list[str]) -> int:
    from dembrane.map.store import SqlMapStore
    from dembrane.analysis.store import SqlAnalysisStore

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", default=None, help="only this project's results")
    parser.add_argument("--dry-run", action="store_true", help="count what would be imported")
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
