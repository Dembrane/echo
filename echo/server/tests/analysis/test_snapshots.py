"""View snapshots against the in-memory store."""

from __future__ import annotations

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import RunRequest, execute_inline
from dembrane.analysis.contracts import RunStatus, SnapshotConflict
from dembrane.analysis.snapshots import (
    ProducerRef,
    SnapshotRequest,
    read_snapshot,
    resolve_snapshot,
    assemble_snapshot,
    following_view_hook,
)
from tests.analysis.fixture_recipes import PAIRS, WORDS, ASSESS, FixtureWorld

PROJECT = "11111111-1111-4111-8111-111111111111"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"


def _seed(world: FixtureWorld) -> None:
    world.sources[PROJECT] = {C1: ["Trams are better.", "Buses are cheaper."], C2: ["Bikes are healthy."]}


def _view(*recipes: str, **kwargs: object) -> SnapshotRequest:
    return SnapshotRequest(PROJECT, "map", "project", tuple(ProducerRef(r, "project") for r in recipes), **kwargs)  # type: ignore[arg-type]


async def _inline(store: FakeAnalysisStore, recipe: str, key: str, mode: str = "refresh") -> None:
    outcome = await execute_inline(RunRequest(PROJECT, recipe, "project", mode=mode, idempotency_key=key), store=store, deps=Recorder().deps())
    assert outcome.run.status == RunStatus.READY


@pytest.mark.asyncio
async def test_a_snapshot_shows_one_revision_per_object_and_lists_stale_support(world: FixtureWorld) -> None:
    _seed(world)
    store = FakeAnalysisStore()
    await _inline(store, PAIRS, "p1")
    first = await assemble_snapshot(_view(WORDS, PAIRS), store=store)
    assert len(first.manifest["objects"]) == 4 and len(first.manifest["relations"]) == 2 and first.manifest["stale"] == []

    # "Buses are cheaper." holds pole B; rewording it makes a newer revision
    # of the same argument, which the pinned tension never saw.
    world.sources[PROJECT][C1] = ["Trams are better.", "Buses are much cheaper."]
    await _inline(store, WORDS, "w2")
    second = await assemble_snapshot(_view(WORDS, PAIRS), store=store)

    assert second.parent_snapshot_id == first.id and len(second.manifest["objects"]) == 4
    assert [r["type"] for r in second.manifest["relations"]] == ["supports_pole_a"]
    # The tension's pole B edge, and the pairs output that pinned the old argument.
    kinds = sorted(s["kind"] for s in second.manifest["stale"])
    assert kinds == ["output", "relation"]
    shown = {o["revisionId"] for o in second.manifest["objects"]}
    assert all(s["displayedRevisionId"] in shown and s["pinnedRevisionId"] not in shown for s in second.manifest["stale"])

    # The earlier snapshot still reconstructs what it showed.
    contents = await read_snapshot(first, store=store)
    assert {r.payload.get("statement") for r in contents.revisions.values()} >= {"Buses are cheaper."}
    assert len(contents.relations) == 2 and contents.missing == ()
    assert (await resolve_snapshot(store=store, project_id=PROJECT, view_id="map", scope_key="project")).id == second.id  # type: ignore[union-attr]
    assert await resolve_snapshot(store=store, project_id="22222222-2222-4222-8222-222222222222", snapshot_id=first.id) is None


@pytest.mark.asyncio
async def test_identical_content_returns_the_current_snapshot_and_a_stale_expectation_conflicts(world: FixtureWorld) -> None:
    _seed(world)
    store = FakeAnalysisStore()
    await _inline(store, WORDS, "w1")
    first = await assemble_snapshot(_view(WORDS), store=store)
    assert (await assemble_snapshot(_view(WORDS), store=store)).id == first.id
    with pytest.raises(SnapshotConflict):
        await assemble_snapshot(_view(WORDS, settings={"colorBy": "type"}), store=store, expected_previous_id=None)
    changed = await assemble_snapshot(_view(WORDS, settings={"colorBy": "type"}), store=store)
    assert changed.id != first.id and changed.settings == {"colorBy": "type"}


@pytest.mark.asyncio
async def test_assessments_are_pinned_and_a_recheck_makes_a_successor(world: FixtureWorld) -> None:
    _seed(world)
    world.claims = {"Buses are cheaper."}
    store = FakeAnalysisStore()
    await _inline(store, ASSESS, "a1")
    first = await assemble_snapshot(_view(WORDS), store=store)
    (pinned,) = first.manifest["assessments"]

    world.verdict = "false"
    await _inline(store, ASSESS, "a2", mode="regenerate")
    second = await assemble_snapshot(_view(WORDS), store=store)
    (latest,) = second.manifest["assessments"]
    assert latest["targetRevisionId"] == pinned["targetRevisionId"] and latest["revisionId"] != pinned["revisionId"]
    assert second.parent_snapshot_id == first.id

    target = pinned["targetRevisionId"]
    assert (await read_snapshot(first, store=store)).assessments[target].payload["verdict"] == "true"
    assert (await read_snapshot(second, store=store)).assessments[target].payload["verdict"] == "false"


@pytest.mark.asyncio
async def test_a_following_view_records_its_source_event_and_assembles_once(world: FixtureWorld) -> None:
    _seed(world)
    store = FakeAnalysisStore()
    await _inline(store, WORDS, "w1")
    (event,) = [e for e in store.outbox.values() if e.event_type == "run_published"]
    hook = following_view_hook(recipe_ids=frozenset({WORDS}), build_request=lambda _e: _view(WORDS))

    await hook(event, store)
    await hook(event, store)  # repeated after a crash before the consumer marker
    (snapshot,) = store.snapshots.values()
    assert snapshot.source_event_id == event.id
    await hook(event.__class__(**{**event.__dict__, "payload": {"recipeId": PAIRS}}), store)
    assert len(store.snapshots) == 1
