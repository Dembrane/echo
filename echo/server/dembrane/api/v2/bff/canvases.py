"""BFF endpoints for dynamic canvases."""

from __future__ import annotations

from typing import Any
from datetime import datetime, timezone, timedelta

from fastapi import Query, APIRouter, HTTPException, status
from pydantic import Field, BaseModel

from dembrane.redis_async import get_redis_client
from dembrane.canvas.ticks import run_tick
from dembrane.canvas.service import (
    create_canvas,
    list_generations,
    get_loop_for_report,
    get_latest_generation,
)
from dembrane.directus_async import async_directus
from dembrane.api.v2.bff._access import resolve_report_access, resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()

REFRESH_TTL_SECONDS = 30


class CreateCanvasBody(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=160)
    brief: str = Field(min_length=1, max_length=8000)
    gather_spec: dict[str, Any] | None = None
    cadence_minutes: int = Field(default=5, ge=2, le=120)
    expires_at: datetime


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
    generation = await get_latest_generation(report_id)
    project_id = _as_id(report.get("project_id"))
    return {
        "id": report_id,
        "name": (loop or {}).get("name") or report.get("user_instructions") or "Canvas",
        "kind": "canvas",
        "project_id": project_id,
        "latest_generation": generation,
        "loop": (
            {
                "status": loop.get("status"),
                "expires_at": loop.get("expires_at"),
                "cadence_minutes": loop.get("cadence_minutes"),
            }
            if loop
            else None
        ),
    }


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

    created = await create_canvas(
        project_id=body.project_id,
        name=body.name,
        brief=body.brief,
        gather_spec=body.gather_spec,
        cadence_minutes=body.cadence_minutes,
        expires_at=expires_at.isoformat(),
        acting_directus_user_id=auth.user_id,
    )
    report = await async_directus.get_item("project_report", str(created["report"]["id"]))
    return await _canvas_payload(report)


@router.get("/{canvas_id}")
async def get_canvas(canvas_id: str, auth: DependencyDirectusSession) -> dict:
    report, _access = await _require_canvas(canvas_id, auth)
    return await _canvas_payload(report)


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
