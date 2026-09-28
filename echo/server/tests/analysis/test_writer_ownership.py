"""One writer per producer scope, and the fence that proves it.

The executor is refused while the legacy writer owns a scope, the legacy writer
is refused once it has been handed over, and a transfer waits for the running
tick rather than cutting in on it.
"""

from __future__ import annotations

from typing import Any
from dataclasses import replace

import pytest

from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import RunRequest, run_worker, request_run
from dembrane.analysis.contracts import Writer, RunStatus, ScopeKind, WriterNotOwner
from tests.analysis.fixture_recipes import WORDS, FixtureWorld
from dembrane.analysis.popcorn_import import (
    TransferBusy,
    claim_legacy,
    analysis_owns,
    transfer_to_legacy,
    transfer_to_analysis,
)

PROJECT = "44444444-4444-4444-8444-444444444444"
CONVERSATION = "cccccccc-0000-4000-8000-000000000001"


class FakeWriters:
    """The one write the SQL store makes for a transfer, in memory: the scope's
    writer and a fence that goes up with every change."""

    def __init__(self, store: FakeAnalysisStore) -> None:
        self.store = store
        self.calls: list[tuple[str, str]] = []

    async def set_writer(self, scope_id: str, writer: Writer) -> tuple[Writer, int]:
        scope = self.store.scopes[scope_id]
        if scope.writer == writer:
            return scope.writer, scope.writer_fence
        updated = replace(scope, writer=writer, writer_fence=scope.writer_fence + 1)
        self.store.scopes[scope_id] = updated
        self.calls.append((scope_id, str(writer)))
        return updated.writer, updated.writer_fence


def setup(world: FixtureWorld) -> tuple[FakeAnalysisStore, FakeWriters]:
    world.sources[PROJECT] = {CONVERSATION: ["The kettle is the real reception."]}
    store = FakeAnalysisStore()
    return store, FakeWriters(store)


def owner(**kwargs: Any) -> dict[str, Any]:
    return {"project_id": PROJECT, "recipe_id": WORDS, "scope_key": "project", **kwargs}


async def request(store: FakeAnalysisStore, key: str) -> Any:
    return await request_run(
        RunRequest(project_id=PROJECT, recipe_id=WORDS, scope_key="project", idempotency_key=key),
        store=store,
        deps=Recorder().deps(),
    )


@pytest.mark.asyncio
async def test_a_claimed_scope_refuses_the_executor(world: FixtureWorld) -> None:
    store, writers = setup(world)
    claimed = await claim_legacy(**owner(store=store, writers=writers))
    assert claimed is not None and claimed.changed
    assert (claimed.previous, claimed.writer) == ("analysis", "legacy")
    assert claimed.fence == 1
    assert not await analysis_owns(PROJECT, WORDS, "project", store=store)

    with pytest.raises(WriterNotOwner):
        await request(store, "w1")
    assert world.total_model_calls() == 0


@pytest.mark.asyncio
async def test_a_run_queued_before_the_claim_cannot_run_after_it(world: FixtureWorld) -> None:
    store, writers = setup(world)
    outcome = await request(store, "w1")
    assert outcome.run.status == RunStatus.QUEUED

    await claim_legacy(**owner(store=store, writers=writers))
    assert await run_worker(outcome.run.id, store=store, deps=Recorder().deps()) == "skipped"
    run = await store.get_run(outcome.run.id)
    assert run is not None and run.status == RunStatus.FAILED
    assert run.error == "Another writer owns this scope now."
    assert world.total_model_calls() == 0


@pytest.mark.asyncio
async def test_a_transfer_waits_for_the_running_tick(world: FixtureWorld) -> None:
    store, writers = setup(world)
    await claim_legacy(**owner(store=store, writers=writers))

    async def still_running() -> bool:
        return False

    with pytest.raises(TransferBusy):
        await transfer_to_analysis(**owner(store=store, writers=writers, drain=still_running))
    scope = await store.find_scope(
        project_id=PROJECT, kind=ScopeKind.PRODUCER, owner_id=WORDS, scope_key="project"
    )
    assert scope is not None and scope.writer == Writer.LEGACY and scope.writer_fence == 1


