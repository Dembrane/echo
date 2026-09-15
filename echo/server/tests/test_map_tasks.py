"""Map's background jobs: which worker runs them and what a dropped check leaves."""

from __future__ import annotations

import inspect
from typing import Any, Callable

import pytest

import dembrane.tasks as tasks
from dembrane.tasks import (
    TICK_QUEUE,
    TICK_TIME_LIMIT_MS,
    task_map_generate,
    task_map_fact_check,
    task_transcribe_chunk,
)


def test_map_generation_rides_the_ticks_queue_with_the_long_limit_and_no_retries() -> None:
    assert task_map_generate.queue_name == TICK_QUEUE
    assert task_map_generate.options["time_limit"] == TICK_TIME_LIMIT_MS
    assert task_map_generate.options["max_retries"] == 0


def test_map_fact_checks_ride_the_network_queue_below_transcription() -> None:
    assert task_map_fact_check.queue_name == task_transcribe_chunk.queue_name == "network"
    # Dramatiq serves lower priority numbers first.
    assert task_map_fact_check.priority > task_transcribe_chunk.priority
    assert task_map_fact_check.options["max_retries"] == 0


class _Runner:
    """Stands in for run_async_in_new_loop: records which coroutine it was given."""

    def __init__(self, fail_first: bool = False) -> None:
        self.fail_first = fail_first
        self.seen: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, factory: Callable[[], Any]) -> None:
        coroutine = factory()
        self.seen.append((coroutine.cr_code.co_name, dict(inspect.getcoroutinelocals(coroutine))))
        coroutine.close()
        if self.fail_first and len(self.seen) == 1:
            raise RuntimeError("the shared loop was reset")


def test_the_generation_actor_runs_one_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = _Runner()
    monkeypatch.setattr(tasks, "run_async_in_new_loop", runner)

    task_map_generate.fn("r1")

    assert [name for name, _ in runner.seen] == ["run_generation"]
    assert runner.seen[0][1]["result_id"] == "r1"


def test_a_fact_check_the_loop_drops_is_marked_interrupted(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = _Runner(fail_first=True)
    monkeypatch.setattr(tasks, "run_async_in_new_loop", runner)

    with pytest.raises(RuntimeError):
        task_map_fact_check.fn("fc1", 3, "r1", "a-1")

    assert [name for name, _ in runner.seen] == ["run_fact_check", "mark_interrupted"]
    interrupted = runner.seen[1][1]
    assert interrupted["fact_check_id"] == "fc1" and interrupted["attempt"] == 3


def test_a_fact_check_that_finishes_is_not_marked(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = _Runner()
    monkeypatch.setattr(tasks, "run_async_in_new_loop", runner)

    task_map_fact_check.fn("fc1", 1, "r1", "a-1")

    assert [name for name, _ in runner.seen] == ["run_fact_check"]
