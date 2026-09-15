"""Backfill of v1 Map results: deterministic ids, shared identical revisions,
legacy provenance, no fabricated candidates, a repeat that writes nothing, and
old results rendered through the v2 map view."""

from __future__ import annotations

from typing import Any

import pytest

from dembrane.map import service
from tests.map_fakes import ready_result, manifest_argument
from dembrane.analysis.budgets import Ceilings, resolve_budgets
from dembrane.analysis.backfill import run_backfill
from dembrane.analysis.map_view import (
    LEGACY_VIEW_ID,
    LEGACY_RECIPE_ID,
    GraphQuery,
    claim_of,
    graph_payload,
    legacy_lineage_key,
    legacy_revision_id,
)
from dembrane.analysis.contracts import Origin
from tests.analysis.map_v2_fakes import MapWorld

CONFIG = {"key": "fake-config", "model": "fake/embedding-model", "dims": 4}


async def _result(maps: MapWorld, arguments: list[dict[str, Any]]) -> dict[str, Any]:
    row = await ready_result(maps.map_store, arguments)
    maps.map_store.results[row["id"]]["embedding_config"] = dict(CONFIG)
    return maps.map_store.results[row["id"]]


async def _two_results(maps: MapWorld) -> tuple[dict[str, Any], dict[str, Any]]:
    consolidated = manifest_argument("a-1", "Trams are quieter than buses.")
    consolidated["candidate_ids"] = ["c-1", "c-1b"]
    first = await _result(
        maps,
        [
            consolidated,
            manifest_argument("a-2", "Trams cost too much to build.", valence="negative"),
            manifest_argument("a-3", "The tram line cost 400 million euros.", kind="claim", valence="neutral"),
            manifest_argument("a-4", "Buses reach more neighbourhoods."),
        ],
    )
    unchanged = manifest_argument("a-1", "Trams are quieter than buses.")
    unchanged["candidate_ids"] = ["c-1", "c-1b"]
    second = await _result(
        maps,
        [
            unchanged,
            manifest_argument("a-3", "The tram line cost 400 million euros.", kind="claim", valence="neutral", quotes=["it cost 400 million", "four hundred million euros"]),
            manifest_argument("a-5", "Cycling lanes come first."),
        ],
    )
    # The embeddings v1 saved, readable by the analysis store as they are in SQL.
    maps.store.embeddings.update({key: dict(row) for key, row in maps.map_store.embeddings.items()})
    return first, second


@pytest.mark.asyncio
async def test_backfill_imports_v1_results_deterministically_and_a_repeat_changes_nothing() -> None:
    maps = MapWorld()
    first, second = await _two_results(maps)

    report = await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)

    assert (report.results_imported, report.nodes_seen, report.consolidated_nodes) == (2, 7, 2)
    # a-1 is identical in both results and shares its revision; a-3's evidence changed.
    assert (report.revisions_written, report.revisions_shared, report.revisions_already_present) == (6, 1, 0)
    assert report.legacy_snapshots_written == 2 and report.map_views_advanced == 1
    for node in ("a-1", "a-2", "a-3", "a-4"):
        assert legacy_revision_id(first["id"], node) in maps.store.revisions
    legacy_second = maps.store.snapshots[maps.reads.links[second["id"]]["snapshot_id"]]
    nodes = legacy_second.manifest["legacy"]["nodes"]
    assert nodes["a-1"] == legacy_revision_id(first["id"], "a-1")
    assert nodes["a-3"] == legacy_revision_id(second["id"], "a-3") and nodes["a-5"] == legacy_revision_id(second["id"], "a-5")
    assert legacy_second.view_id == LEGACY_VIEW_ID and legacy_second.manifest["legacy"]["incomplete"] == ["assessments"]
    assert legacy_second.manifest["assessments"] == []

    revised = maps.store.revisions[nodes["a-3"]]
    assert revised.revision_number == 2 and revised.parent_revision_id == legacy_revision_id(first["id"], "a-3")
    record = maps.store.objects[revised.object_id]
    assert record.lineage_key == legacy_lineage_key("a-3") and record.current_revision_id == revised.id
    assert revised.provenance.origin == Origin.IMPORTED and revised.provenance.recipe_id == LEGACY_RECIPE_ID
    assert revised.provenance.recipe_version == first["recipe_version"]
    assert revised.provenance.extra["legacyResultId"] == second["id"] and revised.provenance.extra["legacyNodeId"] == "a-3"
    # The claim keeps Map's claim key, so its saved check state still applies.
    assert claim_of(revised)[2] == second["manifest"]["arguments"][1]["claim_key"]  # type: ignore[index]
    # Consolidated nodes are imported as published; no candidate is invented.
    assert len([r for r in maps.store.revisions.values() if r.type == "argument"]) == 6
    assert maps.store.revisions[nodes["a-1"]].provenance.extra["legacyCandidateIds"] == ["c-1", "c-1b"]

    counts = (len(maps.store.revisions), len(maps.store.objects), len(maps.store.snapshots), len(maps.map_store.results))
    repeat = await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)
    assert (repeat.results_imported, repeat.results_already_imported, repeat.revisions_written, repeat.map_views_advanced) == (0, 2, 0, 0)
    assert (len(maps.store.revisions), len(maps.store.objects), len(maps.store.snapshots), len(maps.map_store.results)) == counts


@pytest.mark.asyncio
async def test_old_results_render_through_the_v2_map_view_and_keep_their_urls() -> None:
    maps = MapWorld()
    first, second = await _two_results(maps)
    await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)
    snapshot = maps.current()

    payload = await graph_payload(snapshot, GraphQuery(types=None, scope=None, budgets=resolve_budgets(ceilings=Ceilings())), store=maps.store)

    # The newest result is the map.
    assert sorted(node["label"] for node in payload["nodes"]) == ["Cycling lanes come first.", "The tram line cost 400 million euros.", "Trams are quieter than buses."]
    assert all(node["provenance"]["origin"] == "imported" and node["provenance"]["recipeId"] == LEGACY_RECIPE_ID for node in payload["nodes"])
    assert payload["unplaced"] == [] and payload["embedding"] == {"key": "fake-config", "model": "fake/embedding-model", "dims": 4}
    (legacy,) = [p for p in snapshot.manifest["producers"] if p["recipeId"] == LEGACY_RECIPE_ID]
    assert legacy["legacyResultId"] == second["id"]
    scoped = await graph_payload(
        snapshot, GraphQuery(types=None, scope=LEGACY_RECIPE_ID, budgets=resolve_budgets(ceilings=Ceilings())), store=maps.store
    )
    assert scoped["counts"]["argument"] == 3 and scoped["scope"]["resultScope"] == LEGACY_RECIPE_ID

    # v1 URLs keep answering from their own manifests; the v2 row names the snapshot.
    assert await service.resolve_target(first["id"], store=maps.map_store, analysis_store=maps.store) == await maps.map_store.get_result(first["id"])
    (v2_row,) = maps.reads.v2_results()
    target = await service.resolve_target(v2_row, store=maps.map_store, analysis_store=maps.store)
    assert isinstance(target, service.SnapshotTarget) and target.snapshot.id == snapshot.id and target.result_id == v2_row
