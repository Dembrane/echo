"""A host's edit or exclusion persists through every later run.

An authored head stays an object's head until a host changes it. A refresh, a
regenerate, or an edit that lands while a run is working never replaces it and
never parks the run for review: the run publishes, its manifest names the
authored head, and whatever waits on the run goes on. An exclusion also reaches
every recipe downstream: tensions and merged arguments leave the argument out
from their next run on, and take it back when the host restores it. Each test
runs against the fake store and against Postgres (skipped when the database is
not there).
"""

from __future__ import annotations

from typing import Any, AsyncIterator
from dataclasses import dataclass

import pytest
import pytest_asyncio

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.store import SqlAnalysisStore
from tests.analysis.conftest import new_project
from dembrane.analysis.outbox import dispatch_events
from dembrane.analysis.executor import (
    RunRequest,
    RecipeContext,
    run_worker,
    request_run,
    execute_inline,
)
from dembrane.analysis.contracts import Run, RunStatus, ObjectRevision
from dembrane.analysis.revisions import RevisionService
from dembrane.analysis.snapshots import (
    ProducerRef,
    SnapshotRequest,
    assemble_snapshot,
    excluded_object_ids,
)
from tests.analysis.fixture_recipes import PAIRS, WORDS, FixtureWorld

FAKE_PROJECT = "11111111-1111-4111-8111-111111111111"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"
C3 = "aaaaaaaa-0000-4000-8000-000000000003"


@dataclass
class Setup:
    store: Any
    project: str
    rec: Recorder
    world: FixtureWorld

    def add_conversation(self, conversation: str, statements: list[str]) -> None:
        self.world.sources[self.project][conversation] = statements


@pytest_asyncio.fixture(params=["fake", "postgres"])
async def setup(request: pytest.FixtureRequest, world: FixtureWorld) -> AsyncIterator[Setup]:
    if request.param == "fake":
        store: Any = FakeAnalysisStore()
        project = FAKE_PROJECT
    else:
        dsn = request.getfixturevalue("pg_dsn")
        store = SqlAnalysisStore(dsn=dsn)
        project = await new_project(dsn)
    world.sources[project] = {
        C1: ["Trams are better.", "Buses are cheaper."],
        C2: ["Bikes are healthy."],
    }
    yield Setup(store, project, Recorder(), world)


async def _run(s: Setup, recipe: str = WORDS, **kwargs: Any) -> tuple[str, Run]:
    outcome = await request_run(
        RunRequest(s.project, recipe, "project", **kwargs), store=s.store, deps=s.rec.deps()
    )
    result = await run_worker(outcome.run.id, store=s.store, deps=s.rec.deps())
    run = await s.store.get_run(outcome.run.id)
    assert run is not None
    return result, run


async def _head(s: Setup, statement: str) -> ObjectRevision:
    heads = await s.store.current_revisions(s.project, None)
    return next(v for v in heads.values() if v.payload.get("statement") == statement)


async def _edit(s: Setup, statement: str, new: str) -> ObjectRevision:
    head = await _head(s, statement)
    return await RevisionService(s.store).author_edit(
        project_id=s.project,
        object_id=head.object_id,
        expected_revision_id=head.id,
        payload={**head.payload, "statement": new},
        actor_id="host-1",
        reason="clearer",
    )


async def _current_id(s: Setup, object_id: str) -> str | None:
    record = await s.store.get_object(object_id)
    return record.current_revision_id if record else None


def _manifest_revision(run: Run, object_id: str) -> str | None:
    return next(
        (
            o["revisionId"]
            for o in (run.output_manifest or {}).get("objects") or []
            if o["objectId"] == object_id
        ),
        None,
    )


@pytest.mark.asyncio
async def test_a_refresh_after_a_host_edit_publishes_and_keeps_the_edit(setup: Setup) -> None:
    """Breaks if a generated revision may stage over an authored head."""
    s = setup
    assert (await _run(s, idempotency_key="k1"))[0] == "ready"
    edited = await _edit(s, "Trams are better.", "Trams are much better.")
    s.add_conversation(C3, ["Walking is free."])

    result, run = await _run(s, idempotency_key="k2")

    assert result == "ready" and run.status == RunStatus.READY
    assert await _current_id(s, edited.object_id) == edited.id
    assert _manifest_revision(run, edited.object_id) == edited.id
    assert (await s.store.get_scope(run.scope_id)).current_run_id == run.id


@pytest.mark.asyncio
async def test_a_regenerate_after_a_host_edit_keeps_the_edit(setup: Setup) -> None:
    """Breaks if an explicit regenerate may overwrite a host's edit."""
    s = setup
    assert (await _run(s, idempotency_key="k1"))[0] == "ready"
    edited = await _edit(s, "Trams are better.", "Trams are much better.")

    result, run = await _run(s, mode="regenerate", idempotency_key="g1")

    assert result == "ready"
    assert await _current_id(s, edited.object_id) == edited.id
    assert _manifest_revision(run, edited.object_id) == edited.id


