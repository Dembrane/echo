"""The popcorn tick as a flow: a host action writes a `scheduled_task` backup
and sends the actor with the same request id; the ticks worker runs
`run_popcorn_tick` under the Redis run lock; the session state is flushed and
an `agent_loop_run` is written; the dashboard reads `popcorn_payload`.

Fakes sit only at the edges (tests/popcorn_flow_fakes.py): Directus, Redis,
the clock, the model calls, the reader-access check and the analysis store.
The unit-level invariants stay in test_popcorn_ticks.py, test_popcorn_service.py
and test_popcorn_dispatch.py; these drive the same code across its seams.

The strict xfails are the gaps named in the review of September 23rd 2026,
"Ticks, analysis and Map against Temporal's patterns" (section "Popcorn and
canvas ticks", numbered as there; the deadline is "Cross-cutting" #2). Each
describes the behaviour wanted, so it passes once the gap is fixed.
"""

from __future__ import annotations

import copy
import asyncio
from datetime import datetime, timedelta

import pytest

import dembrane.popcorn.ticks as ticks
from dembrane.directus import DirectusServerError
from tests.popcorn_flow_fakes import C1, C2, PENDING, TickWorld


@pytest.fixture
def world(monkeypatch) -> TickWorld:
    return TickWorld().install(monkeypatch)


def _at(value: str) -> datetime:
    parsed = ticks._parse_dt(value)
    assert parsed is not None
    return parsed


def _live(world: TickWorld) -> datetime:
    """The host goes live for an hour; the go-live read is delivered. The
    loop's expiry."""
    world.run(world.go_live(hours=1))
    world.deliver()
    return _at(world.loop()["expires_at"])


def _next_booked_read(world: TickWorld) -> None:
    """The clock reaches the one booked read; the scheduler sends it and the
    worker runs it."""
    (booked,) = world.pending_rows()
    world.advance_to(_at(booked["scheduled_at"]))
    world.run_scheduler()
    world.deliver()


def _latest_run(world: TickWorld) -> dict:
    return max(world.runs(), key=lambda run: run["started_at"])


def _hold_extraction_of(conversation_id: str) -> tuple[asyncio.Event, asyncio.Event, object]:
    """The first extractor call for this conversation waits for `release`."""
    entered, release = asyncio.Event(), asyncio.Event()

    async def hold(cid: str) -> None:
        if cid == conversation_id and not entered.is_set():
            entered.set()
            await release.wait()

    return entered, release, hold


# ── the core flow ────────────────────────────────────────────────────


def test_a_refresh_rereads_only_the_conversation_that_changed(world: TickWorld) -> None:
    """Breaks if a read stops skipping conversations whose transcript
    fingerprint is unchanged, or stops recording its run under the request id."""
    world.start_session()
    world.say(C2, "Every door we lock costs us a story.")
    world.models.calls.clear()

    request_id = world.run(world.request("manual"))
    world.deliver()

    # Only C2 met a model: its extractor and the second pass over its new phrase.
    assert world.models.extracted() == [C2]
    assert not [call for call in world.models.calls if call.endswith(C1)]
    run = world.run_row(request_id)
    assert run is not None and run["status"] == "ok"
    assert "1 of 2 conversations re-read" in run["detail"]
    c2 = world.state()["conversations"][C2]
    assert [item["phrase"] for item in c2["items"]] == [
        "Quiet is a service we sell",
        "Every door we lock costs us a story",
    ]
    assert c2["validated_fingerprint"] == c2["fingerprint"]
    payload = world.payload()
    assert payload["loop"]["mode"] == "manual"
    assert payload["loop"]["last_run_status"] == "ok"
    assert payload["counts"]["reading"] == 0 and payload["counts"]["phrases"] == 4
    assert payload["counts"]["run"] == 2


def test_a_second_delivery_of_the_same_request_changes_nothing(world: TickWorld) -> None:
    """Breaks if the completed-request check under the run lock is removed, or
    moved after the rerun wipes the state or books the next read."""
    world.start_session()
    world.say(C2, "Every door we lock costs us a story.")
    request_id = world.run(world.request("rerun"))
    # The minute scheduler claims the backup row before the worker has taken
    # the direct message: two deliveries of one request are queued.
    world.run_scheduler()
    assert [kwargs["request_id"] for _kind, _args, kwargs in world.broker] == [
        request_id,
        request_id,
    ]
    first = world.deliver_one()
    assert first["status"] == "ok" and first["run"]["id"] == request_id
    state = world.state()
    runs = len(world.runs())
    versions = len(world.directus.rows("canvas_generation"))
    writes = len(world.directus.state_writes(world.loop_id))
    world.models.calls.clear()

    second = world.deliver_one()

    assert second["status"] == "duplicate" and second["run"]["id"] == request_id
    assert world.models.calls == []
    assert world.state() == state and world.state()["run"] == 2
    assert len(world.directus.state_writes(world.loop_id)) == writes
    assert len(world.runs()) == runs
    assert len(world.directus.rows("canvas_generation")) == versions


