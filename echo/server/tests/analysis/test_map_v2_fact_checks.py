"""Fact-checks and titles by snapshot and revision: an assessment revision is
appended, the following view advances, a shared snapshot keeps its original
assessment, and titles are keyed by exact revisions."""

from __future__ import annotations

import uuid
from typing import Any

import pytest

import dembrane.map.model as map_model
import dembrane.map.events as map_events
import dembrane.api.v2.bff.map as map_bff
from dembrane.map import service
from tests.map_fakes import PROJECT, FakeAsyncRedis
from dembrane.map.recipe import SelectionTooSmall
from tests.analysis.helpers import Recorder
from dembrane.map.fact_check import ASSESSMENT_RECIPE_ID, run_fact_check
from dembrane.analysis.budgets import Ceilings, resolve_budgets
from dembrane.analysis.map_view import GraphQuery, graph_payload
from dembrane.analysis.contracts import Snapshot, ObjectRevision, RelationStatus, RevisionStatus
from dembrane.analysis.snapshots import read_snapshot
from tests.analysis.map_v2_fakes import READ, WRITE, Grants, Limiter, MapWorld, inline, asgi_call
from tests.analysis.fixture_recipes import PAIRS, WORDS, FixtureWorld

C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"
CLAIM = "Buses are cheaper."


class _Checker:
    def __init__(self, verdict: str) -> None:
        self.verdict = verdict
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"verdict": self.verdict, "justification": f"The fixture says {self.verdict}.", "sources": [{"url": "https://example.org", "title": "Example"}]}


async def _context(project_id: str) -> tuple[str, str]:  # noqa: ARG001
    return "Harbour", "Trams or buses."


async def _seeded(world: FixtureWorld, recipe: str = WORDS) -> tuple[MapWorld, Snapshot]:
    maps = MapWorld()
    world.sources[PROJECT] = {C1: ["Trams are better.", CLAIM], C2: ["Bikes are healthy."]}
    world.claims = {CLAIM}
    await inline(maps.store, recipe, "seed")
    return maps, await maps.advance()


def _by_statement(maps: MapWorld, statement: str) -> ObjectRevision:
    return next(
        r
        for r in maps.store.revisions.values()
        if r.status == RevisionStatus.PUBLISHED and r.payload.get("statement") == statement
    )


async def _check(maps: MapWorld, snapshot: Snapshot, revision_id: str, checker: _Checker, *, force: bool = False) -> str:
    jobs: list[tuple[Any, ...]] = []
    state = await service.start_snapshot_fact_check(
        service.SnapshotTarget(snapshot),
        revision_id,
        requested_by="du1",
        force=force,
        store=maps.map_store,
        analysis_store=maps.store,
        dispatch=lambda *job: jobs.append(job) or "msg",
    )
    assert state["status"] == "processing"
    (job,) = jobs
    assert job[2:] == (snapshot.id, revision_id)
    return await run_fact_check(
        *job,
        store=maps.map_store,
        check=checker,
        project_context=_context,
        publish=maps.publish,
        redis=FakeAsyncRedis(),
        analysis_store=maps.store,
        reads=maps.reads,
        executor_deps=Recorder().deps(),
    )


