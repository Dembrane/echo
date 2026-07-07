from __future__ import annotations

from typing import Any
from datetime import datetime, timezone, timedelta

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException

import dembrane.api.v2.bff.canvases as canvases_bff
from dembrane.api.dependency_auth import DirectusSession, require_directus_session
from dembrane.api.v2.bff.canvases import router as canvases_router


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(canvases_router, prefix="/api/v2/bff/canvases")

    async def _override() -> DirectusSession:
        return DirectusSession(user_id="du1", is_admin=False, access_token="t", client=None)

    app.dependency_overrides[require_directus_session] = _override
    return app


class _Access:
    def __init__(self) -> None:
        self.required: list[str] = []

    def require(self, policy: str) -> None:
        self.required.append(policy)


class _DeniedAccess:
    def require(self, policy: str) -> None:  # noqa: ARG002
        raise HTTPException(status_code=403, detail="Not allowed")


async def _get(path: str) -> Any:
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test") as client:
        return await client.get(path)


async def _post(path: str, json: dict[str, Any] | None = None) -> Any:
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test") as client:
        return await client.post(path, json=json)


@pytest.mark.asyncio
async def test_get_canvas_matches_track_b_shape(monkeypatch) -> None:
    access = _Access()

    async def _report(report_id: str, auth) -> tuple[_Access, dict]:  # noqa: ARG001
        return access, {"id": report_id, "kind": "canvas", "project_id": "p1"}

    async def _loop(report_id: str) -> dict:  # noqa: ARG001
        return {"name": "Panel wall", "status": "active", "expires_at": "later", "cadence_minutes": 5}

    async def _generation(report_id: str) -> dict:  # noqa: ARG001
        return {"id": "g1", "report_id": "r1", "content_html": "<html></html>", "status": "ok"}

    monkeypatch.setattr(canvases_bff, "resolve_report_access", _report)
    monkeypatch.setattr(canvases_bff, "get_loop_for_report", _loop)
    monkeypatch.setattr(canvases_bff, "get_latest_generation", _generation)

    res = await _get("/api/v2/bff/canvases/r1")

    assert res.status_code == 200
    assert res.json() == {
        "id": "r1",
        "name": "Panel wall",
        "kind": "canvas",
        "project_id": "p1",
        "latest_generation": {
            "id": "g1",
            "report_id": "r1",
            "content_html": "<html></html>",
            "status": "ok",
        },
        "loop": {"status": "active", "expires_at": "later", "cadence_minutes": 5},
    }
    assert access.required == ["project:read"]


@pytest.mark.asyncio
async def test_create_requires_project_update_and_valid_expiry(monkeypatch) -> None:
    access = _Access()

    async def _project(project_id: str, auth) -> _Access:  # noqa: ARG001
        return access

    async def _create(**kwargs) -> dict:  # noqa: ARG001
        return {"report": {"id": "r1"}}

    class _Directus:
        async def get_item(self, collection: str, item_id: str) -> dict:  # noqa: ARG002
            return {"id": "r1", "kind": "canvas", "project_id": "p1"}

    async def _loop(report_id: str) -> dict:  # noqa: ARG001
        return {"name": "n", "status": "active", "expires_at": "later", "cadence_minutes": 5}

    monkeypatch.setattr(canvases_bff, "resolve_project_access", _project)
    monkeypatch.setattr(canvases_bff, "create_canvas", _create)
    monkeypatch.setattr(canvases_bff, "async_directus", _Directus())
    monkeypatch.setattr(canvases_bff, "get_loop_for_report", _loop)
    async def _no_generation(_report_id: str) -> None:
        return None

    monkeypatch.setattr(canvases_bff, "get_latest_generation", _no_generation)

    expiry = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    res = await _post(
        "/api/v2/bff/canvases",
        {
            "project_id": "p1",
            "name": "n",
            "brief": "brief",
            "cadence_minutes": 5,
            "expires_at": expiry,
        },
    )

    assert res.status_code == 200
    assert access.required == ["project:update"]


@pytest.mark.asyncio
async def test_refresh_rate_limit_and_gate(monkeypatch) -> None:
    access = _Access()

    async def _report(report_id: str, auth) -> tuple[_Access, dict]:  # noqa: ARG001
        return access, {"id": report_id, "kind": "canvas", "project_id": "p1"}

    async def _loop(report_id: str) -> dict:  # noqa: ARG001
        return {"id": "loop1"}

    class _Redis:
        def __init__(self) -> None:
            self.calls = 0

        async def set(self, *args, **kwargs) -> bool:  # noqa: ARG002
            self.calls += 1
            return self.calls == 1

    redis = _Redis()
    ticks: list[tuple[str, str]] = []

    async def _redis() -> _Redis:
        return redis

    async def _tick(loop_id: str, tick_kind: str) -> None:
        ticks.append((loop_id, tick_kind))

    monkeypatch.setattr(canvases_bff, "resolve_report_access", _report)
    monkeypatch.setattr(canvases_bff, "get_loop_for_report", _loop)
    monkeypatch.setattr(canvases_bff, "get_redis_client", _redis)
    monkeypatch.setattr(canvases_bff, "run_tick", _tick)

    res = await _post("/api/v2/bff/canvases/r1/refresh")
    assert res.status_code == 202
    assert res.json() == {"generation": "pending"}
    assert ticks == [("loop1", "manual")]

    res = await _post("/api/v2/bff/canvases/r1/refresh")
    assert res.status_code == 429
    assert res.json() == {"detail": "Just refreshed"}
    assert access.required == [
        "project:read",
        "project:update",
        "project:read",
        "project:update",
    ]
