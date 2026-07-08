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


async def _patch(path: str, json: dict[str, Any] | None = None) -> Any:
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test") as client:
        return await client.patch(path, json=json)


@pytest.mark.asyncio
async def test_get_canvas_matches_track_b_shape(monkeypatch) -> None:
    access = _Access()

    async def _report(report_id: str, auth) -> tuple[_Access, dict]:  # noqa: ARG001
        return access, {"id": report_id, "kind": "canvas", "project_id": "p1"}

    async def _loop(report_id: str) -> dict:  # noqa: ARG001
        return {"name": "Panel wall", "status": "active", "expires_at": "later", "cadence_minutes": 5}

    async def _generation(report_id: str) -> dict:  # noqa: ARG001
        return {"id": "g1", "report_id": "r1", "content_html": "<html></html>", "status": "ok"}

    async def _config(report_id: str) -> dict:  # noqa: ARG001
        return {
            "brief": "Show themes",
            "gather_spec": {"window_minutes": 60},
            "cadence_minutes": 5,
            "created_at": "2026-07-07T10:00:00Z",
        }

    monkeypatch.setattr(canvases_bff, "resolve_report_access", _report)
    monkeypatch.setattr(canvases_bff, "get_loop_for_report", _loop)
    monkeypatch.setattr(canvases_bff, "get_latest_generation", _generation)
    monkeypatch.setattr(canvases_bff, "get_latest_config", _config)

    res = await _get("/api/v2/bff/canvases/r1")

    assert res.status_code == 200
    assert res.json() == {
        "id": "r1",
        "name": "Panel wall",
        "kind": "canvas",
        "project_id": "p1",
        "created_from_chat_id": None,
        "updated_at": None,
        "config": {
            "brief": "Show themes",
            "gather_spec": {"window_minutes": 60},
            "cadence_minutes": 5,
            "created_at": "2026-07-07T10:00:00Z",
        },
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
async def test_list_canvases_requires_project_read_and_returns_summary_shape(monkeypatch) -> None:
    access = _Access()

    async def _project(project_id: str, auth) -> _Access:  # noqa: ARG001
        assert project_id == "p1"
        return access

    async def _list(project_id: str) -> list[dict[str, Any]]:
        assert project_id == "p1"
        return [
            {
                "id": "r2",
                "name": "New wall",
                "kind": "canvas",
                "created_at": "2026-07-07T10:00:00Z",
                "latest_generation_at": "2026-07-07T10:05:00Z",
                "loop": {"status": "active", "expires_at": "later", "cadence_minutes": 5},
            }
        ]

    monkeypatch.setattr(canvases_bff, "resolve_project_access", _project)
    monkeypatch.setattr(canvases_bff, "list_canvas_summaries", _list)

    res = await _get("/api/v2/bff/canvases?project_id=p1")

    assert res.status_code == 200
    assert res.json()[0]["latest_generation_at"] == "2026-07-07T10:05:00Z"
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
            if collection == "project_chat":
                return {"id": item_id, "project_id": "p1", "deleted_at": None}
            return {"id": "r1", "kind": "canvas", "project_id": "p1"}

    async def _loop(report_id: str) -> dict:  # noqa: ARG001
        return {
            "name": "n",
            "status": "active",
            "expires_at": "later",
            "cadence_minutes": 5,
            "created_from_chat_id": "chat-1",
        }

    async def _config(report_id: str) -> dict:  # noqa: ARG001
        return {"brief": "brief", "gather_spec": None, "cadence_minutes": 5, "created_at": "now"}

    monkeypatch.setattr(canvases_bff, "resolve_project_access", _project)
    monkeypatch.setattr(canvases_bff, "create_canvas", _create)
    monkeypatch.setattr(canvases_bff, "async_directus", _Directus())
    monkeypatch.setattr(canvases_bff, "get_loop_for_report", _loop)
    monkeypatch.setattr(canvases_bff, "get_latest_config", _config)
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
            "created_from_chat_id": "chat-1",
        },
    )

    assert res.status_code == 200
    assert res.json()["created_from_chat_id"] == "chat-1"
    assert access.required == ["project:update"]