@pytest.mark.asyncio
async def test_an_excluded_argument_stays_excluded_after_a_refresh(setup: Setup) -> None:
    """Breaks if a run may publish over an exclusion or the view shows it again."""
    s = setup
    assert (await _run(s, idempotency_key="k1"))[0] == "ready"
    head = await _head(s, "Buses are cheaper.")
    excluded = await RevisionService(s.store).set_excluded(
        project_id=s.project,
        object_id=head.object_id,
        expected_revision_id=head.id,
        excluded=True,
        actor_id="host-1",
    )
    s.add_conversation(C3, ["Walking is free."])

    result, run = await _run(s, idempotency_key="k2")

    assert result == "ready"
    assert await _current_id(s, head.object_id) == excluded.id
    assert head.object_id in await excluded_object_ids(s.project, store=s.store)
    view = await assemble_snapshot(
        SnapshotRequest(s.project, "map", "project", (ProducerRef(WORDS, "project"),)),
        store=s.store,
    )
    shown = {o["objectId"] for o in view.manifest["objects"]}
    assert head.object_id not in shown
    assert (await _head(s, "Walking is free.")).object_id in shown


@pytest.mark.asyncio
async def test_a_host_edit_that_lands_during_a_run_wins_and_the_run_publishes(setup: Setup) -> None:
    """Breaks if a head that became authored mid-run parks the run for review."""
    s = setup
    assert (await _run(s, idempotency_key="k1"))[0] == "ready"
    edits: list[ObjectRevision] = []

    async def host_edits(ctx: RecipeContext) -> None:
        edits.append(await _edit(s, "Trams are better.", "Trams are much better."))

    s.world.after_emit = host_edits
    s.add_conversation(C3, ["Walking is free."])

    result, run = await _run(s, idempotency_key="k2")

    (edited,) = edits
    assert result == "ready"
    assert await _current_id(s, edited.object_id) == edited.id
    assert _manifest_revision(run, edited.object_id) == edited.id


@pytest.mark.asyncio
async def test_a_host_edit_during_a_run_wins_over_the_runs_new_wording(setup: Setup) -> None:
    """Breaks if a run's staged revision may replace an edit made while it worked."""
    s = setup
    assert (await _run(s, idempotency_key="k1"))[0] == "ready"
    edits: list[ObjectRevision] = []

    async def host_edits(ctx: RecipeContext) -> None:
        edits.append(await _edit(s, "Trams are better.", "Trams are much better."))

    s.world.after_emit = host_edits
    s.world.sources[s.project][C1] = ["Trams are better, mostly.", "Buses are cheaper."]

    result, run = await _run(s, idempotency_key="k2")

    (edited,) = edits
    assert result == "ready"
    assert await _current_id(s, edited.object_id) == edited.id
    assert _manifest_revision(run, edited.object_id) == edited.id
    statements = {
        v.payload.get("statement")
        for v in (await s.store.current_revisions(s.project, None)).values()
    }
    assert "Trams are much better." in statements and "Trams are better, mostly." not in statements


@pytest.mark.asyncio
async def test_a_run_waiting_on_edited_arguments_runs_and_reads_the_edit(setup: Setup) -> None:
    """Breaks if a dependant can wait forever on a producer that met an edit."""
    s = setup
    assert (await _run(s, idempotency_key="k1"))[0] == "ready"
    edited = await _edit(s, "Trams are better.", "Trams are much better.")
    s.add_conversation(C3, ["Walking is free."])

    outcome = await request_run(
        RunRequest(s.project, PAIRS, "project", idempotency_key="p1", refresh_dependencies=True),
        store=s.store,
        deps=s.rec.deps(),
    )
    (words_run,) = outcome.dependencies
    assert await run_worker(words_run.id, store=s.store, deps=s.rec.deps()) == "ready"
    await dispatch_events(store=s.store, deps=s.rec.outbox_deps())
    pairs = await s.store.get_run(outcome.run.id)
    assert pairs is not None and pairs.status == RunStatus.QUEUED
    assert await run_worker(pairs.id, store=s.store, deps=s.rec.deps()) == "ready"
    pairs = await s.store.get_run(outcome.run.id)
    assert pairs is not None and edited.id in (pairs.input_manifest or {})["revisionIds"]


@pytest.mark.asyncio
async def test_relations_follow_a_tension_a_host_edited_while_the_run_published(
    setup: Setup,
) -> None:
    """Breaks if a yielded object's relations keep pointing at the run's own revision."""
    s = setup
    first = await execute_inline(
        RunRequest(s.project, PAIRS, "project", idempotency_key="p1"),
        store=s.store,
        deps=s.rec.deps(),
    )
    assert first.run.status == RunStatus.READY
    heads = await s.store.current_revisions(s.project, None)
    tension = next(v for v in heads.values() if v.type == "tension")
    edits: list[ObjectRevision] = []
    publish = s.store.publish_run

    async def host_edits_then_publish(*args: Any, **kwargs: Any) -> Any:
        if not edits:
            edits.append(
                await RevisionService(s.store).author_edit(
                    project_id=s.project,
                    object_id=tension.object_id,
                    expected_revision_id=tension.id,
                    payload={**tension.payload, "knot": "The host says it sharper."},
                    actor_id="host-1",
                )
            )
        return await publish(*args, **kwargs)

    s.store.publish_run = host_edits_then_publish

    result, run = await _run(s, PAIRS, mode="regenerate", idempotency_key="p2")

    (edited,) = edits
    assert result == "ready"
    assert _manifest_revision(run, tension.object_id) == edited.id
    relations = (run.output_manifest or {})["relations"]
    assert sorted(r["type"] for r in relations if r["to"] == edited.id) == [
        "supports_pole_a",
        "supports_pole_b",
    ]
    assert all(tension.id not in (r["from"], r["to"]) for r in relations)