def test_going_live_keeps_exactly_one_booked_read(world: TickWorld) -> None:
    """Breaks if `_enqueue_next_if_due` books without first cancelling the
    loop's pending rows: the go-live backup, the booking made when a read
    starts and the one made when it ends would each grow a chain."""
    world.start_session()
    _live(world)

    pending = world.pending_rows()
    assert len(pending) == 1 and pending[0]["payload"]["tick_kind"] == "scheduled"
    payload = world.payload()
    assert payload["loop"]["mode"] == "live"
    assert payload["loop"]["next_read_at"] == pending[0]["scheduled_at"]

    _next_booked_read(world)
    (after,) = world.pending_rows()
    assert after["id"] != pending[0]["id"]


def test_the_live_chain_books_its_last_read_before_expiry_then_returns_to_manual(
    world: TickWorld,
) -> None:
    """Breaks if the next read is not clamped to `expires_at` (booked past the
    expiry, or not at all for the last minutes), or a no-change read stops
    being a no-op that calls no model."""
    world.start_session()
    expires_at = _live(world)
    world.models.calls.clear()

    # A minute before the end: nothing new was said, so the read is a no-op.
    world.advance_to(expires_at - timedelta(minutes=1))
    world.run_scheduler()
    world.deliver()
    assert _latest_run(world)["status"] == "no_op"
    (last,) = world.pending_rows()
    assert _at(last["scheduled_at"]) == expires_at - timedelta(seconds=5)
    assert world.payload()["loop"]["next_read_at"] == last["scheduled_at"]

    # The last read runs and books nothing: the session is manual again.
    world.advance_to(expires_at - timedelta(seconds=5))
    world.run_scheduler()
    world.deliver()
    assert world.models.calls == []
    assert world.pending_rows() == []
    assert world.loop()["status"] == "paused"
    payload = world.payload()
    assert payload["loop"]["mode"] == "manual" and payload["loop"]["next_read_at"] is None


def test_stop_live_cancels_the_booked_read(world: TickWorld) -> None:
    """Breaks if `stop_live` stops cancelling the loop's pending rows."""
    world.start_session()
    _live(world)
    (booked,) = world.pending_rows()

    world.run(world.stop_live())

    assert world.pending_rows() == []
    world.advance_to(_at(booked["scheduled_at"]) + timedelta(minutes=1))
    world.run_scheduler()
    assert world.broker == []
    payload = world.payload()
    assert payload["loop"]["mode"] == "manual" and payload["loop"]["next_read_at"] is None


def test_a_booked_read_sent_just_before_stop_live_reads_nothing(world: TickWorld) -> None:
    """Breaks if a scheduled read stops checking the loop's mode before it
    reads and books."""
    world.start_session()
    _live(world)
    world.say(C2, "Every door we lock costs us a story.")
    (booked,) = world.pending_rows()
    world.advance_to(_at(booked["scheduled_at"]))
    world.run_scheduler()  # the booked read is on its way to a worker
    world.run(world.stop_live())
    world.models.calls.clear()

    world.deliver()

    assert world.models.calls == []
    assert _latest_run(world)["detail"] == "Loop is paused"
    assert world.pending_rows() == []
    assert len(world.state()["conversations"][C2]["items"]) == 1


def test_stop_live_during_a_read_is_honoured_when_the_read_ends(world: TickWorld) -> None:
    """Breaks if the next read is booked from the tick's own snapshot of the
    loop instead of a fresh read of it (the Updatable Timer)."""
    world.start_session()
    _live(world)
    world.say(C2, "Every door we lock costs us a story.")
    (booked,) = world.pending_rows()
    world.advance_to(_at(booked["scheduled_at"]))
    world.run_scheduler()

    async def scenario() -> dict:
        entered, release, hold = _hold_extraction_of(C2)
        world.models.before_extract = hold
        reading = asyncio.create_task(world.deliver_next())
        await entered.wait()
        await world.stop_live()
        release.set()
        return await reading

    result = world.run(scenario())

    assert result["status"] == "ok"
    assert world.pending_rows() == []
    assert world.loop()["status"] == "paused"
    assert world.payload()["loop"]["next_read_at"] is None


