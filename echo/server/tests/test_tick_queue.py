"""Ticks run on their own queue, and the Redis client follows the loop.

The gevent worker's shared async loop is reset by the self-heal whenever any
actor trips an async-runtime error, and a reset destroys every coroutine in
flight. A tick runs for minutes, so on a busy worker it never finished. Ticks
now go to the `ticks` queue, served by a worker without gevent; and the Redis
client is cached per loop, so a reset no longer turns every lock and heartbeat
call into a further reset.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

import dembrane.redis_async as redis_async
import dembrane.async_helpers as async_helpers
from dembrane.tasks import (
    TICK_QUEUE,
    TICK_TIME_LIMIT_MS,
    _run_canvas_tick,
    task_canvas_tick,
    _run_popcorn_tick,
    task_popcorn_tick_now,
)
from dembrane.redis_async import get_redis_client
from dembrane.async_helpers import reset_background_loop, run_async_in_new_loop


@pytest.fixture(autouse=True)
def _fresh_runtime():
    reset_background_loop("test setup")
    redis_async.reset_clients()
    yield
    reset_background_loop("test teardown")


def test_tick_actors_live_on_the_ticks_queue_with_a_long_limit():
    for actor in (task_popcorn_tick_now, task_canvas_tick):
        assert actor.queue_name == TICK_QUEUE
        assert actor.options["time_limit"] == TICK_TIME_LIMIT_MS
        assert actor.options["max_retries"] == 0


def test_scheduled_ticks_are_forwarded_to_the_ticks_queue():
    with patch.object(task_popcorn_tick_now, "send") as popcorn_send:
        _run_popcorn_tick({"loop_id": "L1", "tick_kind": "scheduled", "request_id": "R1"})
    popcorn_send.assert_called_once_with("L1", "scheduled", request_id="R1")

    with patch.object(task_canvas_tick, "send") as canvas_send:
        _run_canvas_tick({"loop_id": "L2"})
    canvas_send.assert_called_once_with("L2", "scheduled")

    with pytest.raises(ValueError):
        _run_popcorn_tick({})


def test_redis_client_survives_a_shared_loop_reset(monkeypatch):
    """The Redis client must follow the loop it is used on, not the loop that
    first created it, or every call after a reset fails and, since v2.4.0,
    triggers a further reset."""
    rescues: list[str] = []
    real_reset = async_helpers._reset_async_runtime_for_retry

    def _counting_reset(reason: str) -> None:
        rescues.append(reason)
        real_reset(reason)

    monkeypatch.setattr(async_helpers, "_reset_async_runtime_for_retry", _counting_reset)

    async def _ping() -> bool:
        client = await get_redis_client()
        return bool(await client.ping())

    assert run_async_in_new_loop(lambda: _ping()) is True
    reset_background_loop("simulated self-heal")
    assert run_async_in_new_loop(lambda: _ping()) is True
    assert rescues == [], f"the runner had to reset the loop again to recover: {rescues}"
