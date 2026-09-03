"""BFF endpoints for popcorn sessions.

Route prefix: /v2/bff/popcorn. Rides the canvas feature flag and the per-project
canvas opt-in, because popcorn runs on the same experimental loop machinery.
"""

from __future__ import annotations

import json
import time
from typing import Any, AsyncIterator
from datetime import datetime, timezone, timedelta

from fastapi import Query, Depends, Request, APIRouter, HTTPException, status
from pydantic import Field, BaseModel
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse

from dembrane.policies import meets_tier
from dembrane.redis_async import get_redis_client
from dembrane.popcorn.view import LOGO_PATH, render_popcorn_page
from dembrane.canvas.events import read_generation_nudge, subscribe_generation_nudges
from dembrane.canvas.service import apply_loop_action, update_loop_settings
from dembrane.directus_async import async_directus
from dembrane.popcorn.bundle import forget_bundle, bundle_for_report
from dembrane.popcorn.service import (
    REPORT_KIND,
    MAX_CADENCE_MINUTES,
    MIN_CADENCE_MINUTES,
    DEFAULT_CADENCE_MINUTES,
    list_versions,
    sample_bundle,
    create_popcorn,
    popcorn_payload,
    update_settings,
    get_version_files,
    get_popcorn_report,
    ensure_public_token,
    get_loop_for_report,
    dispatch_popcorn_tick_now,
)
from dembrane.api.feature_flags import require_canvas_enabled, require_project_canvas_enabled
from dembrane.api.v2.bff._access import resolve_report_access, resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter(dependencies=[Depends(require_canvas_enabled)])

REFRESH_TTL_SECONDS = 20
EVENT_HEARTBEAT_SECONDS = 15.0
NO_STORE = {"Cache-Control": "no-store"}


class CreatePopcornBody(BaseModel):
    project_id: str
    title: str = Field(min_length=1, max_length=160)
    client: str | None = Field(default=None, max_length=160)
    voice: PopcornVoiceBody | None = None
    cadence_minutes: int = Field(
        default=DEFAULT_CADENCE_MINUTES, ge=MIN_CADENCE_MINUTES, le=MAX_CADENCE_MINUTES
    )
    expires_at: datetime


class PopcornVoiceBody(BaseModel):
    presets: list[str] | None = None
    note: str | None = Field(default=None, max_length=600)


