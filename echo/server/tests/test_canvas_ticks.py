from __future__ import annotations

from typing import Any
from datetime import datetime, timezone, timedelta

import pytest

import dembrane.canvas.ticks as ticks
import dembrane.scheduled_tasks as scheduled_tasks


class _FakeDirectus:
    def __init__(self) -> None:
        self.items = {
            "agent_loop": {
                "loop1": {
                    "id": "loop1",
                    "project_id": "p1",
                    "report_id": "r1",
                    "status": "active",
                    "expires_at": "2099-01-01T00:00:00+00:00",
                    "cadence_minutes": 5,
                    "acting_directus_user_id": "du1",
                    "failure_count": 0,
                }
            }
        }
        self.created: dict[str, list[dict[str, Any]]] = {}
        self.updated: list[tuple[str, str, dict[str, Any]]] = []
        self.latest_generation = {
            "id": "g-old",
            "content_html": "<html><body>old</body></html>",
            "created_at": "2026-07-07T10:10:00+00:00",
        }
        self.scheduled_tasks: list[dict[str, Any]] = []

    async def get_item(self, collection: str, item_id: str) -> dict[str, Any] | None:
        return self.items.get(collection, {}).get(item_id)

    async def get_items(self, collection: str, params: dict) -> list[dict[str, Any]]:
        if collection == "canvas_generation":
            return [self.latest_generation]
        if collection == "agent_loop":
            rows = list(self.items.get("agent_loop", {}).values())
            status = ((params.get("query") or {}).get("filter") or {}).get("status") or {}
            expires_at = ((params.get("query") or {}).get("filter") or {}).get("expires_at") or {}
            if status.get("_eq"):
                rows = [row for row in rows if row.get("status") == status["_eq"]]
            if expires_at.get("_gt"):
                rows = [
                    row
                    for row in rows
                    if row.get("expires_at") and row["expires_at"] > expires_at["_gt"]
                ]
            return rows
        if collection == "scheduled_task":
            return self.scheduled_tasks
        return []

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        self.created.setdefault(collection, []).append(data)
        return {"data": data}

    async def update_item(self, collection: str, item_id: str, data: dict[str, Any]) -> dict:
        self.updated.append((collection, item_id, data))
        self.items.setdefault(collection, {}).setdefault(item_id, {}).update(data)
        return {"data": self.items[collection][item_id]}


@pytest.fixture(autouse=True)
def _claim_tick_window(monkeypatch) -> None:
    async def _claim(loop: dict[str, Any], started_at: datetime) -> bool:  # noqa: ARG001
        return True

    monkeypatch.setattr(ticks, "_claim_scheduled_tick_window", _claim)


@pytest.mark.asyncio
async def test_tick_no_op_when_no_new_content(monkeypatch) -> None:
    fake = _FakeDirectus()

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:00:00+00:00",
            "project": {},
            "conversations": [],
        }

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "no_op"
    assert fake.created["agent_loop_run"][0]["status"] == "no_op"
    assert "canvas_generation" not in fake.created


@pytest.mark.asyncio
async def test_tick_duplicate_window_exits_without_enqueuing(monkeypatch) -> None:
    fake = _FakeDirectus()
    enqueued: list[str] = []

    async def _claim(loop: dict[str, Any], started_at: datetime) -> bool:  # noqa: ARG001
        return False

    async def _enqueue(loop: dict[str, Any]) -> None:
        enqueued.append(str(loop["id"]))

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_claim_scheduled_tick_window", _claim)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "duplicate"
    assert fake.created["agent_loop_run"][0]["status"] == "no_op"
    assert fake.created["agent_loop_run"][0]["detail"] == "Duplicate tick for cadence window"
    assert "canvas_generation" not in fake.created
    assert enqueued == []