def test_a_scheduled_read_that_finds_the_run_lock_taken_writes_nothing(world: TickWorld) -> None:
    """Breaks if the run lock stops being taken per loop with SET NX before
    the state is read, so a scheduled read could run beside a refresh."""
    world.start_session()
    _live(world)
    world.say(C2, "Every door we lock costs us a story.")

    async def scenario() -> tuple[dict, dict, int, list[str]]:
        entered, release, hold = _hold_extraction_of(C2)
        world.models.before_extract = hold
        await world.request("manual")
        refresh = asyncio.create_task(world.deliver_next())
        await entered.wait()
        writes = len(world.directus.state_writes(world.loop_id))
        calls = len(world.models.calls)
        scheduled = await ticks.run_popcorn_tick(world.loop_id, "scheduled")
        written = len(world.directus.state_writes(world.loop_id)) - writes
        called = world.models.calls[calls:]
        release.set()
        return scheduled, await refresh, written, called

    scheduled, refresh, written, called = world.run(scenario())

    assert scheduled["status"] == "duplicate"
    assert scheduled["run"]["detail"] == "A tick is already running"
    assert written == 0 and called == []
    assert refresh["status"] == "ok"
    assert not world.redis.held(f"popcorn:run:{world.loop_id}")


# ── the gaps ─────────────────────────────────────────────────────────


