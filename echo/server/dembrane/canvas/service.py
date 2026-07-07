"""Canvas configuration and loop service."""

from __future__ import annotations

from typing import Any
from datetime import datetime, timezone

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus
from dembrane.scheduled_tasks import TASK_CANVAS_TICK, schedule_task, cancel_pending_tasks

DEFAULT_CADENCE_MINUTES = 5


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _data(result: dict[str, Any]) -> dict[str, Any]:
    return result["data"]


async def enqueue_canvas_tick(loop_id: str, when: datetime | None = None) -> str:
    return await schedule_task(
        task_type=TASK_CANVAS_TICK,
        scheduled_at=when or _now(),
        payload={"loop_id": loop_id, "tick_kind": "scheduled"},
    )


async def create_canvas(
    *,
    project_id: str,
    name: str,
    brief: str,
    gather_spec: dict[str, Any] | None,
    cadence_minutes: int,
    expires_at: str,
    acting_directus_user_id: str,
    created_from_chat_id: str | None = None,
) -> dict[str, Any]:
    """Create the report row, first config revision, active loop, and first tick."""
    cadence = cadence_minutes or DEFAULT_CADENCE_MINUTES
    report = _data(
        await async_directus.create_item(
            "project_report",
            {
                "project_id": project_id,
                "kind": "canvas",
                "status": "published",
                "user_instructions": name,
                "content": "",
                "user_created": acting_directus_user_id,
            },
        )
    )
    report_id = str(report["id"])
    config = _data(
        await async_directus.create_item(
            "canvas_config_revision",
            {
                "id": generate_uuid(),
                "report_id": report_id,
                "brief": brief,
                "gather_spec": gather_spec or {"window_minutes": 60},
                "cadence_minutes": cadence,
                "created_by": acting_directus_user_id,
                "note": "initial",
            },
        )
    )
    loop = _data(
        await async_directus.create_item(
            "agent_loop",
            {
                "id": generate_uuid(),
                "project_id": project_id,
                "report_id": report_id,
                "name": name,
                "status": "active",
                "expires_at": expires_at,
                "cadence_minutes": cadence,
                "acting_directus_user_id": acting_directus_user_id,
                "created_from_chat_id": created_from_chat_id,
                "failure_count": 0,
                "caps": {},
            },
        )
    )
    await enqueue_canvas_tick(str(loop["id"]))
    return {"report": report, "config_revision": config, "loop": loop}


async def revise_config(
    *,
    report_id: str,
    brief: str,
    gather_spec: dict[str, Any] | None,
    cadence_minutes: int,
    created_by: str,
    note: str | None = None,
) -> dict[str, Any]:
    return _data(
        await async_directus.create_item(
            "canvas_config_revision",
            {
                "id": generate_uuid(),
                "report_id": report_id,
                "brief": brief,
                "gather_spec": gather_spec or {"window_minutes": 60},
                "cadence_minutes": cadence_minutes,
                "created_by": created_by,
                "note": note,
            },
        )
    )


async def get_latest_config(report_id: str) -> dict[str, Any] | None:
    rows = await async_directus.get_items(
        "canvas_config_revision",
        {
            "query": {
                "filter": {"report_id": {"_eq": report_id}},
                "fields": ["id", "report_id", "brief", "gather_spec", "cadence_minutes", "created_at"],
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def get_loop_for_report(report_id: str) -> dict[str, Any] | None:
    rows = await async_directus.get_items(
        "agent_loop",
        {
            "query": {
                "filter": {"report_id": {"_eq": report_id}},
                "fields": [
                    "id",
                    "project_id",
                    "report_id",
                    "name",
                    "status",
                    "expires_at",
                    "cadence_minutes",
                    "acting_directus_user_id",
                    "failure_count",
                ],
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def get_latest_generation(report_id: str) -> dict[str, Any] | None:
    rows = await list_generations(report_id=report_id, limit=1)
    return rows[0] if rows else None


async def list_generations(report_id: str, limit: int = 8) -> list[dict[str, Any]]:
    rows = await async_directus.get_items(
        "canvas_generation",
        {
            "query": {
                "filter": {"report_id": {"_eq": report_id}},
                "fields": [
                    "id",
                    "report_id",
                    "config_revision_id",
                    "content_html",
                    "status",
                    "tick_kind",
                    "detail",
                    "created_at",
                ],
                "sort": ["-created_at"],
                "limit": max(1, min(limit, 50)),
            }
        },
    )
    return rows if isinstance(rows, list) else []


async def pause_loop(loop_id: str) -> dict[str, Any]:
    await cancel_pending_tasks(task_type=TASK_CANVAS_TICK, payload_match={"loop_id": loop_id})
    return _data(await async_directus.update_item("agent_loop", loop_id, {"status": "paused"}))


async def resume_loop(loop_id: str) -> dict[str, Any]:
    loop = _data(
        await async_directus.update_item(
            "agent_loop", loop_id, {"status": "active", "failure_count": 0}
        )
    )
    await enqueue_canvas_tick(loop_id)
    return loop


async def stop_loop(loop_id: str) -> dict[str, Any]:
    await cancel_pending_tasks(task_type=TASK_CANVAS_TICK, payload_match={"loop_id": loop_id})
    return _data(await async_directus.update_item("agent_loop", loop_id, {"status": "stopped"}))