# ── an exclusion reaches the recipes downstream ─────────────────────────


async def _exclude(s: Setup, statement: str, excluded: bool = True) -> ObjectRevision:
    heads = await s.store.current_revisions(s.project, None)
    head = next(
        v
        for v in heads.values()
        if v.type == "argument" and v.payload.get("statement") == statement
    )
    return await RevisionService(s.store).set_excluded(
        project_id=s.project,
        object_id=head.object_id,
        expected_revision_id=head.id,
        excluded=excluded,
        actor_id="host-1",
    )


async def _paired_objects(s: Setup, run: Run) -> set[str]:
    """The argument objects the run's tensions stand on."""
    ends = {str(r[end]) for r in (run.output_manifest or {})["relations"] for end in ("from", "to")}
    found = await s.store.get_revisions(s.project, sorted(ends))
    return {v.object_id for v in found.values() if v.type == "argument"}


async def _input_objects(s: Setup, run: Run) -> set[str]:
    ids = list((run.input_manifest or {})["revisionIds"])
    return {v.object_id for v in (await s.store.get_revisions(s.project, ids)).values()}


@pytest.mark.asyncio
async def test_an_excluded_argument_is_left_out_of_the_next_tensions_run(setup: Setup) -> None:
    """Breaks if a dependant pins an argument a host excluded, or reuses its old output."""
    s = setup
    first = await execute_inline(
        RunRequest(s.project, PAIRS, "project", idempotency_key="p1"),
        store=s.store,
        deps=s.rec.deps(),
    )
    buses = (await _head(s, "Buses are cheaper.")).object_id
    assert buses in await _paired_objects(s, first.run)

    await _exclude(s, "Buses are cheaper.")
    result, run = await _run(s, PAIRS, idempotency_key="p2")

    assert result == "ready" and run.id != first.run.id and "reuse" not in (run.metrics or {})
    assert buses not in await _input_objects(s, run)
    assert buses not in await _paired_objects(s, run)
    assert (run.input_manifest or {})["dependencies"]["arguments"]["withdrawnObjectIds"] == [buses]


@pytest.mark.asyncio
async def test_restoring_an_excluded_argument_brings_it_back_into_tensions(setup: Setup) -> None:
    """Breaks if an exclusion outlives the host's restore downstream."""
    s = setup
    await execute_inline(
        RunRequest(s.project, PAIRS, "project", idempotency_key="p1"),
        store=s.store,
        deps=s.rec.deps(),
    )
    buses = (await _head(s, "Buses are cheaper.")).object_id
    await _exclude(s, "Buses are cheaper.")
    assert (await _run(s, PAIRS, idempotency_key="p2"))[0] == "ready"

    await _exclude(s, "Buses are cheaper.", excluded=False)
    result, run = await _run(s, PAIRS, idempotency_key="p3")

    assert result == "ready"
    assert buses in await _paired_objects(s, run)
    assert "withdrawnObjectIds" not in (run.input_manifest or {})["dependencies"]["arguments"]


@pytest.mark.asyncio
async def test_a_tensions_run_that_waited_on_arguments_leaves_the_exclusion_out(
    setup: Setup,
) -> None:
    """Breaks if a run pinned at claim time (after waiting) skips the exclusion."""
    s = setup
    await execute_inline(
        RunRequest(s.project, PAIRS, "project", idempotency_key="p1"),
        store=s.store,
        deps=s.rec.deps(),
    )
    buses = (await _head(s, "Buses are cheaper.")).object_id
    await _exclude(s, "Buses are cheaper.")
    s.add_conversation(C3, ["Walking is free."])

    outcome = await request_run(
        RunRequest(s.project, PAIRS, "project", idempotency_key="p2", refresh_dependencies=True),
        store=s.store,
        deps=s.rec.deps(),
    )
    (words_run,) = outcome.dependencies
    assert await run_worker(words_run.id, store=s.store, deps=s.rec.deps()) == "ready"
    await dispatch_events(store=s.store, deps=s.rec.outbox_deps())
    assert await run_worker(outcome.run.id, store=s.store, deps=s.rec.deps()) == "ready"
    run = await s.store.get_run(outcome.run.id)

    assert run is not None
    assert buses not in await _input_objects(s, run)
    assert buses not in await _paired_objects(s, run)
