"""Bounded canvas tick pipeline."""

from __future__ import annotations

import json
import logging
from typing import Any
from pathlib import Path
from datetime import datetime, timezone, timedelta

from dembrane.llms import MODELS, arouter_completion
from dembrane.utils import generate_uuid
from dembrane.settings import get_settings
from dembrane.canvas.access import CanvasReaderAccessDenied
from dembrane.canvas.events import publish_generation_nudge
from dembrane.canvas.gather import execute_gather_spec
from dembrane.directus_async import async_directus
from dembrane.canvas.sanitize import CanvasSanitizationError, sanitize_canvas_html

logger = logging.getLogger("dembrane.canvas.ticks")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value else None


def _choice_text(response: Any) -> str:
    try:
        content = response.choices[0].message.content
    except Exception:
        content = None
    if isinstance(content, str):
        return content
    if isinstance(response, dict):
        return (
            ((response.get("choices") or [{}])[0].get("message") or {}).get("content")
            or ""
        )
    return ""


def _skill_text() -> str:
    return (Path(__file__).with_name("skill.md")).read_text(encoding="utf-8")


async def _create_run(
    *,
    loop_id: str,
    status: str,
    started_at: datetime,
    detail: str | None = None,
    generation_id: str | None = None,
) -> dict[str, Any]:
    result = await async_directus.create_item(
        "agent_loop_run",
        {
            "id": generate_uuid(),
            "loop_id": loop_id,
            "status": status,
            "detail": detail,
            "generation_id": generation_id,
            "started_at": started_at.isoformat(),
            "finished_at": _now().isoformat(),
        },
    )
    return result["data"]


async def _update_loop_after_tick(loop: dict[str, Any], *, status: str) -> None:
    loop_id = str(loop["id"])
    if status == "ok":
        await async_directus.update_item("agent_loop", loop_id, {"failure_count": 0})
        return
    if status == "error":
        failures = int(loop.get("failure_count") or 0) + 1
        patch: dict[str, Any] = {"failure_count": failures}
        if failures >= 3:
            patch["status"] = "paused"
        await async_directus.update_item("agent_loop", loop_id, patch)


async def _enqueue_next_if_due(loop: dict[str, Any]) -> None:
    loop_id = str(loop["id"])
    fresh = await async_directus.get_item("agent_loop", loop_id)
    if not fresh or fresh.get("status") != "active":
        return
    expires_at = _parse_dt(fresh.get("expires_at"))
    now = _now()
    if expires_at and now >= expires_at:
        await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
        return
    cadence = max(2, int(fresh.get("cadence_minutes") or 5))
    next_at = now + timedelta(minutes=cadence)
    if expires_at and next_at >= expires_at:
        final_at = expires_at - timedelta(seconds=5)
        if final_at > now:
            next_at = final_at
        else:
            await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
            return
    from dembrane.scheduled_tasks import TASK_CANVAS_TICK, schedule_task

    await schedule_task(
        task_type=TASK_CANVAS_TICK,
        scheduled_at=next_at,
        payload={"loop_id": loop_id, "tick_kind": "scheduled"},
    )


