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


class _MethodologyDirectus:
    def __init__(self, methodology: dict[str, Any] | None = None) -> None:
        self.methodology = methodology or {
            "id": "m1",
            "name": "Panel day",
            "description": "Panel setup",
            "framing": "Run the panel around neighbourhood concerns.",
            "owner_directus_user_id": "du-1",
            "workspace_id": "ws1",
            "visibility": "workspace",
            "is_seeded": False,
        }
        self.versions: list[dict[str, Any]] = [
            {
                "id": "v1",
                "methodology_id": self.methodology["id"],
                "note": "Initial history",
                "created_by": "du-1",
                "created_at": "2026-07-08T10:00:00Z",
                "content": {"blocks": []},
            }
        ]
        self.created: list[tuple[str, dict[str, Any]]] = []
        self.updated: list[tuple[str, str, dict[str, Any]]] = []

    async def get_item(self, collection: str, item_id: str) -> dict[str, Any] | None:
        if collection == "methodology" and item_id == self.methodology.get("id"):
            return dict(self.methodology)
        return None

    async def get_items(self, collection: str, payload: dict[str, Any]) -> list[dict[str, Any]]:  # noqa: ARG002
        if collection == "methodology_version":
            return list(self.versions)
        return []

    async def create_item(self, collection: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.created.append((collection, payload))
        row = dict(payload)
        row.setdefault("created_at", "2026-07-08T11:00:00Z")
        if collection == "methodology":
            self.methodology = row
        if collection == "methodology_version":
            self.versions.insert(0, row)
        return {"data": row}

    async def update_item(
        self,
        collection: str,
        item_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        self.updated.append((collection, item_id, payload))
        if collection == "methodology" and item_id == self.methodology.get("id"):
            self.methodology = {**self.methodology, **payload}
            return {"data": dict(self.methodology)}
        return {"data": dict(payload)}


class _WorkspaceContext:
    def __init__(self, policies: set[str] | None = None) -> None:
        self.policies = policies or {"project:create", "settings:manage"}

    def has_policy(self, required: str) -> bool:
        return required in self.policies


async def _get(app: FastAPI, path: str) -> Any:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.get(path)


async def _post(app: FastAPI, path: str, body: dict[str, Any]) -> Any:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.post(path, json=body)


async def _ctx(workspace_id: str, auth) -> _WorkspaceContext:  # noqa: ARG001
    assert workspace_id == "ws1"
    return _WorkspaceContext()


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


@pytest.mark.asyncio
async def test_create_methodology_requires_workspace_member_and_creates_first_version(monkeypatch) -> None:
    directus = _MethodologyDirectus()
    ids = iter(["m-new", "v-new"])

    monkeypatch.setattr(goals_bff, "get_workspace_context", _ctx)
    monkeypatch.setattr(goals_bff, "async_directus", directus)
    monkeypatch.setattr(goals_bff, "generate_uuid", lambda: next(ids))

    res = await _post(
        _app(user_id="du-7"),
        "/api/v2/bff/methodologies",
        {
            "workspace_id": "ws1",
            "name": "  Panel day  ",
            "description": "  Day-long panel  ",
            "framing": "  Keep tables aligned.  ",
            "content": {"blocks": [{"type": "goal"}]},
        },
    )

    assert res.status_code == 200
    assert res.json()["id"] == "m-new"
    assert res.json()["latest_version"]["id"] == "v-new"
    assert res.json()["versions_count"] == 1
    assert directus.created == [
        (
            "methodology",
            {
                "id": "m-new",
                "workspace_id": "ws1",
                "owner_directus_user_id": "du-7",
                "visibility": "workspace",
                "is_seeded": False,
                "name": "Panel day",
                "description": "Day-long panel",
                "framing": "Keep tables aligned.",
            },
        ),
        (
            "methodology_version",
            {
                "id": "v-new",
                "methodology_id": "m-new",
                "content": {"blocks": [{"type": "goal"}]},
                "note": "Initial history",
                "created_by": "du-7",
            },
        ),
    ]


@pytest.mark.asyncio
async def test_get_methodology_returns_detail_with_history(monkeypatch) -> None:
    directus = _MethodologyDirectus()

    monkeypatch.setattr(goals_bff, "get_workspace_context", _ctx)
    monkeypatch.setattr(goals_bff, "async_directus", directus)

    res = await _get(_app(user_id="du-2"), "/api/v2/bff/methodologies/m1")

    assert res.status_code == 200
    assert res.json()["name"] == "Panel day"
    assert res.json()["versions"][0] == {
        "id": "v1",
        "note": "Initial history",
        "created_by": "du-1",
        "created_at": "2026-07-08T10:00:00Z",
        "content": {"blocks": []},
    }


@pytest.mark.asyncio
async def test_owner_edit_updates_metadata_and_appends_content_version(monkeypatch) -> None:
    directus = _MethodologyDirectus()
    monkeypatch.setattr(goals_bff, "get_workspace_context", _ctx)
    monkeypatch.setattr(goals_bff, "async_directus", directus)
    monkeypatch.setattr(goals_bff, "generate_uuid", lambda: "v2")

    res = await _post(
        _app(user_id="du-1"),
        "/api/v2/bff/methodologies/m1/versions",
        {
            "name": "Panel day refined",
            "description": "Panel setup",
            "framing": "Ask by neighbourhood.",
            "content": "plain notes",
            "note": "Tightened the framing",
        },
    )

    assert res.status_code == 200
    assert res.json()["name"] == "Panel day refined"
    assert res.json()["latest_version"]["id"] == "v2"
    assert directus.updated == [
        (
            "methodology",
            "m1",
            {
                "name": "Panel day refined",
                "description": "Panel setup",
                "framing": "Ask by neighbourhood.",
            },
        )
    ]
    assert directus.created[-1] == (
        "methodology_version",
        {
            "id": "v2",
            "methodology_id": "m1",
            "content": "plain notes",
            "note": "Tightened the framing",
            "created_by": "du-1",
        },
    )


@pytest.mark.asyncio
async def test_workspace_admin_can_edit_workspace_methodology(monkeypatch) -> None:
    directus = _MethodologyDirectus()
    monkeypatch.setattr(goals_bff, "get_workspace_context", _ctx)
    monkeypatch.setattr(goals_bff, "async_directus", directus)

    res = await _post(
        _app(user_id="du-admin"),
        "/api/v2/bff/methodologies/m1/versions",
        {"framing": "Admin edit."},
    )

    assert res.status_code == 200
    assert directus.updated == [("methodology", "m1", {"framing": "Admin edit."})]
    assert directus.created == []


@pytest.mark.asyncio
async def test_seeded_methodology_is_read_only(monkeypatch) -> None:
    directus = _MethodologyDirectus(
        {
            "id": "dembrane",
            "name": "dembrane",
            "description": "Default",
            "framing": "Figure out what this project is for.",
            "owner_directus_user_id": None,
            "workspace_id": None,
            "visibility": "public",
            "is_seeded": True,
        }
    )
    monkeypatch.setattr(goals_bff, "get_workspace_context", _ctx)
    monkeypatch.setattr(goals_bff, "async_directus", directus)

    res = await _post(
        _app(user_id="du-admin"),
        "/api/v2/bff/methodologies/dembrane/versions",
        {"framing": "Change it."},
    )

    assert res.status_code == 403
    assert res.json() == {"detail": "The dembrane methodology is read-only"}
    assert directus.updated == []
    assert directus.created == []


@pytest.mark.asyncio
async def test_create_methodology_without_content_sends_empty_object(monkeypatch) -> None:
    # methodology_version.content is NOT NULL in Directus; omitting content in
    # the create form must persist {} - null crashed echo-next (wave 6h).
    captured: list[dict] = []

    class _Fake:
        async def create_item(self, collection, payload):
            captured.append({"collection": collection, "payload": payload})
            return {"data": {**payload}}

        async def get_items(self, collection, query):  # noqa: ARG002
            return []

    import dembrane.api.v2.bff.goals as goals_bff

    monkeypatch.setattr(goals_bff, "async_directus", _Fake())

    class _Ctx:
        workspace_id = "ws-1"
        app_user_id = "au-1"

        def has_policy(self, _p):
            return True

    async def _ctx(workspace_id, auth):  # noqa: ARG001
        return _Ctx()

    monkeypatch.setattr(goals_bff, "get_workspace_context", _ctx)

    from httpx import AsyncClient, ASGITransport
    from fastapi import FastAPI

    from dembrane.api.dependency_auth import DirectusSession, require_directus_session

    app = FastAPI()
    app.include_router(goals_bff.methodologies_router, prefix="/api/v2/bff/methodologies")

    async def _override():
        return DirectusSession(user_id="du-1", is_admin=False, access_token="t", client=None)

    app.dependency_overrides[require_directus_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        res = await client.post(
            "/api/v2/bff/methodologies",
            json={"workspace_id": "ws-1", "name": "n", "description": "d", "framing": "f"},
        )

    assert res.status_code == 200
    version_creates = [c for c in captured if c["collection"] == "methodology_version"]
    assert version_creates and version_creates[0]["payload"]["content"] == {}
