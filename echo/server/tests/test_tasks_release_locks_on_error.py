"""Locked actors release their Redis lock before re-raising a transient error.

Dramatiq's default backoff puts the first retries at 15, 30 and 60 seconds,
all inside the 5 or 10 minute lock TTL. A retry that finds the lock still held
logs "already in progress" and acks, doing no work. Releasing the lock lets the
retry (or the catch-up scheduler, whichever comes first) redo the step; both
check for completed work before starting, so nothing runs twice.
"""

from __future__ import annotations

import pytest

import dembrane.tasks as tasks
import dembrane.coordination as coordination
from dembrane.service import conversation_service


def test_finalize_releases_lock_on_transient_error(monkeypatch):
    cleared: list[str] = []
    monkeypatch.setattr(
        conversation_service,
        "get_by_id_or_raise",
        lambda cid: {"id": cid, "is_all_chunks_transcribed": False},
    )
    monkeypatch.setattr(coordination, "mark_finalize_in_progress", lambda _cid: True)
    monkeypatch.setattr(coordination, "clear_finalize_in_progress", lambda cid: cleared.append(cid))

    def _boom(_cid):
        raise RuntimeError("redis blip")

    monkeypatch.setattr(coordination, "get_pending_chunks", _boom)

    with pytest.raises(RuntimeError):
        tasks.task_finalize_conversation("c1")
    assert cleared == ["c1"]


def test_finish_hook_releases_lock_on_transient_error(monkeypatch):
    cleared: list[str] = []
    monkeypatch.setattr(
        conversation_service, "get_by_id_or_raise", lambda cid: {"id": cid, "is_finished": False}
    )
    monkeypatch.setattr(coordination, "mark_finish_in_progress", lambda _cid: True)
    monkeypatch.setattr(coordination, "clear_finish_in_progress", lambda cid: cleared.append(cid))

    def _boom(**_kw):
        raise RuntimeError("directus blip")

    monkeypatch.setattr(conversation_service, "update", _boom)

    with pytest.raises(RuntimeError):
        tasks.task_finish_conversation_hook("c1")
    assert cleared == ["c1"]


def test_failure_before_acquiring_does_not_release_another_workers_lock(monkeypatch):
    """A duplicate task whose Directus lookup fails must not free the lock the
    first task is working under."""
    cleared: list[str] = []

    def _boom(_cid):
        raise RuntimeError("directus blip")

    monkeypatch.setattr(conversation_service, "get_by_id_or_raise", _boom)
    monkeypatch.setattr(coordination, "clear_finalize_in_progress", lambda cid: cleared.append(cid))
    monkeypatch.setattr(coordination, "clear_finish_in_progress", lambda cid: cleared.append(cid))
    monkeypatch.setattr(
        coordination, "clear_summarize_in_progress", lambda cid: cleared.append(cid)
    )

    for actor in (
        tasks.task_finalize_conversation,
        tasks.task_finish_conversation_hook,
        tasks.task_summarize_conversation,
    ):
        with pytest.raises(RuntimeError):
            actor("c1")
    assert cleared == []