@pytest.fixture(autouse=True)
def _quiet(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _publish(project_id: str, event: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(service, "publish_map_event", _publish)
    monkeypatch.setattr(map_events, "publish_map_event", _publish)


@pytest.mark.asyncio
async def test_a_completed_check_appends_an_assessment_and_the_view_advances_past_the_old_snapshot(world: FixtureWorld) -> None:
    maps, first = await _seeded(world)
    claim = _by_statement(maps, CLAIM)
    checker = _Checker("false")

    assert await _check(maps, first, claim.id, checker) == "done"

    assert checker.calls[0]["statement"] == CLAIM and checker.calls[0]["evidence"] == [CLAIM]
    (assessment,) = [r for r in maps.store.revisions.values() if r.type == "fact_check_assessment"]
    assert assessment.status == RevisionStatus.PUBLISHED and assessment.payload["verdict"] == "false"
    assert assessment.provenance.recipe_id == ASSESSMENT_RECIPE_ID and assessment.provenance.input_revision_ids == (claim.id,)
    (relation,) = [r for r in maps.store.relations.values() if r.type == "assesses"]
    assert (relation.from_revision_id, relation.to_revision_id, relation.status) == (assessment.id, claim.id, RelationStatus.PUBLISHED)

    second = maps.current()
    assert second.parent_snapshot_id == first.id and second.source_event_id is not None
    assert second.manifest["assessments"] == [{"targetRevisionId": claim.id, "revisionId": assessment.id, "relationId": relation.id}]
    # The snapshot the check started from is untouched.
    assert first.manifest["assessments"] == [] and maps.store.snapshots[first.id].manifest == first.manifest
    assert "ready" in [e["type"] for _p, e in maps.events]
    assert any(link.get("snapshot_id") == second.id for link in maps.reads.links.values())

    states = await service.snapshot_fact_check_states(service.SnapshotTarget(second), store=maps.map_store, analysis_store=maps.store)
    assert states[claim.id]["verdict"] == "false" and states[claim.id]["assessmentRevisionId"] == assessment.id
    payload = await graph_payload(
        second, GraphQuery(types=("argument",), scope=None, budgets=resolve_budgets(ceilings=Ceilings())), store=maps.store
    )
    node = next(n for n in payload["nodes"] if n["revisionId"] == claim.id)
    assert node["factCheck"]["assessmentRevisionId"] == assessment.id


@pytest.mark.asyncio
async def test_a_recheck_after_sharing_leaves_the_shared_snapshot_on_its_original_assessment(world: FixtureWorld) -> None:
    maps, first = await _seeded(world)
    claim = _by_statement(maps, CLAIM)
    assert await _check(maps, first, claim.id, _Checker("false")) == "done"
    shared = maps.current()

    assert await _check(maps, shared, claim.id, _Checker("true"), force=True) == "done"

    earlier, later = sorted(
        (r for r in maps.store.revisions.values() if r.type == "fact_check_assessment"), key=lambda r: r.revision_number
    )
    assert earlier.object_id == later.object_id and later.parent_revision_id == earlier.id
    latest = maps.current()
    assert latest.parent_snapshot_id == shared.id
    assert (await read_snapshot(shared, store=maps.store)).assessments[claim.id].payload["verdict"] == "false"
    assert (await read_snapshot(latest, store=maps.store)).assessments[claim.id].payload["verdict"] == "true"
    target = service.SnapshotTarget
    assert (await service.snapshot_fact_check_states(target(shared), store=maps.map_store, analysis_store=maps.store))[claim.id]["verdict"] == "false"
    assert (await service.snapshot_fact_check_states(target(latest), store=maps.map_store, analysis_store=maps.store))[claim.id]["verdict"] == "true"


@pytest.mark.asyncio
async def test_snapshot_checks_refuse_what_the_snapshot_does_not_show_or_cannot_check(world: FixtureWorld) -> None:
    maps, snapshot = await _seeded(world)
    target = service.SnapshotTarget(snapshot)
    argument = _by_statement(maps, "Trams are better.")

    with pytest.raises(service.NotAClaim):
        await service.start_snapshot_fact_check(target, argument.id, requested_by="du1", force=False, store=maps.map_store, analysis_store=maps.store, dispatch=lambda *_job: "msg")
    with pytest.raises(service.UnknownArguments):
        await service.start_snapshot_fact_check(target, str(uuid.uuid4()), requested_by="du1", force=False, store=maps.map_store, analysis_store=maps.store, dispatch=lambda *_job: "msg")
    assert maps.map_store.fact_checks == {}

    # A job naming a revision the snapshot does not show fails without a model call.
    claim = _by_statement(maps, CLAIM)
    jobs: list[tuple[Any, ...]] = []
    await service.start_snapshot_fact_check(target, claim.id, requested_by="du1", force=False, store=maps.map_store, analysis_store=maps.store, dispatch=lambda *job: jobs.append(job) or "msg")
    checker = _Checker("true")
    (job,) = jobs
    outcome = await run_fact_check(job[0], job[1], job[2], argument.id, store=maps.map_store, check=checker, project_context=_context, redis=FakeAsyncRedis(), analysis_store=maps.store, reads=maps.reads)
    assert outcome == "error" and checker.calls == []


@pytest.mark.asyncio
async def test_titles_resolve_revisions_from_the_snapshot_and_are_keyed_by_them(world: FixtureWorld) -> None:
    maps, snapshot = await _seeded(world, PAIRS)
    tension = next(r for r in maps.store.revisions.values() if r.type == "tension")
    bikes, buses = _by_statement(maps, "Bikes are healthy."), _by_statement(maps, CLAIM)
    seen: list[list[str]] = []

    async def generate(*, lines: list[str], project_name: str, project_context: str) -> str:  # noqa: ARG001
        seen.append(lines)
        return "Bikes or buses"

    redis = FakeAsyncRedis()

    async def title(snap: Snapshot, ids: list[str]) -> dict[str, Any]:
        return await service.snapshot_selection_title(
            service.SnapshotTarget(snap), ids, project_name="Harbour", project_context="", analysis_store=maps.store, redis=redis, generate=generate
        )

    assert await title(snapshot, [tension.id, bikes.id, buses.id]) == {"title": "Bikes or buses", "cached": False}
    (lines,) = seen
    assert lines[0].startswith("1. [tension] Bikes are healthy. / Buses are cheaper.")
    assert lines[1] == "2. [argument, supports pole A of 1] Bikes are healthy."
    assert lines[2] == "3. [claim, unverified, supports pole B of 1] Buses are cheaper."
    assert await title(snapshot, [buses.id, tension.id, bikes.id]) == {"title": "Bikes or buses", "cached": True}
    assert len(seen) == 1

    with pytest.raises(service.UnknownArguments):
        await title(snapshot, [tension.id, bikes.id, str(uuid.uuid4())])
    with pytest.raises(SelectionTooSmall):
        await title(snapshot, [tension.id, bikes.id])

    # A pinned assessment is part of what the model reads, so the successor is titled afresh.
    assert await _check(maps, snapshot, buses.id, _Checker("false")) == "done"
    successor = maps.current()
    assert (await title(successor, [tension.id, bikes.id, buses.id]))["cached"] is False
    assert seen[-1][2] == "3. [claim, false, supports pole B of 1] Buses are cheaper."


@pytest.mark.asyncio
async def test_the_result_routes_answer_a_snapshot_id_and_its_v2_row(world: FixtureWorld, monkeypatch: pytest.MonkeyPatch) -> None:
    maps, snapshot = await _seeded(world, PAIRS)
    grants = Grants()
    access = grants.grant(PROJECT, *READ)
    jobs: list[tuple[Any, ...]] = []
    monkeypatch.setattr(map_bff, "resolve_project_access", grants.resolve)
    monkeypatch.setattr(map_bff, "get_store", lambda: maps.map_store)
    monkeypatch.setattr(map_bff, "get_analysis_store", lambda: maps.store)
    monkeypatch.setattr(map_bff, "get_map_view_reads", lambda: maps.reads)
    monkeypatch.setattr(service, "dispatch_fact_check", lambda *job: jobs.append(job) or "msg")
    for name in ("_generate_limiter", "_title_limiter", "_fact_check_limiter"):
        monkeypatch.setattr(map_bff, name, Limiter())
    redis = FakeAsyncRedis()

    async def _redis() -> FakeAsyncRedis:
        return redis

    async def _title(*, lines: list[str], project_name: str, project_context: str) -> str:  # noqa: ARG001
        return "Trams against buses"

    monkeypatch.setattr(map_bff, "get_redis_client", _redis)
    monkeypatch.setattr(map_model, "title_selection", _title)
    monkeypatch.setattr(map_model, "model_identity", lambda: "fake-title-model")
    base = "/api/v2/bff/map"
    claim = _by_statement(maps, CLAIM)
    ids = [r["revisionId"] for r in snapshot.manifest["objects"]][:3]
    (v2_row,) = maps.reads.v2_results()

    titled = await asgi_call(map_bff.router, base, "POST", f"/results/{snapshot.id}/title", json={"node_ids": ids, "snapshot_id": snapshot.id, "revision_ids": ids})
    assert titled.status_code == 200 and titled.json()["title"] == "Trams against buses"
    moved = await asgi_call(map_bff.router, base, "POST", f"/results/{snapshot.id}/title", json={"node_ids": ids, "snapshot_id": str(uuid.uuid4())})
    assert moved.status_code == 409

    for result_id in (snapshot.id, v2_row):
        listing = await asgi_call(map_bff.router, base, "GET", f"/results/{result_id}/fact-checks")
        assert listing.status_code == 200 and listing.json() == {"fact_checks": {claim.id: {"status": "idle"}}}
    assert (await asgi_call(map_bff.router, base, "POST", f"/results/{snapshot.id}/fact-checks/{claim.id}")).status_code == 403
    assert access.required[-1] == "project:update"

    grants.grant(PROJECT, *WRITE)
    started = await asgi_call(map_bff.router, base, "POST", f"/results/{v2_row}/fact-checks/{claim.id}")
    assert started.status_code == 200 and started.json()["status"] == "processing"
    assert jobs[0][2:] == (snapshot.id, claim.id)
    tension = next(r["revisionId"] for r in snapshot.manifest["objects"] if r["type"] == "tension")
    assert (await asgi_call(map_bff.router, base, "POST", f"/results/{snapshot.id}/fact-checks/{tension}")).status_code == 422
    cancelled = await asgi_call(map_bff.router, base, "DELETE", f"/results/{snapshot.id}/fact-checks/{claim.id}")
    assert cancelled.json() == {"status": "idle"}
    assert (await asgi_call(map_bff.router, base, "GET", f"/results/{uuid.uuid4()}/fact-checks")).status_code == 404
