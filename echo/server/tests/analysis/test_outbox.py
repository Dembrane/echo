"""Outbox dispatch against the in-memory store."""

from __future__ import annotations

from typing import Any
from collections import Counter

import pytest

from dembrane.analysis import outbox
from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.outbox import sweep, dispatch_events, consume_wake_waiting
from dembrane.analysis.executor import RunRequest, run_worker, request_run
from dembrane.analysis.contracts import RunStatus, OutboxEvent, OutboxStatus, AnalysisStore
from tests.analysis.fixture_recipes import PAIRS, WORDS, FixtureWorld

PROJECT = "11111111-1111-4111-8111-111111111111"
C1 = "aaaaaaaa-0000-4000-8000-000000000001"


def _seed(world: FixtureWorld) -> None:
    world.sources[PROJECT] = {C1: ["Trams are better.", "Buses are cheaper."]}


async def _published(world: FixtureWorld, store: FakeAnalysisStore, rec: Recorder) -> OutboxEvent:
    _seed(world)
    outcome = await request_run(RunRequest(PROJECT, WORDS, "project", idempotency_key="k"), store=store, deps=rec.deps())
    assert await run_worker(outcome.run.id, store=store, deps=rec.deps()) == "ready"
    (event,) = [e for e in store.outbox.values() if e.run_id == outcome.run.id]
    return event


@pytest.mark.asyncio
async def test_a_failed_consumer_retries_with_backoff_and_skips_what_already_succeeded(world: FixtureWorld) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    event = await _published(world, store, rec)
    calls: Counter[str] = Counter()

    async def first(_event: OutboxEvent, _store: AnalysisStore, _deps: Any) -> None:
        calls["first"] += 1

    async def flaky(_event: OutboxEvent, _store: AnalysisStore, _deps: Any) -> None:
        calls["flaky"] += 1
        if calls["flaky"] == 1:
            raise RuntimeError("the receiver is down")

    consumers = (("first", first), ("flaky", flaky))
    report = await dispatch_events(store=store, deps=rec.outbox_deps(), consumers=consumers)
    assert (report.claimed, report.retried, report.delivered) == (1, 1, 0)
    retried = store.outbox[event.id]
    assert retried.status == OutboxStatus.PENDING and retried.attempts == 1
    assert retried.last_error is not None and retried.last_error.startswith("RuntimeError")
    assert set(retried.consumers) == {"first"}

    assert (await dispatch_events(store=store, deps=rec.outbox_deps(), consumers=consumers)).claimed == 0
    store.clock.advance(outbox.backoff_seconds(1) + 1)
    report = await dispatch_events(store=store, deps=rec.outbox_deps(), consumers=consumers)
    assert report.delivered == 1 and calls == {"first": 1, "flaky": 2}
    assert store.outbox[event.id].status == OutboxStatus.DELIVERED and store.outbox[event.id].attempts == 2


@pytest.mark.asyncio
async def test_an_event_is_dead_after_its_last_attempt(world: FixtureWorld, monkeypatch: pytest.MonkeyPatch) -> None:
    store, rec = FakeAnalysisStore(), Recorder()
    event = await _published(world, store, rec)
    monkeypatch.setattr(outbox, "MAX_ATTEMPTS", 2)

    async def broken(_event: OutboxEvent, _store: AnalysisStore, _deps: Any) -> None:
        raise RuntimeError("always")

    for _ in range(2):
        await dispatch_events(store=store, deps=rec.outbox_deps(), consumers=(("broken", broken),))
        store.clock.advance(3600)
    assert store.outbox[event.id].status == OutboxStatus.DEAD
    assert (await dispatch_events(store=store, deps=rec.outbox_deps(), consumers=(("broken", broken),))).claimed == 0


@pytest.mark.asyncio
async def test_a_repeated_wake_up_starts_nothing_twice(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    outcome = await request_run(RunRequest(PROJECT, PAIRS, "project", idempotency_key="p"), store=store, deps=rec.deps())
    (words,) = outcome.dependencies
    assert await run_worker(words.id, store=store, deps=rec.deps()) == "ready"
    (event,) = [e for e in store.outbox.values() if e.run_id == words.id]

    assert (await dispatch_events(store=store, deps=rec.outbox_deps())).delivered == 1
    # A dispatch repeated after a crash between the effect and its marker.
    await consume_wake_waiting(event, store, rec.outbox_deps())
    assert rec.dispatched.count(outcome.run.id) == 1
    assert set(store.outbox[event.id].consumers) == {"live_event", "wake_waiting", "view_snapshots"}
    assert any(e["type"] == "run_published" and e["event_id"] == event.id for _p, e in rec.events)


@pytest.mark.asyncio
async def test_the_sweep_expires_lapsed_runs_settles_waiters_and_resends_stranded_runs(world: FixtureWorld) -> None:
    _seed(world)
    store, rec = FakeAnalysisStore(), Recorder()
    outcome = await request_run(RunRequest(PROJECT, PAIRS, "project", idempotency_key="p"), store=store, deps=rec.deps())
    (words,) = outcome.dependencies
    assert (await store.claim_run(words.id, "dead-worker", max_running=None)).outcome == "claimed"
    store.clock.advance(21 * 60)
    stranded = await request_run(RunRequest(PROJECT, WORDS, f"conversation:{C1}", idempotency_key="s"), store=store, deps=rec.deps())
    store.clock.advance(outbox.QUEUED_REDISPATCH_SECONDS + 1)

    report = await sweep(store=store, deps=rec.outbox_deps())
    assert (report.expired_runs, report.failed_waiting_runs, report.redispatched_runs) == (1, 1, 1)
    assert (await store.get_run(words.id)).status == RunStatus.FAILED  # type: ignore[union-attr]
    assert (await store.get_run(outcome.run.id)).status == RunStatus.FAILED  # type: ignore[union-attr]
    assert rec.dispatched.count(stranded.run.id) == 2
