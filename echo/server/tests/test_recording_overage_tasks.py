"""The two ticks actors are thin wrappers: they call the recording_overage
functions and log the counts. Scheduler registers both every two minutes."""

from __future__ import annotations

import dembrane.tasks as tasks


def test_close_actor_calls_module(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        "dembrane.recording_overage.close_finished_episodes", lambda: calls.append("close") or 2
    )
    tasks.task_close_recording_overage_episodes.fn()
    assert calls == ["close"]


def test_notify_actor_calls_module(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        "dembrane.recording_overage.file_pending_notifications", lambda: calls.append("notify") or 1
    )
    tasks.task_notify_recording_overage.fn()
    assert calls == ["notify"]


def test_actors_run_on_the_ticks_queue() -> None:
    assert tasks.task_close_recording_overage_episodes.queue_name == tasks.TICK_QUEUE
    assert tasks.task_notify_recording_overage.queue_name == tasks.TICK_QUEUE


def test_scheduler_registers_both_jobs() -> None:
    from dembrane.scheduler import scheduler

    ids = {job.id for job in scheduler.get_jobs()}
    assert {"task_close_recording_overage_episodes", "task_notify_recording_overage"} <= ids
