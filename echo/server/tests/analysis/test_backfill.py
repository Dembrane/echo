"""Backfill of v1 Map results: deterministic ids, the vectors v1 saved attached
by reference, identical content sharing a revision, no fabricated candidates,
a repair for imports written before references could be carried, an authored
head left alone, a repeat that writes nothing, and old results rendered
through the v2 map view."""

from __future__ import annotations

from typing import Any

import pytest

import dembrane.analysis.backfill as backfill
from dembrane.map import service
from tests.map_fakes import PROJECT, ready_result, manifest_argument
from dembrane.analysis.budgets import Ceilings, resolve_budgets
from dembrane.analysis.backfill import (
    EMBEDDED_VARIANT,
    source_refs,
    run_backfill,
    argument_payload,
    embedding_refs_for,
)
from dembrane.analysis.map_view import (
    LEGACY_VIEW_ID,
    LEGACY_RECIPE_ID,
    GraphQuery,
    claim_of,
    graph_payload,
    legacy_object_id,
    legacy_lineage_key,
    legacy_revision_id,
)
from dembrane.analysis.contracts import Origin
from dembrane.analysis.revisions import RevisionService
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
            manifest_argument(
                "a-3",
                "The tram line cost 400 million euros.",
                kind="claim",
                valence="neutral",
                quotes=["it cost 400 million", "four hundred million euros"],
            ),
            manifest_argument("a-5", "Cycling lanes come first."),
        ],
    )
    # The embeddings v1 saved, readable by the analysis store as they are in SQL.
    maps.store.embeddings.update({key: dict(row) for key, row in maps.map_store.embeddings.items()})
    return first, second


def _arguments(row: dict[str, Any]) -> list[dict[str, Any]]:
    return list(row["manifest"]["arguments"])


@pytest.mark.asyncio
async def test_backfill_attaches_the_saved_vectors_and_a_repeat_changes_nothing() -> None:
    maps = MapWorld()
    first, second = await _two_results(maps)

    report = await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)

    assert (report.results_imported, report.nodes_seen, report.consolidated_nodes) == (2, 7, 2)
    # a-1 is identical in both results and shares its revision; a-3's evidence changed.
    assert (report.revisions_written, report.revisions_shared, report.revisions_repaired) == (6, 1, 0)
    assert (report.embedding_refs_attached, report.arguments_without_vector) == (6, 0)
    assert report.legacy_snapshots_written == 2 and report.map_views_advanced == 1

    for node in ("a-1", "a-2", "a-3", "a-4"):
        revision = maps.store.revisions[legacy_revision_id(first["id"], node)]
        argument = next(a for a in _arguments(first) if a["id"] == node)
        assert revision.embedding_refs == embedding_refs_for(argument, CONFIG)
        assert revision.embedding_refs["embeddingId"] == argument["embedding_id"]  # type: ignore[index]
        assert revision.object_id == legacy_object_id(node)
        assert maps.store.objects[revision.object_id].lineage_key == legacy_lineage_key(node)

    legacy_second = maps.store.snapshots[maps.reads.links[second["id"]]["snapshot_id"]]
    nodes = legacy_second.manifest["legacy"]["nodes"]
    assert nodes["a-1"] == legacy_revision_id(first["id"], "a-1")
    assert nodes["a-3"] == legacy_revision_id(second["id"], "a-3") and nodes["a-5"] == legacy_revision_id(second["id"], "a-5")
    assert legacy_second.view_id == LEGACY_VIEW_ID and legacy_second.manifest["legacy"]["incomplete"] == ["assessments"]
    assert legacy_second.manifest["assessments"] == []

    revised = maps.store.revisions[nodes["a-3"]]
    assert revised.revision_number == 2 and revised.parent_revision_id == legacy_revision_id(first["id"], "a-3")
    assert revised.provenance.origin == Origin.IMPORTED and revised.provenance.recipe_id == LEGACY_RECIPE_ID
    assert revised.provenance.recipe_version == first["recipe_version"]
    assert revised.provenance.extra["legacyResultId"] == second["id"] and revised.provenance.extra["legacyNodeId"] == "a-3"
    # The claim keeps Map's claim key, so its saved check state still applies.
    assert claim_of(revised)[2] == _arguments(second)[1]["claim_key"]  # type: ignore[index]
    # Consolidated nodes are imported as published; no candidate is invented.
    assert len([r for r in maps.store.revisions.values() if r.type == "argument"]) == 6
    assert maps.store.revisions[nodes["a-1"]].provenance.extra["legacyCandidateIds"] == ["c-1", "c-1b"]

    counts = (len(maps.store.revisions), len(maps.store.objects), len(maps.store.snapshots), len(maps.map_store.results))
    repeat = await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)
    assert (repeat.results_imported, repeat.results_already_imported) == (0, 2)
    assert (repeat.revisions_written, repeat.revisions_repaired, repeat.map_views_advanced) == (0, 0, 0)
    assert (len(maps.store.revisions), len(maps.store.objects), len(maps.store.snapshots), len(maps.map_store.results)) == counts


