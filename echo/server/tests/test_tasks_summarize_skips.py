"""
task_summarize_conversation must not churn on conversations it can never
summarize: a soft-deleted project (ProjectNotFoundException) and a tier-locked
conversation are both skipped cleanly, without an error-level processing
status row and without a dramatiq retry.
"""

from __future__ import annotations

from contextlib import nullcontext

import dembrane.tasks as tasks
import dembrane.coordination as coordination
from dembrane.service import conversation_service
from dembrane.service.project import ProjectNotFoundException


def _patch(monkeypatch, cleared, conversation, statuses):
    def _status(**_kw):
        statuses.append(_kw.get("event_prefix"))
        return nullcontext()

    monkeypatch.setattr(tasks, "ProcessingStatusContext", _status)
    monkeypatch.setattr(conversation_service, "get_by_id_or_raise", lambda _cid: conversation)
    monkeypatch.setattr(
        conversation_service,
        "get_chunk_counts",
        lambda _cid: {"total": 1, "ok": 1, "error": 0, "processed": 1, "pending": 0},
    )
    monkeypatch.setattr(coordination, "mark_summarize_in_progress", lambda _cid: True)
    monkeypatch.setattr(
        coordination, "clear_summarize_in_progress", lambda cid: cleared.append(cid)
    )


def _close(coro_or_factory):
    coro = coro_or_factory() if callable(coro_or_factory) else coro_or_factory
    try:
        coro.close()
    except Exception:
        pass


def test_project_gone_skips_without_retry(monkeypatch):
    cleared: list[str] = []
    statuses: list[str] = []
    _patch(
        monkeypatch,
        cleared,
        {"id": "c1", "is_finished": True, "summary": None, "project_id": "p-deleted"},
        statuses,
    )

    def _run(coro_or_factory):
        _close(coro_or_factory)
        raise ProjectNotFoundException()

    monkeypatch.setattr(tasks, "run_async_in_new_loop", _run)

    assert tasks.task_summarize_conversation("c1") is None
    assert cleared == ["c1"]


def test_tier_locked_conversation_is_skipped_before_summarizing(monkeypatch):
    cleared: list[str] = []
    statuses: list[str] = []
    _patch(
        monkeypatch,
        cleared,
        {
            "id": "c2",
            "is_finished": True,
            "summary": None,
            "project_id": "p1",
            "is_over_cap": True,
        },
        statuses,
    )
    calls: list[str] = []

    def _run(coro_or_factory):
        calls.append("run")
        _close(coro_or_factory)
        return "free"  # the tier lookup; summarize itself must never run

    monkeypatch.setattr(tasks, "run_async_in_new_loop", _run)

    assert tasks.task_summarize_conversation("c2") is None
    assert calls == ["run"]
    # No processing-status row (that is what wrote the 402 error line every 5 min).
    assert statuses == []


def test_over_cap_on_paid_tier_still_summarizes(monkeypatch):
    cleared: list[str] = []
    statuses: list[str] = []
    _patch(
        monkeypatch,
        cleared,
        {
            "id": "c3",
            "is_finished": True,
            "summary": None,
            "project_id": "p1",
            "is_over_cap": True,
        },
        statuses,
    )
    results = iter(["changemaker", None])

    def _run(coro_or_factory):
        _close(coro_or_factory)
        return next(results)

    monkeypatch.setattr(tasks, "run_async_in_new_loop", _run)

    assert tasks.task_summarize_conversation("c3") is None
    assert statuses == ["task_summarize_conversation"]
    assert cleared == ["c3"]
