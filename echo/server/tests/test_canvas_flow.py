"""The canvas tick as a flow: a host action (resume, a host item) books a
`canvas_tick` row; the minute scheduler sends it; the ticks worker runs
`run_tick`; the loop's ledgers and a generation are written and the next read
is booked. Fakes only at the edges (tests/popcorn_flow_fakes.py): Directus,
Redis, the clock, the model call and the canvas gather.

The unit-level behaviour stays in test_canvas_ticks.py and
test_canvas_service.py. The strict xfails are item #7 of "Popcorn and canvas
ticks" in the review of September 23rd 2026 ("Ticks, analysis and Map against
Temporal's patterns"); each describes the behaviour wanted.
"""

from __future__ import annotations

import pytest

from dembrane.canvas.ticks import _parse_dt
from tests.popcorn_flow_fakes import TickWorld


@pytest.fixture
def world(monkeypatch) -> TickWorld:
    world = TickWorld().install(monkeypatch)
    world.start_canvas()
    return world


def _pending(world: TickWorld) -> list[dict]:
    return world.pending_rows(world.canvas_loop_id, task_type="canvas_tick")


def _live_with_a_first_read(world: TickWorld) -> None:
    """The host resumes the canvas; its first read runs and fills the wall."""
    world.run(world.canvas_action("resume"))
    world.run_scheduler()
    world.deliver()
    ledger = world.loop(world.canvas_loop_id)["canvas_quotes_ledger"]
    assert [quote["quote"] for quote in ledger] == ["Keep the doorway open."]


def test_each_scheduled_canvas_read_books_exactly_one_next_read(world: TickWorld) -> None:
    """Breaks if a scheduled canvas read stops booking its successor (the live
    chain dies) or books more than one, including after a no-change read."""
    _live_with_a_first_read(world)
    (booked,) = _pending(world)
    assert booked["payload"]["tick_kind"] == "scheduled"

    # Nothing new was said: the read is a no-op and still books the next.
    world.canvas_models.calls.clear()
    at = _parse_dt(booked["scheduled_at"])
    assert at is not None
    world.advance_to(at)
    world.run_scheduler()
    world.deliver()

    latest = max(world.runs(world.canvas_loop_id), key=lambda run: run["started_at"])
    assert latest["status"] == "no_op" and world.canvas_models.calls == []
    (after,) = _pending(world)
    assert after["id"] != booked["id"]


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #7: host items are read-modify-write "
        "against the tick's snapshot, so one added during a read is overwritten"
    ),
)
def test_a_host_item_added_while_a_canvas_read_runs_survives_it(world: TickWorld) -> None:
    world.run(world.canvas_action("resume"))

    async def the_host_adds_an_item() -> None:
        world.canvas_models.before_extract = None
        await world.canvas_host_item("Bring your own mug")

    world.canvas_models.before_extract = the_host_adds_an_item
    world.run_scheduler()
    world.deliver()
    assert any(
        item.get("text") == "Bring your own mug"
        for collection, item_id, patch in world.directus.writes
        if collection == "agent_loop" and item_id == world.canvas_loop_id
        for item in patch.get("canvas_host_items") or []
    ), "the host item was never written"
    # The read the host item asked for runs too.
    world.run_scheduler()
    world.deliver()

    items = world.loop(world.canvas_loop_id)["canvas_host_items"]
    assert [item["text"] for item in items] == ["Bring your own mug"]


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Review 2026-09-23 Popcorn and canvas ticks #7: a manual canvas read books the "
        "next read without cancelling the live chain's, so live grows a second chain"
    ),
)
def test_a_host_item_during_live_does_not_start_a_second_chain(world: TickWorld) -> None:
    _live_with_a_first_read(world)
    assert len(_pending(world)) == 1
    world.clock.advance(60)

    world.run(world.canvas_host_item("Bring your own mug"))
    world.run_scheduler()  # sends the manual read the item asked for, not the chain's
    world.deliver()

    assert len(_pending(world)) == 1
