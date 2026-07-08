"""Canvas configuration and loop service."""

from __future__ import annotations

from typing import Any
from datetime import datetime, timezone

from dembrane.utils import generate_uuid
from dembrane.settings import get_settings
from dembrane.canvas.events import publish_generation_nudge
from dembrane.canvas.ledgers import (
    host_item,
    state_patch,
    append_host_item,
    remove_host_item,
    fresh_canvas_state,
)
from dembrane.directus_async import async_directus
from dembrane.canvas.sanitize import sanitize_canvas_html
from dembrane.scheduled_tasks import TASK_CANVAS_TICK, schedule_task, cancel_pending_tasks

DEFAULT_CADENCE_MINUTES = 5


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _data(result: dict[str, Any]) -> dict[str, Any]:
    return result["data"]


def _applied_preview_detail(
    *,
    stripped_references: int,
    applied_from_chat_id: str | None,
) -> str:
    details = ["applied from chat preview"]
    if applied_from_chat_id:
        details.append(f"chat_id={applied_from_chat_id}")
    if stripped_references:
        details.append(f"stripped {stripped_references} external reference(s)")
    return "; ".join(details)


def _edited_generation_detail(*, instruction: str, chat_id: str | None) -> str:
    details = [f"direct edit: {instruction.strip()}"]
    if chat_id:
        details.append(f"chat_id={chat_id}")
    return "; ".join(details)


def _brief_with_standing_edit(brief: str, instruction: str) -> str:
    normalized_brief = brief.strip()
    normalized_instruction = instruction.strip()
    standing_line = f"- {normalized_instruction}"
    if "Standing edits:" in normalized_brief and standing_line in normalized_brief:
        return normalized_brief
    if "Standing edits:" in normalized_brief:
        return f"{normalized_brief}\n{standing_line}"
    return f"{normalized_brief}\n\nStanding edits:\n{standing_line}".strip()


async def enqueue_canvas_tick(
    loop_id: str, when: datetime | None = None, tick_kind: str = "scheduled"
) -> str:
    return await schedule_task(
        task_type=TASK_CANVAS_TICK,
        scheduled_at=when or _now(),
        payload={"loop_id": loop_id, "tick_kind": tick_kind},
    )


async def store_applied_preview_generation(
    *,
    report_id: str,
    config_revision_id: str,
    loop_id: str,
    applied_preview_html: str,
    applied_from_chat_id: str | None,
) -> dict[str, Any]:
    sanitized = sanitize_canvas_html(
        applied_preview_html,
        max_bytes=get_settings().canvas.max_html_bytes,
    )
    detail = _applied_preview_detail(
        stripped_references=sanitized.stripped_references,
        applied_from_chat_id=applied_from_chat_id,
    )
    generation = _data(
        await async_directus.create_item(
            "canvas_generation",
            {
                "id": generate_uuid(),
                "report_id": report_id,
                "config_revision_id": config_revision_id,
                "content_html": sanitized.html,
                "status": "ok",
                "tick_kind": "applied",
                "detail": detail,
            },
        )
    )
    recorded_at = _now().isoformat()
    await async_directus.create_item(
        "agent_loop_run",
        {
            "id": generate_uuid(),
            "loop_id": loop_id,
            "status": "ok",
            "detail": detail,
            "generation_id": str(generation["id"]),
            "started_at": recorded_at,
            "finished_at": recorded_at,
        },
    )
    await publish_generation_nudge(report_id)
    return generation


