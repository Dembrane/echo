from __future__ import annotations

import asyncio
import json
from logging import getLogger
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from dembrane.api.dependency_auth import DependencyDirectusSession, DirectusSession
from dembrane.agentic_dispatch import enqueue_agentic_run
from dembrane.service import project_service, agentic_run_service
from dembrane.service.agentic import (
    AgenticRunNotFoundException,
    TERMINAL_RUN_STATUSES,
)
from dembrane.settings import get_settings

AgenticRouter = APIRouter(tags=["agentic"])
logger = getLogger("dembrane.api.agentic")

settings = get_settings()
SSE_HEARTBEAT_SECONDS = settings.agentic.sse_heartbeat_seconds


class AgenticCreateRunSchema(BaseModel):
    project_id: str = Field(..., min_length=1)
    project_chat_id: Optional[str] = None
    message: str = Field(..., min_length=1)


class AgenticAppendMessageSchema(BaseModel):
    message: str = Field(..., min_length=1)


def _require_agent_token(auth: DirectusSession) -> str:
    if not auth.access_token:
        raise HTTPException(
            status_code=401,
            detail="User access token required for agentic runs",
        )
    return auth.access_token


def _assert_project_authorized(project: dict[str, Any], auth: DirectusSession) -> None:
    owner_user_id = project.get("directus_user_id")
    if auth.is_admin:
        return
    if owner_user_id != auth.user_id:
        raise HTTPException(status_code=403, detail="Not authorized for this project")


def _assert_run_authorized(run: dict[str, Any], auth: DirectusSession) -> None:
    if auth.is_admin:
        return
    if run.get("directus_user_id") != auth.user_id:
        raise HTTPException(status_code=403, detail="Not authorized for this run")


def _get_run_or_404(run_id: str) -> dict[str, Any]:
    try:
        return agentic_run_service.get_by_id_or_raise(run_id)
    except AgenticRunNotFoundException as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc


@AgenticRouter.post("/runs")
async def create_run(
    body: AgenticCreateRunSchema,
    auth: DependencyDirectusSession,
) -> JSONResponse:
    token = _require_agent_token(auth)

    try:
        project = project_service.get_by_id_or_raise(body.project_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Project %s not found while creating run", body.project_id)
        raise HTTPException(status_code=404, detail="Project not found") from exc

    _assert_project_authorized(project, auth)

    run = agentic_run_service.create_run(
        project_id=body.project_id,
        project_chat_id=body.project_chat_id,
        directus_user_id=auth.user_id,
    )
    agentic_run_service.append_event(
        run["id"],
        "user.message",
        {"content": body.message},
    )

    enqueue_agentic_run(
        run_id=run["id"],
        project_id=body.project_id,
        user_message=body.message,
        bearer_token=token,
    )

    refreshed_run = _get_run_or_404(run["id"])
    return JSONResponse(status_code=201, content=refreshed_run)


@AgenticRouter.post("/runs/{run_id}/messages")
async def append_message(
    run_id: str,
    body: AgenticAppendMessageSchema,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    token = _require_agent_token(auth)
    run = _get_run_or_404(run_id)
    _assert_run_authorized(run, auth)

    agentic_run_service.append_event(
        run_id,
        "user.message",
        {"content": body.message},
    )
    updated_run = agentic_run_service.set_status(
        run_id,
        "queued",
    )

    enqueue_agentic_run(
        run_id=run_id,
        project_id=str(run.get("project_id")),
        user_message=body.message,
        bearer_token=token,
    )

    return updated_run


@AgenticRouter.get("/runs/{run_id}")
async def get_run(run_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    run = _get_run_or_404(run_id)
    _assert_run_authorized(run, auth)
    return run


@AgenticRouter.get("/runs/{run_id}/events")
async def get_run_events(
    run_id: str,
    request: Request,
    auth: DependencyDirectusSession,
    after_seq: int = Query(default=0, ge=0),
) -> Any:
    run = _get_run_or_404(run_id)
    _assert_run_authorized(run, auth)

    accept = request.headers.get("accept", "")
    if "text/event-stream" in accept:
        return StreamingResponse(
            _event_stream(run_id=run_id, after_seq=after_seq),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    events = agentic_run_service.list_events(run_id, after_seq=after_seq)
    latest = _get_run_or_404(run_id)
    next_seq = after_seq if not events else int(events[-1].get("seq") or after_seq)
    return {
        "run_id": run_id,
        "status": latest.get("status"),
        "events": events,
        "next_seq": next_seq,
        "done": latest.get("status") in TERMINAL_RUN_STATUSES,
    }


async def _event_stream(run_id: str, after_seq: int):
    cursor = after_seq
    while True:
        events = agentic_run_service.list_events(run_id, after_seq=cursor)
        if events:
            for event in events:
                seq = int(event.get("seq") or cursor)
                cursor = max(cursor, seq)
                payload = json.dumps(event, default=str)
                yield f"id: {seq}\n"
                yield f"event: {event.get('event_type')}\n"
                yield f"data: {payload}\n\n"
            continue

        latest = _get_run_or_404(run_id)
        if latest.get("status") in TERMINAL_RUN_STATUSES:
            break

        await asyncio.sleep(SSE_HEARTBEAT_SECONDS)
        yield "event: heartbeat\n"
        yield "data: {}\n\n"