@pytest.mark.asyncio
async def test_preview_runs_gather_generate_sanitize_without_persisting_and_rate_limits(
    monkeypatch,
) -> None:
    access = _Access()

    async def _project(project_id: str, auth) -> _Access:  # noqa: ARG001
        return access

    class _Redis:
        def __init__(self) -> None:
            self.calls = 0

        async def set(self, *args, **kwargs) -> bool:  # noqa: ARG002
            self.calls += 1
            return self.calls == 1

    redis = _Redis()
    gather_calls: list[dict[str, Any]] = []

    async def _redis() -> _Redis:
        return redis

    async def _gather(**kwargs) -> dict[str, Any]:
        gather_calls.append(kwargs)
        return {"project": {"name": "Project"}, "conversations": []}

    async def _generate_html(**kwargs) -> str:
        assert kwargs["previous_html"] is None
        return "<html><body><main><p>preview</p></main></body></html>"

    monkeypatch.setattr(canvases_bff, "resolve_project_access", _project)
    monkeypatch.setattr(canvases_bff, "get_redis_client", _redis)
    monkeypatch.setattr(canvases_bff, "execute_gather_spec", _gather)
    monkeypatch.setattr(canvases_bff, "_generate_html", _generate_html)

    res = await _post(
        "/api/v2/bff/canvases/preview",
        {"project_id": "p1", "brief": "Show live themes", "gather_spec": {"window_minutes": 15}},
    )
    assert res.status_code == 200
    assert res.json()["content_html"] == "<main><p>preview</p></main>"
    assert gather_calls == [
        {
            "project_id": "p1",
            "acting_directus_user_id": "du1",
            "gather_spec": {"window_minutes": 15},
            "preview_sample": True,
        }
    ]
    assert access.required == ["project:update"]

    res = await _post(
        "/api/v2/bff/canvases/preview",
        {"project_id": "p1", "brief": "Show live themes"},
    )
    assert res.status_code == 429
    assert res.json() == {"detail": "Just previewed"}


@pytest.mark.asyncio
async def test_update_canvas_appends_revision_and_returns_canvas(monkeypatch) -> None:
    access = _Access()
    updated_calls: list[dict[str, Any]] = []

    async def _report(report_id: str, auth) -> tuple[_Access, dict]:  # noqa: ARG001
        return access, {"id": report_id, "kind": "canvas", "project_id": "p1"}

    async def _update(**kwargs) -> dict[str, Any]:
        updated_calls.append(kwargs)
        return {"report": {"id": "r1", "kind": "canvas", "project_id": "p1"}}

    async def _loop(report_id: str) -> dict:  # noqa: ARG001
        return {
            "name": "Updated wall",
            "status": "active",
            "expires_at": "later",
            "cadence_minutes": 10,
            "updated_at": "2026-07-07T10:15:00Z",
        }

    async def _config(report_id: str) -> dict:  # noqa: ARG001
        return {
            "brief": "Updated brief",
            "gather_spec": {"window_minutes": 30},
            "cadence_minutes": 10,
            "created_at": "2026-07-07T10:15:00Z",
        }

    async def _no_generation(_report_id: str) -> None:
        return None

    monkeypatch.setattr(canvases_bff, "resolve_report_access", _report)
    monkeypatch.setattr(canvases_bff, "update_canvas_config", _update)
    monkeypatch.setattr(canvases_bff, "get_loop_for_report", _loop)
    monkeypatch.setattr(canvases_bff, "get_latest_config", _config)
    monkeypatch.setattr(canvases_bff, "get_latest_generation", _no_generation)

    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test") as client:
        res = await client.patch(
            "/api/v2/bff/canvases/r1",
            json={
                "name": "Updated wall",
                "brief": "Updated brief",
                "gather_spec": {"window_minutes": 30},
                "cadence_minutes": 10,
            },
        )

    assert res.status_code == 200
    assert updated_calls == [
        {
            "report_id": "r1",
            "name": "Updated wall",
            "brief": "Updated brief",
            "gather_spec": {"window_minutes": 30},
            "cadence_minutes": 10,
            "created_by": "du1",
        }
    ]
    assert res.json()["config"]["brief"] == "Updated brief"
    assert access.required == ["project:read", "project:update"]


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