@pytest.mark.asyncio
async def test_after_the_transfer_the_executor_publishes_and_the_fence_moved(
    world: FixtureWorld,
) -> None:
    store, writers = setup(world)
    await claim_legacy(**owner(store=store, writers=writers))

    async def drained() -> bool:
        return True

    handed = await transfer_to_analysis(**owner(store=store, writers=writers, drain=drained))
    assert handed.changed and (handed.previous, handed.writer) == ("legacy", "analysis")
    assert handed.fence == 2
    assert await analysis_owns(PROJECT, WORDS, "project", store=store)

    outcome = await request(store, "w2")
    assert await run_worker(outcome.run.id, store=store, deps=Recorder().deps()) == "ready"
    run = await store.get_run(outcome.run.id)
    assert run is not None and run.status == RunStatus.READY

    # Repeating the transfer changes nothing, so it never fences a healthy run.
    again = await transfer_to_analysis(**owner(store=store, writers=writers, drain=drained))
    assert not again.changed and again.fence == 2


@pytest.mark.asyncio
async def test_a_published_scope_is_not_claimed_back_by_accident(world: FixtureWorld) -> None:
    """A scope with a ready output is the executor's; the importer leaves it
    alone, and only a deliberate rollback takes it back."""
    store, writers = setup(world)
    outcome = await request(store, "w1")
    assert await run_worker(outcome.run.id, store=store, deps=Recorder().deps()) == "ready"

    assert await claim_legacy(**owner(store=store, writers=writers)) is None
    assert await analysis_owns(PROJECT, WORDS, "project", store=store)

    rolled_back = await transfer_to_legacy(**owner(store=store, writers=writers))
    assert rolled_back.changed and rolled_back.writer == "legacy"
    # The published run and its objects are kept; only the writer changed.
    run = await store.get_run(outcome.run.id)
    assert run is not None and run.status == RunStatus.READY and store.revisions
    with pytest.raises(WriterNotOwner):
        await request(store, "w3")


@pytest.mark.asyncio
async def test_the_sql_writer_store_moves_the_writer_and_its_fence(
    pg_dsn: str, world: FixtureWorld
) -> None:
    """The one statement this package writes outside the lifecycle store,
    against the real table, its checks and its scope guard."""
    from dembrane.analysis.store import SqlAnalysisStore
    from tests.analysis.conftest import new_project
    from dembrane.analysis.popcorn_import import SqlWriterStore

    project_id = await new_project(pg_dsn)
    scope_key = f"conversation:{CONVERSATION}"
    world.sources[project_id] = {CONVERSATION: ["The kettle is the real reception."]}
    store = SqlAnalysisStore(dsn=pg_dsn)
    writers = SqlWriterStore(pg_dsn)
    scope = await store.ensure_scope(
        project_id=project_id, kind=ScopeKind.PRODUCER, owner_id=WORDS, scope_key=scope_key
    )
    assert scope.writer == Writer.ANALYSIS and scope.writer_fence == 0

    assert await writers.set_writer(scope.id, Writer.LEGACY) == (Writer.LEGACY, 1)
    # Setting the writer a scope already has moves no fence.
    assert await writers.set_writer(scope.id, Writer.LEGACY) == (Writer.LEGACY, 1)
    with pytest.raises(WriterNotOwner):
        await request_run(
            RunRequest(
                project_id=project_id,
                recipe_id=WORDS,
                scope_key=scope_key,
                idempotency_key="sql-1",
            ),
            store=store,
            deps=Recorder().deps(),
        )

    assert await writers.set_writer(scope.id, Writer.ANALYSIS) == (Writer.ANALYSIS, 2)
    handed = await store.get_scope(scope.id)
    assert handed is not None and handed.writer == Writer.ANALYSIS and handed.writer_fence == 2
    outcome = await request_run(
        RunRequest(
            project_id=project_id, recipe_id=WORDS, scope_key=scope_key, idempotency_key="sql-2"
        ),
        store=store,
        deps=Recorder().deps(),
    )
    assert outcome.run.status == RunStatus.QUEUED and outcome.run.writer_fence == 2
