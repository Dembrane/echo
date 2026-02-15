from __future__ import annotations

import json
import time
import asyncio
from uuid import uuid4
from typing import Any, Optional
from logging import getLogger
from contextlib import suppress

from fastapi import Query, Request, APIRouter, HTTPException
from pydantic import Field, BaseModel
from fastapi.responses import JSONResponse, StreamingResponse

from dembrane.service import chat_service, project_service, agentic_run_service
from dembrane.settings import get_settings
from dembrane.async_helpers import run_in_thread_pool
from dembrane.agentic_worker import process_agentic_run
from dembrane.agentic_runtime import (
    request_cancel,
    read_live_event,
    acquire_turn_lease,
    refresh_turn_lease,
    release_turn_lease,
    subscribe_live_events,
)
from dembrane.service.agentic import TERMINAL_RUN_STATUSES, AgenticRunNotFoundException
from dembrane.api.dependency_auth import DirectusSession, DependencyDirectusSession

AgenticRouter = APIRouter(tags=["agentic"])
logger = getLogger("dembrane.api.agentic")

settings = get_settings()
SSE_HEARTBEAT_SECONDS = settings.agentic.sse_heartbeat_seconds
RUN_LOCK_TTL_SECONDS = max(1, settings.agentic.run_lock_ttl_seconds)
RUN_LOCK_REFRESH_SECONDS = max(
    1,
    min(settings.agentic.run_lock_refresh_seconds, max(1, RUN_LOCK_TTL_SECONDS - 1)),
)

_ACTIVE_RUN_TASKS: dict[tuple[str, int], asyncio.Task[None]] = {}
_ACTIVE_RUN_TASKS_LOCK = asyncio.Lock()


class AgenticCreateRunSchema(BaseModel):
    project_id: str = Field(..., min_length=1)
    project_chat_id: Optional[str] = None
    message: str = Field(..., min_length=1)


class AgenticAppendMessageSchema(BaseModel):
    message: str = Field(..., min_length=1)


def _run_task_key(run_id: str, turn_seq: int) -> tuple[str, int]:
    return (run_id, turn_seq)


async def _register_active_task(run_id: str, turn_seq: int, task: asyncio.Task[None]) -> bool:
    key = _run_task_key(run_id, turn_seq)
    async with _ACTIVE_RUN_TASKS_LOCK:
        existing = _ACTIVE_RUN_TASKS.get(key)
        if existing is not None and not existing.done():
            return False
        _ACTIVE_RUN_TASKS[key] = task
        return True


async def _get_active_task(run_id: str, turn_seq: int) -> Optional[asyncio.Task[None]]:
    key = _run_task_key(run_id, turn_seq)
    async with _ACTIVE_RUN_TASKS_LOCK:
        task = _ACTIVE_RUN_TASKS.get(key)
        if task is not None and task.done():
            _ACTIVE_RUN_TASKS.pop(key, None)
            return None
        return task


async def _pop_active_task(run_id: str, turn_seq: int) -> Optional[asyncio.Task[None]]:
    key = _run_task_key(run_id, turn_seq)
    async with _ACTIVE_RUN_TASKS_LOCK:
        return _ACTIVE_RUN_TASKS.pop(key, None)


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


