"""
task_summarize_conversation must treat a tier-lock (HTTPException 402) as
non-retriable: return cleanly and clear the summarize lock so the catch-up
scheduler re-attempts it (and succeeds once the workspace upgrades). Genuine
errors must still retry (re-raise, lock retained).
"""

from __future__ import annotations

from contextlib import nullcontext

import pytest

import dembrane.tasks as tasks
import dembrane.coordination as coordination
from dembrane.service import conversation_service


class _Locked402(Exception):
    """Mimics fastapi.HTTPException(status_code=402) — what summarize raises when locked."""

    status_code = 402


def _common_monkeypatch(monkeypatch, cleared):
    monkeypatch.setattr(tasks, "ProcessingStatusContext", lambda **_kw: nullcontext())
    monkeypatch.setattr(
        conversation_service,
        "get_by_id_or_raise",
        lambda cid: {"id": cid, "is_finished": False, "summary": None, "project_id": "p1"},
    )
    monkeypatch.setattr(
        conversation_service,
        "get_chunk_counts",
        lambda _cid: {"total": 1, "ok": 1, "error": 0, "processed": 1, "pending": 0},
    )
    monkeypatch.setattr(coordination, "mark_summarize_in_progress", lambda _cid: True)
    monkeypatch.setattr(
        coordination, "clear_summarize_in_progress", lambda cid: cleared.append(cid)
    )


def _raise_in_loop(exc):
    def _run(coro_or_factory):
        # the actor passes a summarize_conversation factory here; close the
        # created coroutine to avoid an "un-awaited coroutine" warning.
        coro = coro_or_factory() if callable(coro_or_factory) else coro_or_factory
        try:
            coro.close()
        except Exception:
            pass
        raise exc

    return _run


def test_summarize_tier_locked_402_skips_retry_and_clears_lock(monkeypatch):
    cleared: list[str] = []
    _common_monkeypatch(monkeypatch, cleared)
    monkeypatch.setattr(
        tasks,
        "run_async_in_new_loop",
        _raise_in_loop(_Locked402("Conversation is locked. Upgrade to generate a summary.")),
    )

    # Must NOT raise (so dramatiq does not retry / dead-letter the message).
    assert tasks.task_summarize_conversation("conv-locked") is None
    # Lock cleared so the catch-up scheduler can re-attempt after upgrade.
    assert cleared == ["conv-locked"]


def test_summarize_genuine_error_still_retries(monkeypatch):
    cleared: list[str] = []
    _common_monkeypatch(monkeypatch, cleared)
    monkeypatch.setattr(
        tasks, "run_async_in_new_loop", _raise_in_loop(RuntimeError("transient LLM error"))
    )

    # Non-402 errors must propagate so dramatiq retries them...
    with pytest.raises(RuntimeError):
        tasks.task_summarize_conversation("conv-error")
    # ...and the lock must be retained (let TTL handle it during the retry window).
    assert cleared == []


def test_summarize_delegates_retry_boundary_to_async_helper(monkeypatch):
    cleared: list[str] = []
    calls: list[str] = []
    _common_monkeypatch(monkeypatch, cleared)
    monkeypatch.setattr(
        conversation_service,
        "get_by_id_or_raise",
        lambda cid: {"id": cid, "is_finished": False, "summary": None, "project_id": None},
    )

    def _run(coro_or_factory):
        calls.append("run")
        assert callable(coro_or_factory)
        coro = coro_or_factory()
        try:
            coro.close()
        except Exception:
            pass
        return None

    monkeypatch.setattr(tasks, "run_async_in_new_loop", _run)

    assert tasks.task_summarize_conversation("conv-shared-retry") is None
    assert calls == ["run"]
    assert cleared == ["conv-shared-retry"]