@pytest.mark.asyncio
async def test_loop_lifecycle_delegates_and_maps_ended_resume(monkeypatch) -> None:
    access = _Access()

    async def _report(report_id: str, auth) -> tuple[_Access, dict]:  # noqa: ARG001
        return access, {"id": report_id, "kind": "canvas", "project_id": "p1"}

    async def _loop(report_id: str) -> dict:  # noqa: ARG001
        return {"id": "loop1", "status": "paused", "expires_at": "later", "cadence_minutes": 5}

    async def _apply(loop: dict[str, Any], action: str) -> dict[str, Any]:
        assert loop["id"] == "loop1"
        assert action == "resume"
        return {"status": "active", "expires_at": "later", "cadence_minutes": 5}

    monkeypatch.setattr(canvases_bff, "resolve_report_access", _report)
    monkeypatch.setattr(canvases_bff, "get_loop_for_report", _loop)
    monkeypatch.setattr(canvases_bff, "apply_loop_action", _apply)

    res = await _post("/api/v2/bff/canvases/r1/loop/resume")

    assert res.status_code == 200
    assert res.json() == {"status": "active", "expires_at": "later", "cadence_minutes": 5}
    assert access.required == ["project:read", "project:update"]

    async def _ended(loop: dict[str, Any], action: str) -> dict[str, Any]:  # noqa: ARG001
        raise ValueError("This loop has ended")

    monkeypatch.setattr(canvases_bff, "apply_loop_action", _ended)
    res = await _post("/api/v2/bff/canvases/r1/loop/resume")

    assert res.status_code == 409
    assert res.json() == {"detail": "This loop has ended"}


@pytest.mark.asyncio
async def test_patch_loop_updates_expiry_and_cadence(monkeypatch) -> None:
    access = _Access()
    expires_at = datetime.now(timezone.utc) + timedelta(hours=8)
    seen: dict[str, Any] = {}

    async def _report(report_id: str, auth) -> tuple[_Access, dict]:  # noqa: ARG001
        return access, {"id": report_id, "kind": "canvas", "project_id": "p1"}

    async def _loop(report_id: str) -> dict:  # noqa: ARG001
        return {"id": "loop1", "status": "active", "expires_at": "old", "cadence_minutes": 5}

    async def _update_loop_settings(
        loop: dict[str, Any],
        *,
        cadence_minutes: int,
        expires_at: str,
    ) -> dict[str, Any]:
        seen["loop"] = loop
        seen["cadence_minutes"] = cadence_minutes
        seen["expires_at"] = expires_at
        return {
            "status": "active",
            "expires_at": expires_at,
            "cadence_minutes": cadence_minutes,
        }

    monkeypatch.setattr(canvases_bff, "resolve_report_access", _report)
    monkeypatch.setattr(canvases_bff, "get_loop_for_report", _loop)
    monkeypatch.setattr(canvases_bff, "update_loop_settings", _update_loop_settings)

    res = await _patch(
        "/api/v2/bff/canvases/r1/loop",
        {"cadence_minutes": 15, "expires_at": expires_at.isoformat()},
    )

    assert res.status_code == 200
    assert res.json()["status"] == "active"
    assert res.json()["cadence_minutes"] == 15
    assert seen["loop"]["id"] == "loop1"
    assert seen["cadence_minutes"] == 15
    assert seen["expires_at"].startswith(expires_at.isoformat()[:19])
    assert access.required == ["project:read", "project:update"]