class PopcornSettingsBody(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    client: str | None = Field(default=None, max_length=160)
    tabs: dict[str, bool] | None = None
    public: bool | None = None
    show_qr: bool | None = None
    show_branding: bool | None = None
    voice: PopcornVoiceBody | None = None


class PopcornLoopSettingsBody(BaseModel):
    cadence_minutes: int = Field(ge=MIN_CADENCE_MINUTES, le=MAX_CADENCE_MINUTES)
    expires_at: datetime


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value is not None else None


def _validate_expiry(expires_at: datetime) -> datetime:
    now = datetime.now(timezone.utc)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= now:
        raise HTTPException(status_code=422, detail="expires_at must be in the future")
    if expires_at > now + timedelta(days=7):
        raise HTTPException(status_code=422, detail="expires_at must be within 7 days")
    return expires_at


async def _require_popcorn(popcorn_id: str, auth: DependencyDirectusSession) -> tuple[dict, Any]:
    access, report = await resolve_report_access(popcorn_id, auth)
    require_project_canvas_enabled(access.project)
    access.require("project:read")
    if report.get("kind") != REPORT_KIND:
        raise HTTPException(status_code=404, detail="Popcorn not found")
    return report, access


@router.get("")
async def get_project_popcorn(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
) -> dict[str, Any]:
    """The project's popcorn session, or `{"popcorn": null}` before one exists."""
    access = await resolve_project_access(project_id, auth)
    require_project_canvas_enabled(access.project)
    access.require("project:read")
    report = await get_popcorn_report(project_id)
    return {"popcorn": await popcorn_payload(report) if report else None}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_project_popcorn(
    body: CreatePopcornBody,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    access = await resolve_project_access(body.project_id, auth)
    require_project_canvas_enabled(access.project)
    access.require("project:update")
    existing = await get_popcorn_report(body.project_id)
    if existing:
        return await popcorn_payload(existing)
    created = await create_popcorn(
        project_id=body.project_id,
        title=body.title.strip(),
        client=(body.client or "").strip() or None,
        cadence_minutes=body.cadence_minutes,
        expires_at=_validate_expiry(body.expires_at).isoformat(),
        acting_directus_user_id=auth.user_id,
    )
    if body.voice is not None:
        await update_settings(
            report=created["report"], patch={"voice": body.voice.model_dump(exclude_none=True)}
        )
    return await popcorn_payload(created["report"])


# ── try it: upstream's sample deck, no session and no model call ─────


@router.get("/sample/view/", response_class=HTMLResponse)
async def sample_view(auth: DependencyDirectusSession) -> HTMLResponse:  # noqa: ARG001
    return HTMLResponse(render_popcorn_page(embed={"mode": "sample"}), headers=NO_STORE)


@router.get("/sample/view/data/bundle.json")
async def sample_view_bundle(auth: DependencyDirectusSession) -> JSONResponse:  # noqa: ARG001
    return JSONResponse(sample_bundle(), headers={"Cache-Control": "private, max-age=60"})


@router.get("/sample/view/logo.png")
async def sample_view_logo(auth: DependencyDirectusSession) -> FileResponse:  # noqa: ARG001
    return FileResponse(LOGO_PATH, media_type="image/png")


@router.get("/{popcorn_id}")
async def get_popcorn(popcorn_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    report, _access = await _require_popcorn(popcorn_id, auth)
    return await popcorn_payload(report)


@router.patch("/{popcorn_id}/settings")
async def patch_popcorn_settings(
    popcorn_id: str,
    body: PopcornSettingsBody,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    patch = body.model_dump(exclude_none=True)
    if patch.get("show_branding") is False and not meets_tier(
        str(access.tier or "free"), "changemaker"
    ):
        raise HTTPException(
            status_code=403,
            detail="Removing the dembrane mark requires the changemaker tier.",
        )
    if patch.get("public"):
        await ensure_public_token(report)
    await update_settings(report=report, patch=patch)
    forget_bundle(str(report["id"]))
    fresh = await async_directus.get_item("project_report", str(report["id"]))
    return await popcorn_payload(fresh or report)


@router.post("/{popcorn_id}/refresh", status_code=status.HTTP_202_ACCEPTED)
async def refresh_popcorn(popcorn_id: str, auth: DependencyDirectusSession) -> dict[str, str]:
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await get_loop_for_report(str(report["id"]))
    if not loop:
        raise HTTPException(status_code=404, detail="Popcorn loop not found")
    client = await get_redis_client()
    hot = not await client.set(
        f"popcorn:refresh:{popcorn_id}", "1", ex=REFRESH_TTL_SECONDS, nx=True
    )
    if hot:
        raise HTTPException(status_code=429, detail="Just refreshed")
    # Handed to a worker rather than awaited: a manual pass reads every
    # conversation and the request must not hang on the slowest transcript.
    dispatch_popcorn_tick_now(str(loop["id"]), "manual")
    return {"tick": "queued"}


@router.post("/{popcorn_id}/loop/{action}")
async def popcorn_loop_action(
    popcorn_id: str,
    action: str,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    if action not in {"pause", "resume", "stop"}:
        raise HTTPException(status_code=404, detail="Popcorn loop action not found")
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await get_loop_for_report(str(report["id"]))
    if not loop:
        raise HTTPException(status_code=404, detail="Popcorn loop not found")
    try:
        updated = await apply_loop_action(loop, action)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if action == "resume":
        dispatch_popcorn_tick_now(str(loop["id"]), "manual")
    payload = await popcorn_payload(report)
    payload["loop"] = {**(payload.get("loop") or {}), "status": updated.get("status")}
    return payload


@router.patch("/{popcorn_id}/loop")
async def patch_popcorn_loop(
    popcorn_id: str,
    body: PopcornLoopSettingsBody,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await get_loop_for_report(str(report["id"]))
    if not loop:
        raise HTTPException(status_code=404, detail="Popcorn loop not found")
    expires_at = _validate_expiry(body.expires_at)
    try:
        await update_loop_settings(
            loop, cadence_minutes=body.cadence_minutes, expires_at=expires_at.isoformat()
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return await popcorn_payload(report)


@router.get("/{popcorn_id}/events")
async def popcorn_events(
    popcorn_id: str,
    request: Request,
    auth: DependencyDirectusSession,
) -> StreamingResponse:
    """SSE nudges whenever the tick writes new phrases or analysis."""
    report, _access = await _require_popcorn(popcorn_id, auth)
    report_id = str(report["id"])

    async def event_stream() -> AsyncIterator[str]:
        last_heartbeat = time.monotonic()
        yield f"event: connected\ndata: {json.dumps({'type': 'connected'})}\n\n"
        async with subscribe_generation_nudges(report_id) as pubsub:
            while True:
                if await request.is_disconnected():
                    break
                payload = await read_generation_nudge(pubsub, timeout_seconds=1.0)
                if payload is not None:
                    yield f"event: update\ndata: {json.dumps({'type': 'update'})}\n\n"
                    continue
                now = time.monotonic()
                if now - last_heartbeat >= EVENT_HEARTBEAT_SECONDS:
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


# ── the presentation itself, for hosts ───────────────────────────────


@router.get("/{popcorn_id}/versions")
async def popcorn_versions(
    popcorn_id: str, auth: DependencyDirectusSession
) -> list[dict[str, Any]]:
    """Saved runs, newest first. Each one replays in the deck via ?version=."""
    report, _access = await _require_popcorn(popcorn_id, auth)
    return await list_versions(str(report["id"]))


@router.get("/{popcorn_id}/view/", response_class=HTMLResponse)
async def popcorn_view(
    popcorn_id: str,
    auth: DependencyDirectusSession,
    version: str | None = Query(default=None),
) -> HTMLResponse:
    """The deck as the host sees it: the room's view plus the passage behind each
    phrase. Relative data fetches resolve under this path."""
    await _require_popcorn(popcorn_id, auth)
    embed: dict[str, Any] = {"mode": "host"}
    if version:
        embed["version"] = version
    return HTMLResponse(render_popcorn_page(embed=embed), headers=NO_STORE)


@router.get("/{popcorn_id}/view/logo.png")
async def popcorn_view_logo(popcorn_id: str, auth: DependencyDirectusSession) -> FileResponse:
    await _require_popcorn(popcorn_id, auth)
    return FileResponse(
        LOGO_PATH, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"}
    )


@router.get("/{popcorn_id}/view/data/bundle.json")
async def popcorn_view_bundle(
    popcorn_id: str,
    auth: DependencyDirectusSession,
    version: str | None = Query(default=None),
) -> JSONResponse:
    report, access = await _require_popcorn(popcorn_id, auth)
    if version:
        files = await get_version_files(str(report["id"]), version)
        if files is None:
            raise HTTPException(status_code=404, detail="Version not found")
        return JSONResponse(
            {"run": None, "version": version, "files": files},
            headers={"Cache-Control": "private, max-age=300"},
        )
    bundle = await bundle_for_report(report, access.project, host=True)
    return JSONResponse(bundle, headers=NO_STORE)
