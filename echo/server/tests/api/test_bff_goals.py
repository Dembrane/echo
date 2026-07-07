from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

import dembrane.api.v2.bff.goals as goals_bff
from dembrane.api.v2.bff.goals import router as goals_router, methodologies_router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session


def _app(user_id: str = "du-1") -> FastAPI:
    app = FastAPI()
    app.include_router(goals_router, prefix="/api/v2/bff/projects")
    app.include_router(methodologies_router, prefix="/api/v2/bff/methodologies")

    async def _override() -> DirectusSession:
        return DirectusSession(user_id=user_id, is_admin=False, access_token="t", client=None)

    app.dependency_overrides[require_directus_session] = _override
    return app


class _Access:
    def __init__(self) -> None:
        self.required: list[str] = []

    def require(self, policy: str) -> None:
        self.required.append(policy)


class _Directus:
    def __init__(self) -> None:
        self.created: list[tuple[str, dict[str, Any]]] = []

    async def create_item(self, collection: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.created.append((collection, payload))
        return {
            "data": {
                "id": payload["id"],
                "content": payload["content"],
                "set_by": payload["set_by"],
                "created_at": "2026-07-08T10:00:00Z",
            }
        }


async def _get(app: FastAPI, path: str) -> Any:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.get(path)


async def _post(app: FastAPI, path: str, body: dict[str, Any]) -> Any:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.post(path, json=body)


@pytest.mark.asyncio
async def test_get_project_goal_requires_read_and_returns_history(monkeypatch) -> None:
    access = _Access()

    async def _resolve(project_id: str, auth) -> _Access:  # noqa: ARG001
        return access

    async def _revisions(project_id: str) -> list[dict[str, Any]]:
        assert project_id == "p1"
        return [
            {
                "id": "g2",
                "content": "new goal",
                "set_by": "host-edit",
                "created_at": "2026-07-08T10:00:00Z",
            },
            {
                "id": "g1",
                "content": "old goal",
                "set_by": "interview",
                "created_at": "2026-07-08T09:00:00Z",
            },
        ]

    monkeypatch.setattr(goals_bff, "resolve_project_access", _resolve)
    monkeypatch.setattr(goals_bff, "list_project_goal_revisions", _revisions)

    res = await _get(_app(), "/api/v2/bff/projects/p1/goal")

    assert res.status_code == 200
    assert access.required == ["project:read"]
    assert res.json()["current"]["id"] == "g2"
    assert [row["id"] for row in res.json()["revisions"]] == ["g2", "g1"]


@pytest.mark.asyncio
async def test_post_project_goal_requires_update_and_creates_host_edit(monkeypatch) -> None:
    access = _Access()
    directus = _Directus()

    async def _resolve(project_id: str, auth) -> _Access:  # noqa: ARG001
        return access

    monkeypatch.setattr(goals_bff, "resolve_project_access", _resolve)
    monkeypatch.setattr(goals_bff, "async_directus", directus)
    monkeypatch.setattr(goals_bff, "generate_uuid", lambda: "goal-1")

    res = await _post(
        _app(user_id="du-7"),
        "/api/v2/bff/projects/p1/goal",
        {"content": "  revised goal  ", "chat_id": "chat-1"},
    )

    assert res.status_code == 200
    assert access.required == ["project:update"]
    assert res.json() == {
        "id": "goal-1",
        "content": "revised goal",
        "set_by": "host-edit",
        "created_at": "2026-07-08T10:00:00Z",
    }
    assert directus.created == [
        (
            "project_goal_revision",
            {
                "id": "goal-1",
                "project_id": "p1",
                "content": "revised goal",
                "set_by": "host-edit",
                "chat_id": "chat-1",
                "created_by": "du-7",
            },
        )
    ]


@pytest.mark.asyncio
async def test_list_methodologies_resolves_workspace_and_returns_visible(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    async def _ctx(workspace_id: str, auth) -> object:  # noqa: ARG001
        calls.append(("ctx", workspace_id))
        return object()

    async def _list(*, workspace_id: str, directus_user_id: str) -> list[dict[str, Any]]:
        calls.append((workspace_id, directus_user_id))
        return [{"id": "m1", "name": "dembrane", "latest_version": {"id": "v1"}}]

    monkeypatch.setattr(goals_bff, "get_workspace_context", _ctx)
    monkeypatch.setattr(goals_bff, "list_visible_methodologies", _list)

    res = await _get(_app(user_id="du-9"), "/api/v2/bff/methodologies?workspace_id=ws1")

    assert res.status_code == 200
    assert res.json()[0]["name"] == "dembrane"
    assert calls == [("ctx", "ws1"), ("ws1", "du-9")]