@pytest.mark.asyncio
async def test_tick_error_stores_error_generation_and_pauses_after_three(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.items["agent_loop"]["loop1"]["failure_count"] = 2

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {},
            "conversations": [],
        }

    async def _generate(**kwargs) -> str:  # noqa: ARG001
        return "garbage"

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_generate_html", _generate)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "error"
    assert fake.created["canvas_generation"][0]["status"] == "error"
    assert fake.created["agent_loop_run"][0]["status"] == "error"
    assert ("agent_loop", "loop1", {"failure_count": 3, "status": "paused"}) in fake.updated


@pytest.mark.asyncio
async def test_tick_missing_ids_records_error_run_without_generation(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.items["agent_loop"]["loop1"]["report_id"] = None

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    result = await ticks.run_tick("loop1", "scheduled")

    assert result["status"] == "error"
    assert "canvas_generation" not in fake.created
    assert fake.created["agent_loop_run"][0]["status"] == "error"
    assert fake.created["agent_loop_run"][0]["generation_id"] is None
    assert "missing required ids" in fake.created["agent_loop_run"][0]["detail"]


@pytest.mark.asyncio
async def test_enqueue_next_tick_uses_final_slot_before_expiry(monkeypatch) -> None:
    fake = _FakeDirectus()
    now = datetime(2026, 7, 7, 10, 0, 0, tzinfo=timezone.utc)
    fake.items["agent_loop"]["loop1"]["expires_at"] = (now + timedelta(minutes=3)).isoformat()
    enqueued: list[dict[str, Any]] = []

    async def _schedule_task(**kwargs) -> str:
        enqueued.append(kwargs)
        return "task1"

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_now", lambda: now)
    monkeypatch.setattr(scheduled_tasks, "schedule_task", _schedule_task)

    await ticks._enqueue_next_if_due(fake.items["agent_loop"]["loop1"])

    assert enqueued[0]["task_type"] == scheduled_tasks.TASK_CANVAS_TICK
    assert enqueued[0]["scheduled_at"] == now + timedelta(minutes=3, seconds=-5)


@pytest.mark.asyncio
async def test_tick_ok_records_banned_visible_copy_without_rewriting(monkeypatch) -> None:
    fake = _FakeDirectus()

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {
            "latest_content_at": "2026-07-07T10:20:00+00:00",
            "project": {},
            "conversations": [],
        }

    async def _generate(**kwargs) -> str:  # noqa: ARG001
        return '<div class="canvas-shell"><p>Real-time reflections — created successfully by AI.</p></div>'

    async def _enqueue(loop: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    async def _publish(report_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_latest_config", _config)
    monkeypatch.setattr(ticks, "execute_gather_spec", _gather)
    monkeypatch.setattr(ticks, "_generate_html", _generate)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)
    monkeypatch.setattr(ticks, "publish_generation_nudge", _publish)

    result = await ticks.run_tick("loop1", "scheduled")

    generation = result["generation"]
    assert generation["status"] == "ok"
    assert "Real-time reflections" in generation["content_html"]
    assert generation["detail"] == "banned visible copy: real-time, AI, successfully, em dash"


@pytest.mark.asyncio
async def test_reconcile_missing_canvas_tick_tasks_enqueues_orphaned_active_loop(
    monkeypatch,
) -> None:
    fake = _FakeDirectus()
    now = datetime(2026, 7, 7, 10, 0, 0, tzinfo=timezone.utc)
    fake.items["agent_loop"]["covered"] = {
        **fake.items["agent_loop"]["loop1"],
        "id": "covered",
    }
    fake.scheduled_tasks = [
        {
            "payload": {"loop_id": "covered"},
            "status": scheduled_tasks.STATUS_SCHEDULED,
            "task_type": scheduled_tasks.TASK_CANVAS_TICK,
        }
    ]
    enqueued: list[str] = []

    async def _enqueue(loop: dict[str, Any]) -> None:
        enqueued.append(str(loop["id"]))

    monkeypatch.setattr(ticks, "async_directus", fake)
    monkeypatch.setattr(ticks, "_now", lambda: now)
    monkeypatch.setattr(ticks, "_enqueue_next_if_due", _enqueue)

    count = await ticks.reconcile_missing_canvas_tick_tasks()

    assert count == 1
    assert enqueued == ["loop1"]
