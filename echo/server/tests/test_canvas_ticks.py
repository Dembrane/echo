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

    async def get_item(self, collection: str, item_id: str) -> dict[str, Any] | None:
        return self.items.get(collection, {}).get(item_id)

    async def get_items(self, collection: str, params: dict) -> list[dict[str, Any]]:
        if collection == "canvas_generation":
            return [self.latest_generation]
        return []

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        self.created.setdefault(collection, []).append(data)
        return {"data": data}

    async def update_item(self, collection: str, item_id: str, data: dict[str, Any]) -> dict:
        self.updated.append((collection, item_id, data))
        self.items.setdefault(collection, {}).setdefault(item_id, {}).update(data)
        return {"data": self.items[collection][item_id]}


@pytest.mark.asyncio
async def test_tick_no_op_when_no_new_content(monkeypatch) -> None:
    fake = _FakeDirectus()

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {"latest_content_at": "2026-07-07T10:00:00+00:00", "project": {}, "conversations": []}

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
async def test_tick_error_stores_error_generation_and_pauses_after_three(monkeypatch) -> None:
    fake = _FakeDirectus()
    fake.items["agent_loop"]["loop1"]["failure_count"] = 2

    async def _config(report_id: str) -> dict[str, Any]:  # noqa: ARG001
        return {"id": "cfg1", "brief": "brief", "gather_spec": {}, "cadence_minutes": 5}

    async def _gather(**kwargs) -> dict[str, Any]:  # noqa: ARG001
        return {"latest_content_at": "2026-07-07T10:20:00+00:00", "project": {}, "conversations": []}

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
