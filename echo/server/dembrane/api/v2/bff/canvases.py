"""BFF endpoints for dynamic canvases."""

from __future__ import annotations

import json
import time
from typing import Any
from datetime import datetime, timezone, timedelta

from fastapi import Query, Request, APIRouter, HTTPException, status
from pydantic import Field, BaseModel
from fastapi.responses import StreamingResponse

from dembrane.redis_async import get_redis_client
from dembrane.canvas.ticks import (
    run_tick,
    _generate_html,
    _generate_host_guide,
    _gather_has_transcript,
    _extract_living_canvas_update,
)
from dembrane.canvas.events import read_generation_nudge, subscribe_generation_nudges
from dembrane.canvas.gather import execute_gather_spec
from dembrane.canvas.ledgers import fresh_canvas_state, apply_model_extraction
from dembrane.canvas.service import (
    create_canvas,
    list_generations,
    apply_loop_action,
    get_latest_config,
    get_latest_loop_run,
    get_loop_for_report,
    add_canvas_host_item,
    update_canvas_config,
    update_loop_settings,
    get_latest_generation,
    list_canvas_summaries,
    remove_canvas_host_item,
)
from dembrane.directus_async import async_directus
from dembrane.canvas.sanitize import sanitize_canvas_html
from dembrane.api.v2.bff._access import resolve_report_access, resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()

REFRESH_TTL_SECONDS = 30
PREVIEW_TTL_SECONDS = 10
CANVAS_EVENT_HEARTBEAT_SECONDS = 15.0


class CreateCanvasBody(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=160)
    brief: str = Field(min_length=1, max_length=8000)
    gather_spec: dict[str, Any] | None = None
    cadence_minutes: int = Field(default=5, ge=2, le=120)
    expires_at: datetime
    created_from_chat_id: str | None = None
    applied_preview_html: str | None = Field(default=None, min_length=1)
    tabs: list[dict[str, Any]] | None = None


