"""Dispatch of committed publication events.

Publication inserts an `analysis_outbox` row in the same transaction that makes
an output current (a run's publication, an authored or imported revision, a
view snapshot), so a committed publication is always available for dispatch.
After commit the executor enqueues `task_analysis_outbox_dispatch` for the
event (best effort); a scheduler job sweeps every minute for anything not
delivered, claiming with `FOR UPDATE SKIP LOCKED`.

Consumers run in order and each is recorded on the event once it succeeds, so
a retried or duplicated dispatch skips what already happened:

1. `live_event`: the page's nudge over Redis. A nudge, not the record; a
   duplicate is harmless.
2. `wake_waiting`: settle runs waiting on this output and send the woken ones
   to a worker. Waking is a compare-and-set on the run's status, so a second
   dispatcher finds nothing left to wake and starts nothing; a duplicate
   message for a woken run is harmless because only one claim wins.
3. `view_snapshots`: registered hooks that assemble following view snapshots.
   The dispatcher imports the modules that register them (`VIEW_HOOK_MODULES`)
   before its first dispatch, so a worker that only dispatches has them. A snapshot records the event it answers under a unique key, so a dispatch
   repeated after a crash between the snapshot's commit and this marker finds
   that snapshot instead of assembling another.

A failed consumer puts the event back with exponential backoff and a persisted
attempt count; after `MAX_ATTEMPTS` it is `dead` and stays for inspection.
Failed notification never undoes a valid publication.
"""

from __future__ import annotations

import time
import uuid
import logging
import importlib
from typing import Any, Callable, Awaitable
from dataclasses import field, dataclass

from dembrane.analysis.executor import ExecutorDeps, default_deps, default_store
from dembrane.analysis.contracts import OutboxEvent, AnalysisStore

logger = logging.getLogger("dembrane.analysis.outbox")

MAX_ATTEMPTS = 12
CLAIM_SECONDS = 120
SWEEP_LIMIT = 50
# A queued run nobody claimed for this long is sent to a worker again.
QUEUED_REDISPATCH_SECONDS = 120

SnapshotHook = Callable[[OutboxEvent, AnalysisStore], Awaitable[None]]
_snapshot_hooks: list[SnapshotHook] = []

# Modules whose import registers a following-view hook. A worker that only
# dispatches imports none of them otherwise, so the dispatcher loads them.
VIEW_HOOK_MODULES = ("dembrane.analysis.map_view", "dembrane.popcorn.bundle")
_view_hooks_loaded = False


def load_view_hooks() -> None:
    """Import every module in `VIEW_HOOK_MODULES` once (they import this
    module, so never at import time). A deployment without one has no hook."""
    global _view_hooks_loaded
    if _view_hooks_loaded:
        return
    for name in VIEW_HOOK_MODULES:
        try:
            importlib.import_module(name)
        except ModuleNotFoundError as exc:
            if exc.name != name:
                raise
    _view_hooks_loaded = True


def register_snapshot_hook(hook: SnapshotHook) -> SnapshotHook:
    if hook not in _snapshot_hooks:
        _snapshot_hooks.append(hook)
    return hook


def unregister_snapshot_hook(hook: SnapshotHook) -> None:
    if hook in _snapshot_hooks:
        _snapshot_hooks.remove(hook)


def backoff_seconds(attempts: int) -> int:
    return int(min(3600, 15 * 2 ** max(0, attempts - 1)))


@dataclass
class OutboxDeps:
    executor: ExecutorDeps
    snapshot_hooks: list[SnapshotHook] = field(default_factory=lambda: _snapshot_hooks)
    clock: Callable[[], float] = time.monotonic


@dataclass
class DispatchReport:
    claimed: int = 0
    delivered: int = 0
    retried: int = 0
    lost: int = 0


@dataclass
class SweepReport:
    expired_runs: int = 0
    woken_runs: int = 0
    failed_waiting_runs: int = 0
    redispatched_runs: int = 0
    events: DispatchReport = field(default_factory=DispatchReport)
    dead_events: DispatchReport = field(default_factory=DispatchReport)


def _event_doc(event: OutboxEvent) -> dict[str, Any]:
    return {
        "type": event.event_type,
        "event_id": event.id,
        "scope_id": event.scope_id,
        "sequence": event.sequence,
        "run_id": event.run_id,
        "snapshot_id": event.snapshot_id,
        **{
            k: v
            for k, v in event.payload.items()
            if k
            in (
                "recipeId",
                "scopeKey",
                "viewId",
                "manifestHash",
                "objectId",
                "revisionId",
                "membershipExcluded",
            )
        },
    }


async def consume_live_event(event: OutboxEvent, store: AnalysisStore, deps: OutboxDeps) -> None:  # noqa: ARG001
    await deps.executor.publish_event(event.project_id, _event_doc(event))


