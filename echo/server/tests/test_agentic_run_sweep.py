"""Tests for task_fail_abandoned_agentic_runs.

A turn executes in-process on the API pod, so a restart or OOM kill leaves the
run row in `running` forever (no exception handler runs, and reconnects only
re-drive `queued` runs). The sweep must terminate those, and must NOT terminate
a healthy long run: there is no wall-clock cap on a turn, so liveness comes from
the Redis turn lease plus recent events, never from age alone.
"""

from __future__ import annotations

from typing import Any
from datetime import timedelta
from unittest.mock import MagicMock, patch

from dembrane.utils import get_utc_timestamp


def _iso(delta_seconds: int) -> str:
    return (get_utc_timestamp() + timedelta(seconds=delta_seconds)).isoformat()


class _FakeRunService:
    def __init__(
        self,
        *,
        latest_event: dict[str, Any] | None,
        latest_user_message: dict[str, Any] | None,
        status: str = "running",
    ) -> None:
        self._latest_event = latest_event
        self._latest_user_message = latest_user_message
        self._status = status
        self.appended: list[tuple[str, str, dict[str, Any]]] = []
        self.statuses: list[tuple[str, str]] = []

    def get_latest_event(self, run_id: str, *, event_type: str | None = None):
        if event_type == "user.message":
            return self._latest_user_message
        return self._latest_event

    def get_by_id_or_raise(self, run_id: str) -> dict[str, Any]:
        return {"id": run_id, "status": self._status}

    def append_event(self, run_id: str, event_type: str, payload: dict[str, Any]):
        self.appended.append((run_id, event_type, payload))
        return {"id": "event-1", "seq": 9, "event_type": event_type, "payload": payload}

    def set_status(self, run_id: str, status: str, **_kwargs: Any) -> dict[str, Any]:
        self.statuses.append((run_id, status))
        return {"id": run_id, "status": status}


def _run_sweep(
    *,
    service: _FakeRunService,
    lease_owner: str | None,
    running_rows: list[dict[str, Any]] | None = None,
):
    from dembrane import tasks as tasks_mod

    client = MagicMock()
    client.get_items.return_value = (
        running_rows if running_rows is not None else [{"id": "run-1"}]
    )
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=client)
    ctx.__exit__ = MagicMock(return_value=False)

    with (
        patch.object(tasks_mod, "directus_client_context", return_value=ctx),
        patch.object(tasks_mod, "agentic_run_service", service),
        patch.object(tasks_mod, "run_async_in_new_loop", return_value=lease_owner),
    ):
        tasks_mod.task_fail_abandoned_agentic_runs.fn()

    return client


def test_only_running_runs_are_considered():
    service = _FakeRunService(latest_event=None, latest_user_message=None)
    client = _run_sweep(service=service, lease_owner=None, running_rows=[])

    query = client.get_items.call_args[0][1]["query"]
    assert query["filter"]["status"] == {"_eq": "running"}


def test_run_with_recent_event_is_left_alone():
    """Events still arriving means the executor is alive."""
    service = _FakeRunService(
        latest_event={"seq": 8, "timestamp": _iso(-30)},
        latest_user_message={"seq": 1, "timestamp": _iso(-600)},
    )
    _run_sweep(service=service, lease_owner=None)

    assert service.statuses == []
    assert service.appended == []


def test_quiet_run_holding_its_lease_is_left_alone():
    """A long tool call can go minutes without persisting an event; the live
    lease proves the executor is still there."""
    service = _FakeRunService(
        latest_event={"seq": 8, "timestamp": _iso(-1800)},
        latest_user_message={"seq": 1, "timestamp": _iso(-1900)},
    )
    _run_sweep(service=service, lease_owner="owner-token-1")

    assert service.statuses == []
    assert service.appended == []


def test_quiet_run_without_a_lease_is_failed_with_an_event():
    service = _FakeRunService(
        latest_event={"seq": 8, "timestamp": _iso(-1800)},
        latest_user_message={"seq": 1, "timestamp": _iso(-1900)},
    )
    _run_sweep(service=service, lease_owner=None)

    assert service.statuses == [("run-1", "failed")]
    assert len(service.appended) == 1
    run_id, event_type, payload = service.appended[0]
    assert run_id == "run-1"
    assert event_type == "run.failed"
    assert payload["error_code"] == "AGENT_ABANDONED"


def test_run_that_reached_a_terminal_status_mid_sweep_is_skipped():
    service = _FakeRunService(
        latest_event={"seq": 8, "timestamp": _iso(-1800)},
        latest_user_message={"seq": 1, "timestamp": _iso(-1900)},
        status="completed",
    )
    _run_sweep(service=service, lease_owner=None)

    assert service.statuses == []
    assert service.appended == []


def test_scheduler_registers_the_sweep():
    from dembrane import scheduler

    job = scheduler.scheduler.get_job("task_fail_abandoned_agentic_runs")
    assert job is not None


def test_failure_copy_follows_the_style_guide():
    from dembrane.tasks import AGENT_ABANDONED_MESSAGE

    assert "—" not in AGENT_ABANDONED_MESSAGE
    assert "successfully" not in AGENT_ABANDONED_MESSAGE.lower()
    assert " AI " not in f" {AGENT_ABANDONED_MESSAGE} "