class UpdateCanvasBody(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    brief: str = Field(min_length=1, max_length=8000)
    gather_spec: dict[str, Any] | None = None
    cadence_minutes: int = Field(default=5, ge=2, le=120)
    created_from_chat_id: str | None = None
    applied_preview_html: str | None = Field(default=None, min_length=1)
    tabs: list[dict[str, Any]] | None = None


class UpdateCanvasLoopSettingsBody(BaseModel):
    cadence_minutes: int = Field(ge=2, le=120)
    expires_at: datetime


class PreviewCanvasBody(BaseModel):
    project_id: str
    brief: str = Field(min_length=1, max_length=8000)
    gather_spec: dict[str, Any] | None = None
    tabs: list[dict[str, Any]] | None = None


class CanvasHostItemBody(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    target_tab: str = Field(default="story", min_length=1, max_length=80)
    person: str | None = Field(default=None, max_length=160)
    chat_id: str | None = None
    message_id: str | None = None


class CanvasRemoveHostItemBody(BaseModel):
    item: str = Field(min_length=1, max_length=2000)
    chat_id: str | None = None
    message_id: str | None = None


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value is not None else None


def _report_id(report: dict[str, Any]) -> str:
    return str(report["id"])


async def _require_canvas(report_id: str, auth: DependencyDirectusSession) -> tuple[dict, Any]:
    access, report = await resolve_report_access(report_id, auth)
    access.require("project:read")
    if report.get("kind") != "canvas":
        raise HTTPException(status_code=404, detail="Canvas not found")
    return report, access


async def _canvas_payload(report: dict[str, Any]) -> dict[str, Any]:
    report_id = _report_id(report)
    loop = await get_loop_for_report(report_id)
    run = await get_latest_loop_run(str(loop["id"])) if loop else None
    config = await get_latest_config(report_id)
    generation = await get_latest_generation(report_id)
    project_id = _as_id(report.get("project_id"))
    created_from_chat_id = await _live_created_from_chat_id(loop, project_id)
    return {
        "id": report_id,
        "name": (loop or {}).get("name") or report.get("user_instructions") or "Canvas",
        "kind": "canvas",
        "project_id": project_id,
        "latest_generation": generation,
        "created_from_chat_id": created_from_chat_id,
        "updated_at": (loop or {}).get("updated_at"),
        "config": (
            {
                "brief": config.get("brief"),
                "gather_spec": config.get("gather_spec"),
                "tabs": config.get("tabs"),
                "cadence_minutes": config.get("cadence_minutes"),
                "created_at": config.get("created_at"),
            }
            if config
            else None
        ),
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


async def _live_created_from_chat_id(
    loop: dict[str, Any] | None,
    project_id: str | None,
) -> str | None:
    chat_id = _as_id((loop or {}).get("created_from_chat_id"))
    if not chat_id or not project_id:
        return None
    chat = await async_directus.get_item("project_chat", chat_id)
    if not chat or chat.get("deleted_at"):
        return None
    if _as_id(chat.get("project_id")) != project_id:
        return None
    return chat_id


async def _validated_chat_id(chat_id: str | None, project_id: str | None) -> str | None:
    if not chat_id or not project_id:
        return None
    chat = await async_directus.get_item("project_chat", chat_id)
    if not chat or chat.get("deleted_at") or _as_id(chat.get("project_id")) != project_id:
        return None
    return chat_id


def _loop_payload(loop: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": loop.get("status"),
        "expires_at": loop.get("expires_at"),
        "cadence_minutes": loop.get("cadence_minutes"),
        "last_run_started_at": loop.get("last_run_started_at"),
        "last_run_status": loop.get("last_run_status"),
        "last_run_detail": loop.get("last_run_detail"),
    }


async def _apply_canvas_loop_action(
    canvas_id: str,
    action: str,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    report, access = await _require_canvas(canvas_id, auth)
    access.require("project:update")
    loop = await get_loop_for_report(_report_id(report))
    if not loop:
        raise HTTPException(status_code=404, detail="Canvas loop not found")
    try:
        updated = await apply_loop_action(loop, action)
    except ValueError as exc:
        detail = str(exc)
        if detail == "This loop has ended":
            raise HTTPException(status_code=409, detail=detail) from exc
        raise HTTPException(status_code=400, detail=detail) from exc
    return _loop_payload(updated)


@router.get("")
async def list_canvases(
    auth: DependencyDirectusSession,
    project_id: str = Query(..., min_length=1),
) -> list[dict[str, Any]]:
    access = await resolve_project_access(project_id, auth)
    access.require("project:read")
    return await list_canvas_summaries(project_id)


@router.post("")
async def create_canvas_endpoint(
    body: CreateCanvasBody,
    auth: DependencyDirectusSession,
) -> dict:
    access = await resolve_project_access(body.project_id, auth)
    access.require("project:update")

    now = datetime.now(timezone.utc)
    expires_at = body.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= now:
        raise HTTPException(status_code=422, detail="expires_at must be in the future")
    if expires_at > now + timedelta(days=7):
        raise HTTPException(status_code=422, detail="expires_at must be within 7 days")
    created_from_chat_id = await _validated_chat_id(
        body.created_from_chat_id,
        body.project_id,
    )

    created = await create_canvas(
        project_id=body.project_id,
        name=body.name,
        brief=body.brief,
        gather_spec=body.gather_spec,
        cadence_minutes=body.cadence_minutes,
        expires_at=expires_at.isoformat(),
        acting_directus_user_id=auth.user_id,
        created_from_chat_id=created_from_chat_id,
        applied_preview_html=body.applied_preview_html,
        tabs=body.tabs,
    )
    report = await async_directus.get_item("project_report", str(created["report"]["id"]))
    return await _canvas_payload(report)


@router.post("/preview")
async def preview_canvas(
    body: PreviewCanvasBody,
    auth: DependencyDirectusSession,
) -> dict[str, str]:
    access = await resolve_project_access(body.project_id, auth)
    access.require("project:update")

    client = await get_redis_client()
    hot = not await client.set(
        f"canvas:preview:{body.project_id}",
        "1",
        ex=PREVIEW_TTL_SECONDS,
        nx=True,
    )
    if hot:
        raise HTTPException(status_code=429, detail="Just previewed")

    gather_bundle = await execute_gather_spec(
        project_id=body.project_id,
        acting_directus_user_id=auth.user_id,
        gather_spec=body.gather_spec or {},
        preview_sample=True,
    )
    living_state = fresh_canvas_state()
    if body.tabs:
        living_state["tabs"] = body.tabs
    if _gather_has_transcript(gather_bundle):
        try:
            extraction = await _extract_living_canvas_update(
                gather_bundle=gather_bundle,
                current_state=living_state,
                report_name=body.name,
                brief=body.brief,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Canvas extraction failed: {exc}") from exc
        living_state, _detail = apply_model_extraction(living_state, gather_bundle, extraction)
        try:
            living_state["host_guide"] = await _generate_host_guide(
                report_name=body.name,
                brief=body.brief,
                current_state=living_state,
                recent_activity=_detail,
            )
        except Exception:
            pass

    raw_html = await _generate_html(
        brief=body.brief,
        previous_html=None,
        gather_bundle=gather_bundle,
        living_state=living_state,
        report_name=str((gather_bundle.get("project") or {}).get("name") or "Canvas"),
    )
    sanitized = sanitize_canvas_html(raw_html)
    return {"content_html": sanitized.html}


@router.get("/{canvas_id}")
async def get_canvas(canvas_id: str, auth: DependencyDirectusSession) -> dict:
    report, _access = await _require_canvas(canvas_id, auth)
    return await _canvas_payload(report)


@router.get("/{canvas_id}/events")
async def canvas_events(
    canvas_id: str,
    request: Request,
    auth: DependencyDirectusSession,
) -> StreamingResponse:
    """SSE stream of canvas generation nudges for authorized canvas readers."""
    report, _access = await _require_canvas(canvas_id, auth)
    report_id = _report_id(report)

    async def event_stream():
        last_heartbeat = time.monotonic()
        yield f"event: connected\ndata: {json.dumps({'type': 'connected'})}\n\n"
        async with subscribe_generation_nudges(report_id) as pubsub:
            while True:
                if await request.is_disconnected():
                    break

                payload = await read_generation_nudge(pubsub, timeout_seconds=1.0)
                if payload is not None:
                    latest = await get_latest_generation(report_id)
                    data = {
                        "type": "generation",
                        "generation_id": (latest or {}).get("id"),
                    }
                    yield f"event: generation\ndata: {json.dumps(data, default=str)}\n\n"
                    continue

                now = time.monotonic()
                if now - last_heartbeat >= CANVAS_EVENT_HEARTBEAT_SECONDS:
                    yield ": keep-alive\n\n"
                    last_heartbeat = now

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.patch("/{canvas_id}")
async def update_canvas(
    canvas_id: str,
    body: UpdateCanvasBody,
    auth: DependencyDirectusSession,
) -> dict:
    report, access = await _require_canvas(canvas_id, auth)
    access.require("project:update")
    applied_from_chat_id = await _validated_chat_id(
        body.created_from_chat_id,
        _as_id(report.get("project_id")),
    )
    updated = await update_canvas_config(
        report_id=_report_id(report),
        name=body.name,
        brief=body.brief,
        gather_spec=body.gather_spec,
        cadence_minutes=body.cadence_minutes,
        created_by=auth.user_id,
        applied_preview_html=body.applied_preview_html,
        applied_from_chat_id=applied_from_chat_id,
        tabs=body.tabs,
    )
    return await _canvas_payload(updated["report"])


@router.get("/{canvas_id}/generations")
async def get_canvas_generations(
    canvas_id: str,
    auth: DependencyDirectusSession,
    limit: int = Query(default=8, ge=1, le=50),
) -> list[dict]:
    report, _access = await _require_canvas(canvas_id, auth)
    return await list_generations(report_id=_report_id(report), limit=limit)


@router.post("/{canvas_id}/refresh", status_code=status.HTTP_202_ACCEPTED)
async def refresh_canvas(canvas_id: str, auth: DependencyDirectusSession) -> dict:
    report, access = await _require_canvas(canvas_id, auth)
    access.require("project:update")
    loop = await get_loop_for_report(_report_id(report))
    if not loop:
        raise HTTPException(status_code=404, detail="Canvas loop not found")

    client = await get_redis_client()
    hot = not await client.set(
        f"canvas:refresh:{canvas_id}",
        "1",
        ex=REFRESH_TTL_SECONDS,
        nx=True,
    )
    if hot:
        raise HTTPException(status_code=429, detail="Just refreshed")
    await run_tick(str(loop["id"]), "manual")
    return {"generation": "pending"}


@router.post("/{canvas_id}/host-items")
async def add_host_item_endpoint(
    canvas_id: str,
    body: CanvasHostItemBody,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    report, access = await _require_canvas(canvas_id, auth)
    access.require("project:update")
    return await add_canvas_host_item(
        report_id=_report_id(report),
        text=body.text,
        target_tab=body.target_tab,
        person=body.person,
        chat_id=await _validated_chat_id(body.chat_id, _as_id(report.get("project_id"))),
        message_id=body.message_id,
    )


@router.post("/{canvas_id}/host-items/remove")
async def remove_host_item_endpoint(
    canvas_id: str,
    body: CanvasRemoveHostItemBody,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    report, access = await _require_canvas(canvas_id, auth)
    access.require("project:update")
    return await remove_canvas_host_item(
        report_id=_report_id(report),
        item=body.item,
        chat_id=await _validated_chat_id(body.chat_id, _as_id(report.get("project_id"))),
        message_id=body.message_id,
    )


@router.post("/{canvas_id}/loop/{action}")
async def update_canvas_loop(
    canvas_id: str,
    action: str,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    if action not in {"pause", "resume", "stop"}:
        raise HTTPException(status_code=404, detail="Canvas loop action not found")
    return await _apply_canvas_loop_action(canvas_id, action, auth)


@router.patch("/{canvas_id}/loop")
async def patch_canvas_loop(
    canvas_id: str,
    body: UpdateCanvasLoopSettingsBody,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    report, access = await _require_canvas(canvas_id, auth)
    access.require("project:update")
    loop = await get_loop_for_report(_report_id(report))
    if not loop:
        raise HTTPException(status_code=404, detail="Canvas loop not found")

    now = datetime.now(timezone.utc)
    expires_at = body.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= now:
        raise HTTPException(status_code=422, detail="expires_at must be in the future")
    if expires_at > now + timedelta(days=7):
        raise HTTPException(status_code=422, detail="expires_at must be within 7 days")

    try:
        updated = await update_loop_settings(
            loop,
            cadence_minutes=body.cadence_minutes,
            expires_at=expires_at.isoformat(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _loop_payload(updated)