async def consume_wake_waiting(event: OutboxEvent, store: AnalysisStore, deps: OutboxDeps) -> None:
    if event.event_type != "run_published":
        return
    result = await store.wake_waiting_runs(event.project_id)
    for run in result.woken:
        if deps.executor.dispatch_run is not None:
            await store.set_execution_ref(run.id, deps.executor.dispatch_run(run.id))
        await deps.executor.publish_event(run.project_id, {"type": "queued", "run_id": run.id, "recipe_id": run.recipe_id})
    for run in result.failed:
        await deps.executor.publish_event(run.project_id, {"type": "failed", "run_id": run.id, "recipe_id": run.recipe_id})


async def consume_view_snapshots(event: OutboxEvent, store: AnalysisStore, deps: OutboxDeps) -> None:
    for hook in list(deps.snapshot_hooks):
        await hook(event, store)


Consumer = Callable[[OutboxEvent, AnalysisStore, OutboxDeps], Awaitable[None]]
CONSUMERS: tuple[tuple[str, Consumer], ...] = (
    ("live_event", consume_live_event),
    ("wake_waiting", consume_wake_waiting),
    ("view_snapshots", consume_view_snapshots),
)
# Effects inside the platform, reconciled even after an event is dead; the
# page nudge is not worth sending that late.
INTERNAL_CONSUMERS = ("wake_waiting", "view_snapshots")


async def dispatch_events(
    *,
    store: AnalysisStore,
    deps: OutboxDeps,
    event_id: str | None = None,
    limit: int = SWEEP_LIMIT,
    consumers: tuple[tuple[str, Consumer], ...] = CONSUMERS,
    dead: bool = False,
) -> DispatchReport:
    """Claim due events (or the one named) and run each consumer not yet done.
    Consumers are isolated: one that fails is retried with its event later
    while the others still run and are recorded now. `dead` claims events past
    their last attempt instead."""
    claim = uuid.uuid4().hex
    events = await store.claim_outbox(
        claim=claim, limit=limit, claim_seconds=CLAIM_SECONDS, event_id=event_id, dead=dead
    )
    report = DispatchReport(claimed=len(events))
    for event in events:
        try:
            failures: list[str] = []
            lost = False
            for name, consumer in consumers:
                if name in event.consumers:
                    continue
                try:
                    await consumer(event, store, deps)
                except Exception as exc:  # noqa: BLE001
                    failures.append(f"{type(exc).__name__}: {str(exc)[:300]} (consumer {name})")
                    logger.warning(
                        "analysis outbox %s (%s) consumer %s failed on attempt %d: %s",
                        event.id,
                        event.event_type,
                        name,
                        event.attempts,
                        type(exc).__name__,
                    )
                    continue
                if not await store.mark_consumer_done(event.id, claim, name):
                    lost = True
                    break
            if lost:
                # Another dispatcher reclaimed it after our claim expired.
                report.lost += 1
                continue
            if failures:
                delay = backoff_seconds(event.attempts)
                await store.retry_outbox(
                    event.id, claim, error="; ".join(failures), delay_seconds=delay, max_attempts=MAX_ATTEMPTS
                )
                report.retried += 1
                continue
            if not await store.finish_outbox(event.id, claim):
                report.lost += 1
                continue
            report.delivered += 1
        except Exception as exc:  # noqa: BLE001
            # The claim expires and a later dispatch picks the event up again.
            logger.warning("analysis outbox %s could not be settled: %s", event.id, type(exc).__name__)
            report.lost += 1
    return report


async def sweep(*, store: AnalysisStore, deps: OutboxDeps) -> SweepReport:
    """The minute job: fail runs whose lease deadline passed, settle waiting
    runs against their dependencies' rows, send stranded queued runs again and
    dispatch every due event, then finish the internal effects (waking
    waiting runs, assembling snapshots) of events already dead."""
    report = SweepReport()
    report.expired_runs = len(await store.expire_stale_runs())
    wake = await store.wake_waiting_runs(None)
    report.woken_runs = len(wake.woken)
    report.failed_waiting_runs = len(wake.failed)
    stranded = await store.redispatch_queued_runs(QUEUED_REDISPATCH_SECONDS, SWEEP_LIMIT)
    report.redispatched_runs = len(stranded)
    if deps.executor.dispatch_run is not None:
        for run in (*wake.woken, *stranded):
            try:
                await store.set_execution_ref(run.id, deps.executor.dispatch_run(run.id))
            except Exception as exc:  # noqa: BLE001
                logger.warning("analysis run %s not dispatched by the sweep: %s", run.id, type(exc).__name__)
    report.events = await dispatch_events(store=store, deps=deps)
    report.dead_events = await dispatch_events(
        store=store,
        deps=deps,
        dead=True,
        consumers=tuple((name, consumer) for name, consumer in CONSUMERS if name in INTERNAL_CONSUMERS),
    )
    return report


async def run_dispatch(event_id: str | None = None) -> DispatchReport | SweepReport:
    """The actor's entry point: one event after commit, or the sweep."""
    load_view_hooks()
    store = default_store()
    deps = OutboxDeps(executor=default_deps())
    if event_id:
        return await dispatch_events(store=store, deps=deps, event_id=event_id, limit=1)
    return await sweep(store=store, deps=deps)