async def _latest_ok_generation(report_id: str) -> dict[str, Any] | None:
    rows = await async_directus.get_items(
        "canvas_generation",
        {
            "query": {
                "filter": {"report_id": {"_eq": report_id}, "status": {"_eq": "ok"}},
                "fields": ["id", "content_html", "created_at"],
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    return rows[0] if isinstance(rows, list) and rows else None


async def _latest_config(report_id: str) -> dict[str, Any]:
    from dembrane.canvas.service import get_latest_config

    config = await get_latest_config(report_id)
    if not config:
        raise RuntimeError("Canvas config revision not found")
    return config


async def _generate_html(*, brief: str, previous_html: str | None, gather_bundle: dict[str, Any]) -> str:
    project = gather_bundle.get("project") or {}
    user = "\n\n".join(
        [
            "PROJECT CONTEXT\n"
            f"name: {project.get('name') or 'untitled'}\n"
            f"language: {project.get('language') or 'en'}\n"
            f"context: {project.get('context') or ''}\n"
            f"anonymize_transcripts: {project.get('anonymize_transcripts')}",
            f"BRIEF\n{brief}",
            "PREVIOUS DOCUMENT\n"
            + (
                previous_html
                if previous_html
                else "None yet. Create a stable layout that can be updated on later ticks."
            )
            + "\nIf a previous document exists, keep layout and section order stable.",
            "DATA\n" + json.dumps(gather_bundle, ensure_ascii=False, indent=2),
        ]
    )
    response = await arouter_completion(
        MODELS.MULTI_MODAL_FAST,
        messages=[
            {"role": "system", "content": _skill_text()},
            {"role": "user", "content": user},
        ],
        temperature=0.2,
        max_tokens=12000,
    )
    return _choice_text(response)


async def run_tick(loop_id: str, tick_kind: str = "scheduled") -> dict[str, Any]:
    """Run one bounded gather -> generate -> sanitize -> store tick."""
    started_at = _now()
    loop = await async_directus.get_item("agent_loop", loop_id)
    if not loop:
        raise RuntimeError("Canvas loop not found")

    expires_at = _parse_dt(loop.get("expires_at"))
    if expires_at and started_at >= expires_at:
        await async_directus.update_item("agent_loop", loop_id, {"status": "expired"})
        run = await _create_run(
            loop_id=loop_id,
            status="no_op",
            detail="Loop expired before tick start",
            started_at=started_at,
        )
        return {"status": "expired", "run": run}
    if loop.get("status") != "active" and tick_kind != "manual":
        run = await _create_run(
            loop_id=loop_id,
            status="no_op",
            detail=f"Loop is {loop.get('status')}",
            started_at=started_at,
        )
        return {"status": "no_op", "run": run}

    report_id = _as_id(loop.get("report_id"))
    project_id = _as_id(loop.get("project_id"))
    acting_user_id = str(loop.get("acting_directus_user_id") or "")
    if not report_id or not project_id or not acting_user_id:
        raise RuntimeError("Canvas loop is missing required ids")

    try:
        config = await _latest_config(report_id)
        latest_ok = await _latest_ok_generation(report_id)
        gather_bundle = await execute_gather_spec(
            project_id=project_id,
            acting_directus_user_id=acting_user_id,
            gather_spec=config.get("gather_spec") or {},
        )
        latest_content_at = _parse_dt(gather_bundle.get("latest_content_at"))
        latest_generation_at = _parse_dt((latest_ok or {}).get("created_at"))
        if (
            tick_kind != "manual"
            and latest_ok
            and (not latest_content_at or (latest_generation_at and latest_content_at <= latest_generation_at))
        ):
            run = await _create_run(
                loop_id=loop_id,
                status="no_op",
                detail="No new gathered content since latest generation",
                started_at=started_at,
            )
            await _enqueue_next_if_due(loop)
            return {"status": "no_op", "run": run}

        raw_html = await _generate_html(
            brief=str(config.get("brief") or ""),
            previous_html=(latest_ok or {}).get("content_html"),
            gather_bundle=gather_bundle,
        )
        sanitized = sanitize_canvas_html(raw_html, max_bytes=get_settings().canvas.max_html_bytes)
        generation = (
            await async_directus.create_item(
                "canvas_generation",
                {
                    "id": generate_uuid(),
                    "report_id": report_id,
                    "config_revision_id": _as_id(config.get("id")),
                    "content_html": sanitized.html,
                    "status": "ok",
                    "tick_kind": tick_kind,
                    "detail": (
                        f"stripped {sanitized.stripped_references} external reference(s)"
                        if sanitized.stripped_references
                        else None
                    ),
                },
            )
        )["data"]
        run = await _create_run(
            loop_id=loop_id,
            status="ok",
            generation_id=str(generation["id"]),
            started_at=started_at,
        )
        await _update_loop_after_tick(loop, status="ok")
        await publish_generation_nudge(report_id)
        await _enqueue_next_if_due(loop)
        return {"status": "ok", "generation": generation, "run": run}
    except (CanvasReaderAccessDenied, CanvasSanitizationError, Exception) as exc:
        detail = str(exc)
        generation = (
            await async_directus.create_item(
                "canvas_generation",
                {
                    "id": generate_uuid(),
                    "report_id": report_id,
                    "config_revision_id": _as_id((locals().get("config") or {}).get("id")),
                    "content_html": "",
                    "status": "error",
                    "tick_kind": tick_kind,
                    "detail": detail[:5000],
                },
            )
        )["data"]
        run = await _create_run(
            loop_id=loop_id,
            status="error",
            detail=detail[:5000],
            generation_id=str(generation["id"]),
            started_at=started_at,
        )
        await _update_loop_after_tick(loop, status="error")
        await _enqueue_next_if_due(loop)
        logger.warning("canvas tick failed for loop %s: %s", loop_id, detail)
        return {"status": "error", "generation": generation, "run": run}