def _payload_to_dict(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            return {}
        if isinstance(value, dict):
            return value
    return {}


def _persist_chat_user_message(project_chat_id: Optional[str], message: str) -> None:
    if not project_chat_id:
        return

    try:
        chat_service.create_message(
            project_chat_id,
            "user",
            message,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to persist agentic user message to chat %s: %s",
            project_chat_id,
            exc,
        )


def _sse_event_payload(event: dict[str, Any], seq: int) -> str:
    payload = json.dumps(event, default=str)
    return f"id: {seq}\nevent: {event.get('event_type')}\ndata: {payload}\n\n"


async def _list_events_after(run_id: str, after_seq: int) -> list[dict[str, Any]]:
    return await run_in_thread_pool(agentic_run_service.list_events, run_id, after_seq=after_seq)


async def _latest_user_turn(run_id: str) -> Optional[tuple[int, str]]:
    event = await run_in_thread_pool(agentic_run_service.get_latest_event, run_id, event_type="user.message")
    if event is None:
        return None

    payload = _payload_to_dict(event.get("payload"))
    content = payload.get("content")
    if not isinstance(content, str) or not content.strip():
        return None

    seq = int(event.get("seq") or 0)
    if seq <= 0:
        return None
    return seq, content


def _project_id_from_run(run: dict[str, Any]) -> str:
    value = run.get("project_id")
    if isinstance(value, dict):
        return str(value.get("id") or "")
    return str(value or "")


async def _refresh_lease_until_done(
    *,
    run_id: str,
    turn_seq: int,
    owner_token: str,
    worker_task: asyncio.Task[None],
) -> None:
    while not worker_task.done():
        await asyncio.sleep(RUN_LOCK_REFRESH_SECONDS)
        try:
            refreshed = await refresh_turn_lease(
                run_id,
                turn_seq,
                owner_token,
                RUN_LOCK_TTL_SECONDS,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to refresh lease for run %s turn %s: %s", run_id, turn_seq, exc)
            continue

        if not refreshed:
            logger.warning(
                "Lost lease for run %s turn %s; cancelling local processor task",
                run_id,
                turn_seq,
            )
            worker_task.cancel()
            return


async def _start_claimed_turn(
    *,
    run_id: str,
    project_id: str,
    turn_seq: int,
    user_message: str,
    bearer_token: str,
    owner_token: str,
) -> None:
    async def _runner() -> None:
        worker_task = asyncio.create_task(
            process_agentic_run(
                run_id=run_id,
                project_id=project_id,
                user_message=user_message,
                bearer_token=bearer_token,
                turn_seq=turn_seq,
                owner_token=owner_token,
            )
        )
        refresh_task = asyncio.create_task(
            _refresh_lease_until_done(
                run_id=run_id,
                turn_seq=turn_seq,
                owner_token=owner_token,
                worker_task=worker_task,
            )
        )

        try:
            await worker_task
        finally:
            refresh_task.cancel()
            with suppress(Exception):
                await refresh_task
            try:
                await release_turn_lease(run_id, turn_seq, owner_token)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to release lease for run %s turn %s: %s", run_id, turn_seq, exc)
            await _pop_active_task(run_id, turn_seq)

    task = asyncio.create_task(_runner(), name=f"agentic-run-{run_id}-{turn_seq}")
    registered = await _register_active_task(run_id, turn_seq, task)
    if not registered:
        task.cancel()


@AgenticRouter.post("/runs")
async def create_run(
    body: AgenticCreateRunSchema,
    auth: DependencyDirectusSession,
) -> JSONResponse:
    _require_agent_token(auth)

    try:
        project = await run_in_thread_pool(project_service.get_by_id_or_raise, body.project_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Project %s not found while creating run", body.project_id)
        raise HTTPException(status_code=404, detail="Project not found") from exc

    _assert_project_authorized(project, auth)

    run = await run_in_thread_pool(
        agentic_run_service.create_run,
        project_id=body.project_id,
        project_chat_id=body.project_chat_id,
        directus_user_id=auth.user_id,
    )
    await run_in_thread_pool(
        agentic_run_service.append_event,
        run["id"],
        "user.message",
        {"content": body.message},
    )
    await run_in_thread_pool(_persist_chat_user_message, body.project_chat_id, body.message)

    refreshed_run = await run_in_thread_pool(_get_run_or_404, run["id"])
    return JSONResponse(status_code=201, content=refreshed_run)


@AgenticRouter.post("/runs/{run_id}/messages")
async def append_message(
    run_id: str,
    body: AgenticAppendMessageSchema,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    _require_agent_token(auth)
    run = await run_in_thread_pool(_get_run_or_404, run_id)
    _assert_run_authorized(run, auth)

    if run.get("status") in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="Run already in progress")

    await run_in_thread_pool(
        agentic_run_service.append_event,
        run_id,
        "user.message",
        {"content": body.message},
    )
    await run_in_thread_pool(
        _persist_chat_user_message,
        str(run.get("project_chat_id") or ""),
        body.message,
    )
    return await run_in_thread_pool(agentic_run_service.set_status, run_id, "queued")


@AgenticRouter.post("/runs/{run_id}/stream")
async def stream_run(
    run_id: str,
    auth: DependencyDirectusSession,
    after_seq: int = Query(default=0, ge=0),
) -> StreamingResponse:
    token = _require_agent_token(auth)
    run = await run_in_thread_pool(_get_run_or_404, run_id)
    _assert_run_authorized(run, auth)

    if run.get("status") not in TERMINAL_RUN_STATUSES:
        latest_turn = await _latest_user_turn(run_id)
        if latest_turn is not None:
            turn_seq, user_message = latest_turn
            project_id = _project_id_from_run(run)
            if not project_id:
                raise HTTPException(status_code=500, detail="Run is missing project reference")

            owner_token = str(uuid4())
            lease_acquired = await acquire_turn_lease(
                run_id,
                turn_seq,
                owner_token,
                RUN_LOCK_TTL_SECONDS,
            )
            if lease_acquired:
                await _start_claimed_turn(
                    run_id=run_id,
                    project_id=project_id,
                    turn_seq=turn_seq,
                    user_message=user_message,
                    bearer_token=token,
                    owner_token=owner_token,
                )

    return StreamingResponse(
        _stream_live_events(run_id=run_id, after_seq=after_seq),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@AgenticRouter.post("/runs/{run_id}/stop")
async def stop_run(run_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    _require_agent_token(auth)
    run = await run_in_thread_pool(_get_run_or_404, run_id)
    _assert_run_authorized(run, auth)

    latest_turn = await _latest_user_turn(run_id)
    if latest_turn is None:
        raise HTTPException(status_code=409, detail="No active turn to stop")

    turn_seq, _ = latest_turn
    await request_cancel(run_id, turn_seq)

    task = await _get_active_task(run_id, turn_seq)
    if task is not None and not task.done():
        task.cancel()

    return {
        "run_id": run_id,
        "turn_seq": turn_seq,
        "status": "stopping",
    }


@AgenticRouter.get("/runs/{run_id}")
async def get_run(run_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    run = await run_in_thread_pool(_get_run_or_404, run_id)
    _assert_run_authorized(run, auth)
    return run


@AgenticRouter.get("/runs/{run_id}/events")
async def get_run_events(
    run_id: str,
    request: Request,
    auth: DependencyDirectusSession,
    after_seq: int = Query(default=0, ge=0),
) -> Any:
    run = await run_in_thread_pool(_get_run_or_404, run_id)
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

    events = await _list_events_after(run_id, after_seq)
    latest = await run_in_thread_pool(_get_run_or_404, run_id)
    next_seq = after_seq if not events else int(events[-1].get("seq") or after_seq)
    return {
        "run_id": run_id,
        "status": latest.get("status"),
        "events": events,
        "next_seq": next_seq,
        "done": latest.get("status") in TERMINAL_RUN_STATUSES,
    }


async def _stream_live_events(run_id: str, after_seq: int):
    cursor = after_seq
    last_heartbeat = time.monotonic()

    async def _emit_db_delta():
        nonlocal cursor
        events = await _list_events_after(run_id, cursor)
        for event in events:
            seq = int(event.get("seq") or cursor)
            if seq <= cursor:
                continue
            cursor = seq
            yield _sse_event_payload(event, seq)

    try:
        async with subscribe_live_events(run_id) as pubsub:
            async for line in _emit_db_delta():
                yield line

            async for line in _emit_db_delta():
                yield line

            while True:
                live_payload = await read_live_event(pubsub, timeout_seconds=1.0)
                if live_payload:
                    try:
                        event = json.loads(live_payload)
                    except json.JSONDecodeError:
                        event = None

                    if isinstance(event, dict):
                        seq = int(event.get("seq") or 0)
                        if seq > cursor:
                            cursor = seq
                            yield _sse_event_payload(event, seq)
                    continue

                async for line in _emit_db_delta():
                    yield line

                latest = await run_in_thread_pool(_get_run_or_404, run_id)
                if latest.get("status") in TERMINAL_RUN_STATUSES:
                    async for line in _emit_db_delta():
                        yield line
                    break

                now = time.monotonic()
                if now - last_heartbeat >= SSE_HEARTBEAT_SECONDS:
                    yield "event: heartbeat\ndata: {}\n\n"
                    last_heartbeat = now
    except Exception as exc:  # noqa: BLE001
        logger.warning("Live stream fallback to DB polling for run %s: %s", run_id, exc)
        async for line in _event_stream(run_id=run_id, after_seq=cursor):
            yield line


async def _event_stream(run_id: str, after_seq: int):
    cursor = after_seq
    while True:
        events = await _list_events_after(run_id, cursor)
        if events:
            for event in events:
                seq = int(event.get("seq") or cursor)
                if seq <= cursor:
                    continue
                cursor = seq
                yield _sse_event_payload(event, seq)
            continue

        latest = await run_in_thread_pool(_get_run_or_404, run_id)
        if latest.get("status") in TERMINAL_RUN_STATUSES:
            break

        await asyncio.sleep(SSE_HEARTBEAT_SECONDS)
        yield "event: heartbeat\ndata: {}\n\n"