async def store_edited_generation(
    *,
    report_id: str,
    config_revision_id: str,
    loop_id: str,
    edited_html: str,
    instruction: str,
    chat_id: str | None,
) -> dict[str, Any]:
    sanitized = sanitize_canvas_html(
        edited_html,
        max_bytes=get_settings().canvas.max_html_bytes,
    )
    detail = _edited_generation_detail(instruction=instruction, chat_id=chat_id)
    generation = _data(
        await async_directus.create_item(
            "canvas_generation",
            {
                "id": generate_uuid(),
                "report_id": report_id,
                "config_revision_id": config_revision_id,
                "content_html": sanitized.html,
                "status": "ok",
                "tick_kind": "edited",
                "detail": detail,
            },
        )
    )
    recorded_at = _now().isoformat()
    await async_directus.create_item(
        "agent_loop_run",
        {
            "id": generate_uuid(),
            "loop_id": loop_id,
            "status": "ok",
            "detail": detail,
            "generation_id": str(generation["id"]),
            "started_at": recorded_at,
            "finished_at": recorded_at,
        },
    )
    await publish_generation_nudge(report_id)
    return generation


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
    applied_preview_html: str | None = None,
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
    applied_generation = None
    if applied_preview_html:
        applied_generation = await store_applied_preview_generation(
            report_id=report_id,
            config_revision_id=str(config["id"]),
            loop_id=str(loop["id"]),
            applied_preview_html=applied_preview_html,
            applied_from_chat_id=created_from_chat_id,
        )
    await enqueue_canvas_tick(str(loop["id"]))
    return {
        "report": report,
        "config_revision": config,
        "loop": loop,
        "applied_generation": applied_generation,
    }


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
                "fields": [
                    "id",
                    "report_id",
                    "brief",
                    "gather_spec",
                    "cadence_minutes",
                    "created_by",
                    "created_at",
                ],
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
                    "created_from_chat_id",
                    "failure_count",
                    "canvas_tabs",
                    "canvas_quotes_ledger",
                    "canvas_concepts_ledger",
                    "canvas_crux",
                    "canvas_host_items",
                    "canvas_story_slides",
                    "created_at",
                    "updated_at",
                ],
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def get_latest_loop_run(loop_id: str) -> dict[str, Any] | None:
    rows = await async_directus.get_items(
        "agent_loop_run",
        {
            "query": {
                "filter": {"loop_id": {"_eq": loop_id}},
                "fields": ["id", "status", "detail", "started_at", "finished_at"],
                "sort": ["-started_at"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def update_canvas_config(
    *,
    report_id: str,
    name: str,
    brief: str,
    gather_spec: dict[str, Any] | None,
    cadence_minutes: int,
    created_by: str,
    applied_preview_html: str | None = None,
    applied_from_chat_id: str | None = None,
) -> dict[str, Any]:
    """Append a config revision, update loop/report display fields, and tick soon."""
    config = await revise_config(
        report_id=report_id,
        brief=brief,
        gather_spec=gather_spec,
        cadence_minutes=cadence_minutes,
        created_by=created_by,
        note="chat update",
    )
    await async_directus.update_item(
        "project_report",
        report_id,
        {"user_instructions": name},
    )
    loop = await get_loop_for_report(report_id)
    applied_generation = None
    if loop:
        await async_directus.update_item(
            "agent_loop",
            str(loop["id"]),
            {
                "name": name,
                "cadence_minutes": cadence_minutes,
                "failure_count": 0,
            },
        )
        if applied_preview_html:
            applied_generation = await store_applied_preview_generation(
                report_id=report_id,
                config_revision_id=str(config["id"]),
                loop_id=str(loop["id"]),
                applied_preview_html=applied_preview_html,
                applied_from_chat_id=applied_from_chat_id,
            )
        # Without an applied preview the changed brief must force a redraw:
        # a "scheduled" tick would be eaten by the cadence-window guard or
        # no_op on "no new gathered content" (the content didn't change, the
        # brief did). "manual" bypasses both. With a preview applied, the new
        # design is already the latest frame and the normal cadence resumes.
        await enqueue_canvas_tick(
            str(loop["id"]),
            tick_kind="scheduled" if applied_generation else "manual",
        )
    report = await async_directus.get_item("project_report", report_id)
    return {
        "report": report,
        "config_revision": config,
        "loop": loop,
        "applied_generation": applied_generation,
    }


async def apply_direct_canvas_edit(
    *,
    report_id: str,
    edited_html: str,
    instruction: str,
    chat_id: str | None,
    created_by: str,
) -> dict[str, Any]:
    normalized_instruction = instruction.strip()
    if not normalized_instruction:
        raise ValueError("instruction is required")
    config = await get_latest_config(report_id)
    if not config:
        raise ValueError("Canvas config not found")
    loop = await get_loop_for_report(report_id)
    if not loop:
        raise ValueError("Canvas loop not found")

    standing_config = await revise_config(
        report_id=report_id,
        brief=_brief_with_standing_edit(str(config.get("brief") or ""), normalized_instruction),
        gather_spec=config.get("gather_spec")
        if isinstance(config.get("gather_spec"), dict)
        else None,
        cadence_minutes=int(config.get("cadence_minutes") or DEFAULT_CADENCE_MINUTES),
        created_by=created_by,
        note="direct edit",
    )
    generation = await store_edited_generation(
        report_id=report_id,
        config_revision_id=str(standing_config["id"]),
        loop_id=str(loop["id"]),
        edited_html=edited_html,
        instruction=normalized_instruction,
        chat_id=chat_id,
    )
    await async_directus.update_item("agent_loop", str(loop["id"]), {"failure_count": 0})
    return {
        "config_revision": standing_config,
        "generation": generation,
        "loop": loop,
    }


async def add_canvas_host_item(
    *,
    report_id: str,
    text: str,
    target_tab: str,
    person: str | None,
    chat_id: str | None,
    message_id: str | None,
) -> dict[str, Any]:
    normalized_text = text.strip()
    if not normalized_text:
        raise ValueError("text is required")
    loop = await get_loop_for_report(report_id)
    if not loop:
        raise ValueError("Canvas loop not found")
    item = host_item(
        text=normalized_text,
        target_tab=target_tab,
        person=person,
        chat_id=chat_id,
        message_id=message_id,
    )
    state = append_host_item(fresh_canvas_state(loop), item)
    updated = _data(
        await async_directus.update_item("agent_loop", str(loop["id"]), state_patch(state))
    )
    await enqueue_canvas_tick(str(loop["id"]), tick_kind="manual")
    return {"status": "added", "host_item": item, "loop": updated}


async def remove_canvas_host_item(
    *,
    report_id: str,
    item: str,
    chat_id: str | None,
    message_id: str | None,
) -> dict[str, Any]:
    normalized_item = item.strip()
    if not normalized_item:
        raise ValueError("item is required")
    loop = await get_loop_for_report(report_id)
    if not loop:
        raise ValueError("Canvas loop not found")
    state, removed = remove_host_item(fresh_canvas_state(loop), normalized_item)
    updated = _data(
        await async_directus.update_item("agent_loop", str(loop["id"]), state_patch(state))
    )
    if removed:
        await enqueue_canvas_tick(str(loop["id"]), tick_kind="manual")
    return {
        "status": "removed" if removed else "not_found",
        "item": normalized_item,
        "chat_id": chat_id,
        "message_id": message_id,
        "loop": updated,
    }


async def get_latest_generation(report_id: str) -> dict[str, Any] | None:
    rows = await list_generations(report_id=report_id, limit=1)
    return rows[0] if rows else None


async def list_canvas_summaries(project_id: str) -> list[dict[str, Any]]:
    reports = await async_directus.get_items(
        "project_report",
        {
            "query": {
                "filter": {
                    "project_id": {"_eq": project_id},
                    "kind": {"_eq": "canvas"},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "kind", "user_instructions", "date_created"],
                "sort": ["-date_created"],
                "limit": -1,
            }
        },
    )
    rows = reports if isinstance(reports, list) else []
    out: list[dict[str, Any]] = []
    for report in rows:
        report_id = str(report["id"])
        loop = await get_loop_for_report(report_id)
        run = await get_latest_loop_run(str(loop["id"])) if loop else None
        generation = await get_latest_generation(report_id)
        out.append(
            {
                "id": report_id,
                "name": (loop or {}).get("name") or report.get("user_instructions") or "Canvas",
                "kind": "canvas",
                "created_at": report.get("date_created"),
                "latest_generation_at": (generation or {}).get("created_at"),
                "updated_at": (loop or {}).get("updated_at"),
                "loop": (
                    {
                        "status": loop.get("status"),
                        "expires_at": loop.get("expires_at"),
                        "cadence_minutes": loop.get("cadence_minutes"),
                        "last_run_started_at": (run or {}).get("started_at"),
                        "last_run_status": (run or {}).get("status"),
                        "last_run_detail": (run or {}).get("detail"),
                    }
                    if loop
                    else None
                ),
            }
        )
    return out


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


async def update_loop_settings(
    loop: dict[str, Any],
    *,
    cadence_minutes: int,
    expires_at: str,
) -> dict[str, Any]:
    loop_id = str(loop["id"])
    if loop.get("status") in {"expired", "stopped", "ended"}:
        raise ValueError("This loop has ended")
    updated = _data(
        await async_directus.update_item(
            "agent_loop",
            loop_id,
            {
                "cadence_minutes": cadence_minutes,
                "expires_at": expires_at,
                "failure_count": 0,
            },
        )
    )
    await cancel_pending_tasks(task_type=TASK_CANVAS_TICK, payload_match={"loop_id": loop_id})
    if updated.get("status") == "active":
        await enqueue_canvas_tick(loop_id)
    return updated


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def apply_loop_action(loop: dict[str, Any], action: str) -> dict[str, Any]:
    loop_id = str(loop["id"])
    if action == "pause":
        if loop.get("status") == "stopped":
            return loop
        return await pause_loop(loop_id)
    if action == "resume":
        expires_at = _parse_dt(loop.get("expires_at"))
        if loop.get("status") in {"expired", "stopped"} or (
            expires_at is not None and expires_at <= _now()
        ):
            raise ValueError("This loop has ended")
        return await resume_loop(loop_id)
    if action == "stop":
        return await stop_loop(loop_id)
    raise ValueError(f"Unsupported loop action: {action}")
