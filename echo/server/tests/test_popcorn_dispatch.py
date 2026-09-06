from __future__ import annotations

import asyncio

from dembrane.popcorn import ticks, service


def test_direct_and_scheduled_delivery_preserve_the_request_id(monkeypatch) -> None:
    import dembrane.tasks as tasks

    calls: list[tuple[str, str, str | None]] = []

    async def _tick(loop_id, tick_kind, request_id=None):
        calls.append((loop_id, tick_kind, request_id))

    monkeypatch.setattr(ticks, "run_popcorn_tick", _tick)
    monkeypatch.setattr(tasks, "run_async_in_new_loop", lambda factory: asyncio.run(factory()))
    monkeypatch.setattr(tasks.task_popcorn_tick_now, "send", tasks.task_popcorn_tick_now.fn)

    service.dispatch_popcorn_tick_now("loop1", "rerun", request_id="shared")
    tasks._dispatch_scheduled_task(
        {
            "task_type": "popcorn_tick",
            "payload": {"loop_id": "loop1", "tick_kind": "rerun", "request_id": "shared"},
        }
    )
    # Messages enqueued before the new optional argument still run.
    tasks.task_popcorn_tick_now("loop1", "manual")
    assert calls == [
        ("loop1", "rerun", "shared"),
        ("loop1", "rerun", "shared"),
        ("loop1", "manual", None),
    ]