class _WorkerDied(BaseException):
    """The worker process goes away mid-read: nothing in the tick catches it."""


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #1: a read cancels its own durable "
        "backup when it starts, so a crashed on-request read leaves nothing to re-drive"
    ),
)
def test_a_refresh_whose_worker_dies_mid_read_can_still_be_re_driven(world: TickWorld) -> None:
    world.start_session()
    world.say(C2, "Every door we lock costs us a story.")
    request_id = world.run(world.request("manual"))

    async def crash(cid: str) -> None:
        if cid == C2:
            raise _WorkerDied()

    world.models.before_extract = crash
    with pytest.raises(_WorkerDied):
        world.deliver()

    # The room is left with C2 "reading…" and no run for the request.
    assert world.payload()["counts"]["reading"] == 1
    assert world.run_row(request_id) is None
    # The request's durable row must still be there for the heal path to send.
    rows = world.request_rows(request_id)
    assert [row for row in rows if row["status"] in PENDING], [row["status"] for row in rows]


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #3: a request that arrives during a "
        "read waits 180 s for the lock and is then dropped as a no-op"
    ),
)
def test_a_rerun_pressed_during_a_long_read_runs_after_it(world: TickWorld) -> None:
    """The rerun's backup row is left to #1; only the direct delivery and what
    the running read hands on are delivered here."""
    world.start_session()
    world.say(C2, "Every door we lock costs us a story.")

    async def scenario() -> str:
        entered, release, hold = _hold_extraction_of(C2)
        world.models.before_extract = hold
        await world.request("manual")
        reading = asyncio.create_task(world.deliver_next())
        await entered.wait()
        rerun_id = await world.request("rerun")
        # The rerun's delivery finds the lock taken; the read outlasts the wait.
        await world.deliver_next()
        release.set()
        await reading
        return rerun_id

    rerun_id = world.run(scenario())
    world.deliver()

    run = world.run_row(rerun_id)
    assert run is not None, "the rerun was dropped"
    assert run["status"] == "ok" and "rerun: the previous state wiped" in run["detail"]


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #2: the run lock is not a fence; a "
        "read that lost its lock still overwrites the whole popcorn_state"
    ),
)
def test_a_read_that_lost_its_lock_does_not_overwrite_the_newer_holders_state(
    world: TickWorld,
) -> None:
    world.start_session()
    world.say(C2, "Every door we lock costs us a story.")

    async def scenario() -> dict:
        entered, release, hold = _hold_extraction_of(C2)
        world.models.before_extract = hold
        await world.request("manual")
        reading = asyncio.create_task(world.deliver_next())
        await entered.wait()
        # The lock's TTL ran out; a later read took it and wrote the state.
        world.redis.hand_over(f"popcorn:run:{world.loop_id}", "token-of-a-later-read")
        newer = copy.deepcopy(world.state())
        newer["run"] = 7
        await world.directus.update_item("agent_loop", world.loop_id, {"popcorn_state": newer})
        release.set()
        await reading
        return newer

    newer = world.run(scenario())

    assert world.state()["run"] == newer["run"], "the later read's state was overwritten"
    assert world.state() == newer


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #2: the run lock fails open, so a "
        "read goes ahead without it when Redis errors"
    ),
)
def test_a_read_that_cannot_reach_redis_does_not_run(world: TickWorld) -> None:
    world.start_session()
    world.say(C2, "Every door we lock costs us a story.")
    before = world.state()
    world.models.calls.clear()
    world.redis.down = True

    world.run(world.request("manual"))
    world.deliver()

    assert world.models.calls == []
    assert world.state() == before


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Cross-cutting #2: nothing bounds a tick's wall time; a hung "
        "await holds the run lock until the worker's time limit"
    ),
)
def test_a_read_with_a_hung_model_call_ends_on_its_own_deadline(world: TickWorld) -> None:
    from dembrane.tasks import TICK_TIME_LIMIT_MS

    world.start_session()
    world.say(C2, "Every door we lock costs us a story.")

    async def hang(cid: str) -> None:  # noqa: ARG001
        await asyncio.Event().wait()

    world.models.before_extract = hang

    async def scenario() -> tuple[dict | None, bool]:
        await world.request("manual")
        try:
            # Virtual time: the heartbeats tick by, no real second passes.
            result = await asyncio.wait_for(world.deliver_next(), TICK_TIME_LIMIT_MS / 1000)
        except TimeoutError:
            return None, False
        return result, world.redis.held(f"popcorn:run:{world.loop_id}")

    result, still_locked = world.run(scenario())

    assert result is not None, "the read was still hanging at the worker's time limit"
    assert result["status"] == "error" and not still_locked


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #4: a failed publication is never "
        "re-sent; the conversation is stamped validated before it publishes"
    ),
)
def test_a_publication_that_failed_is_sent_again_by_the_next_read(world: TickWorld) -> None:
    world.publications.owned = {"popcorn"}
    world.publications.up = False
    world.start_session()
    assert world.publications.attempts and not world.publications.published

    world.publications.up = True
    world.run(world.request("manual"))
    world.deliver()

    conversations = world.state()["conversations"]
    assert world.publications.published == {
        cid: [item["phrase"] for item in conversations[cid]["items"]] for cid in (C1, C2)
    }


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #5: the dashboard reads `status` "
        "alone, so live past its expiry shows as live when no read ran"
    ),
)
def test_live_past_its_expiry_reads_as_manual_even_if_no_read_ran(world: TickWorld) -> None:
    world.start_session()
    expires_at = _live(world)

    # The booked reads were lost with their worker; the clock passes the expiry.
    world.advance_to(expires_at + timedelta(minutes=5))

    assert world.payload()["loop"]["mode"] == "manual"


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #5: live ends only if a read runs; "
        "the popcorn sweep skips a live loop past its expiry instead of pausing it"
    ),
)
def test_the_popcorn_sweep_pauses_a_live_loop_whose_expiry_passed(world: TickWorld) -> None:
    """The sweep here is the popcorn reconciler the scheduler already runs."""
    world.start_session()
    expires_at = _live(world)
    (booked,) = world.pending_rows()
    world.advance_to(_at(booked["scheduled_at"]))
    world.run_scheduler()
    world.broker.clear()  # the chain's message is lost with its worker
    world.advance_to(expires_at + timedelta(minutes=5))

    world.run(ticks.reconcile_missing_popcorn_tick_tasks())

    assert world.loop()["status"] == "paused"


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #6: losing access counts as one "
        "failure of three instead of pausing live at once with a reason"
    ),
)
def test_a_read_that_loses_access_pauses_live_at_once_and_says_why(world: TickWorld) -> None:
    world.start_session()
    _live(world)
    world.reader_denied = True

    _next_booked_read(world)

    payload = world.payload()
    assert payload["loop"]["mode"] == "manual"
    assert world.pending_rows() == []
    assert "can no longer read" in payload["loop"]["last_run_detail"]


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #6: a Directus blip counts as a "
        "failure toward pausing live, the same as losing access"
    ),
)
def test_one_directus_blip_does_not_count_toward_pausing_live(world: TickWorld) -> None:
    world.start_session()
    _live(world)
    world.directus.fail_next_read("conversation_chunk", DirectusServerError("connection refused"))

    _next_booked_read(world)

    loop = world.loop()
    assert loop["status"] == "active"
    assert int(loop.get("failure_count") or 0) == 0