@pytest.mark.asyncio
async def test_a_rerun_attaches_the_vectors_an_earlier_import_could_not_carry(monkeypatch: pytest.MonkeyPatch) -> None:
    maps = MapWorld()
    first, second = await _two_results(maps)
    # The earlier backfill: imports without references.
    monkeypatch.setattr(backfill, "embedding_refs_for", lambda _argument, _config: None)
    before = await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)
    assert before.embedding_refs_attached == 0
    assert all(r.embedding_refs is None for r in maps.store.revisions.values() if r.type == "argument")
    old_snapshot = maps.reads.links[second["id"]]["snapshot_id"]
    old_view = maps.current()
    monkeypatch.undo()

    report = await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)

    # A published revision is immutable, so the vector arrives as a successor.
    assert (report.revisions_repaired, report.embedding_refs_attached) == (6, 6)
    assert (report.revisions_written, report.results_imported, report.results_relinked) == (0, 2, 2)
    assert report.legacy_snapshots_written == 2 and report.map_views_advanced == 1
    for node in ("a-1", "a-2", "a-3", "a-4"):
        original = maps.store.revisions[legacy_revision_id(first["id"], node)]
        repaired = maps.store.revisions[legacy_revision_id(first["id"], node, variant=EMBEDDED_VARIANT)]
        argument = next(a for a in _arguments(first) if a["id"] == node)
        # The revision that could not carry a vector stays, as history.
        assert original.embedding_refs is None and repaired.embedding_refs == embedding_refs_for(argument, CONFIG)
        assert repaired.object_id == original.object_id and repaired.revision_number > original.revision_number
        head = maps.store.revisions[str(maps.store.objects[original.object_id].current_revision_id)]
        assert head.embedding_refs is not None
    # A node only this result carried succeeds its own revision; a-3 changed in
    # the second result, so the head it succeeds is that one.
    only_here = maps.store.revisions[legacy_revision_id(first["id"], "a-2", variant=EMBEDDED_VARIANT)]
    assert only_here.parent_revision_id == legacy_revision_id(first["id"], "a-2")
    changed = maps.store.revisions[legacy_revision_id(second["id"], "a-3", variant=EMBEDDED_VARIANT)]
    assert maps.store.objects[changed.object_id].current_revision_id == changed.id

    # The result now names the snapshot that pins the repaired revisions.
    assert maps.reads.links[second["id"]]["snapshot_id"] != old_snapshot
    view = maps.current()
    assert view.id != old_view.id and view.parent_snapshot_id == old_view.id
    payload = await graph_payload(view, GraphQuery(types=None, scope=None, budgets=resolve_budgets(ceilings=Ceilings())), store=maps.store)
    assert payload["unplaced"] == [] and all(node["embedding"] for node in payload["nodes"])

    counts = (len(maps.store.revisions), len(maps.store.snapshots))
    again = await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)
    assert (again.revisions_repaired, again.revisions_written, again.results_relinked) == (0, 0, 0)
    assert (again.results_already_imported, again.map_views_advanced) == (2, 0)
    assert (len(maps.store.revisions), len(maps.store.snapshots)) == counts


@pytest.mark.asyncio
async def test_an_authored_head_is_never_replaced_by_a_rerun(monkeypatch: pytest.MonkeyPatch) -> None:
    maps = MapWorld()
    first, _second = await _two_results(maps)
    monkeypatch.setattr(backfill, "embedding_refs_for", lambda _argument, _config: None)
    await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)
    monkeypatch.undo()
    imported = maps.store.revisions[legacy_revision_id(first["id"], "a-2")]
    edited = await RevisionService(maps.store).author_edit(
        project_id=PROJECT,
        object_id=imported.object_id,
        expected_revision_id=imported.id,
        payload={**imported.payload, "statement": "Trams cost far too much to build."},
        actor_id="du1",
        reason="wording",
    )

    report = await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)

    assert report.authored_heads_kept == 1
    assert maps.store.objects[imported.object_id].current_revision_id == edited.id
    assert legacy_revision_id(first["id"], "a-2", variant=EMBEDDED_VARIANT) not in maps.store.revisions
    legacy = maps.store.snapshots[maps.reads.links[first["id"]]["snapshot_id"]]
    assert legacy.manifest["legacy"]["nodes"]["a-2"] == edited.id


@pytest.mark.asyncio
async def test_old_results_render_through_the_v2_map_view_and_keep_their_urls() -> None:
    maps = MapWorld()
    first, second = await _two_results(maps)
    await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)
    snapshot = maps.current()

    payload = await graph_payload(snapshot, GraphQuery(types=None, scope=None, budgets=resolve_budgets(ceilings=Ceilings())), store=maps.store)

    # The newest result is the map.
    assert sorted(node["label"] for node in payload["nodes"]) == [
        "Cycling lanes come first.",
        "The tram line cost 400 million euros.",
        "Trams are quieter than buses.",
    ]
    assert all(node["provenance"]["origin"] == "imported" and node["provenance"]["recipeId"] == LEGACY_RECIPE_ID for node in payload["nodes"])
    assert payload["unplaced"] == [] and payload["embedding"] == CONFIG
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


@pytest.mark.asyncio
async def test_an_import_without_a_saved_vector_is_counted_and_still_imported() -> None:
    maps = MapWorld()
    row = await _result(maps, [manifest_argument("a-1", "Trams are quieter than buses.")])
    maps.map_store.results[row["id"]]["embedding_config"] = None
    argument = _arguments(row)[0]

    report = await run_backfill(store=maps.store, reads=maps.reads, map_store=maps.map_store)

    assert (report.arguments_without_vector, report.embedding_refs_attached) == (1, 0)
    assert embedding_refs_for(argument, {}) is None
    revision = maps.store.revisions[legacy_revision_id(row["id"], "a-1")]
    assert revision.embedding_refs is None and revision.payload == argument_payload(argument)
    assert list(revision.provenance.source_refs) == source_refs(argument)
