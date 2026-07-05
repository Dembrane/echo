from __future__ import annotations

from typing import Any, Optional

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException

import dembrane.api.v2.bff.memory as memory_bff
from dembrane.api.agentic import _build_initial_agent_prompt_content
from dembrane.api.v2.bff.memory import router as memory_router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session


def _app(user_id: str = "du-1") -> FastAPI:
    app = FastAPI()
    app.include_router(memory_router, prefix="/api/v2/bff/memory")

    async def _override() -> DirectusSession:
        return DirectusSession(user_id=user_id, is_admin=False, access_token="t", client=None)

    app.dependency_overrides[require_directus_session] = _override
    return app


class _FakeDirectus:
    def __init__(
        self,
        rows: Optional[list[dict]] = None,
        item: Optional[dict] = None,
    ) -> None:
        self.rows = rows or []
        self.item = item
        self.get_items_calls: list[tuple[str, dict]] = []
        self.deleted: list[tuple[str, str]] = []

    async def get_items(self, collection: str, query: dict) -> list[dict]:
        self.get_items_calls.append((collection, query))
        return self.rows

    async def get_item(self, collection: str, item_id: str) -> Optional[dict]:  # noqa: ARG002
        return self.item

    async def delete_item(self, collection: str, item_id: str) -> None:
        self.deleted.append((collection, item_id))


class _Access:
    def __init__(self) -> None:
        self.required: list[str] = []

    def require(self, policy: str) -> None:
        self.required.append(policy)


class _DeniedAccess:
    def require(self, policy: str) -> None:  # noqa: ARG002
        raise HTTPException(status_code=403, detail="Not allowed")


class _WorkspaceCtx:
    def __init__(self) -> None:
        self.required: list[str] = []

    def require_policy(self, policy: str) -> None:
        self.required.append(policy)


async def _get(app: FastAPI, path: str) -> Any:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.get(path)


async def _delete(app: FastAPI, path: str) -> Any:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.delete(path)


@pytest.mark.asyncio
async def test_list_user_memory_filters_by_owner(monkeypatch) -> None:
    fake = _FakeDirectus(
        rows=[
            {
                "id": "m1",
                "scope": "user",
                "memory_key": "tone",
                "content": "Prefers short answers",
                "source": "agent",
                "created_at": "2026-07-06T00:00:00Z",
                "updated_at": "2026-07-06T00:00:00Z",
                "directus_user_id": "du-1",
            }
        ]
    )
    monkeypatch.setattr(memory_bff, "async_directus", fake)

    res = await _get(_app(), "/api/v2/bff/memory/user")

    assert res.status_code == 200
    body = res.json()
    assert [m["id"] for m in body] == ["m1"]
    # Owner id never leaves the API — cards carry only the list fields.
    assert "directus_user_id" not in body[0]
    _, query = fake.get_items_calls[0]
    assert query["query"]["filter"] == {
        "scope": {"_eq": "user"},
        "directus_user_id": {"_eq": "du-1"},
    }


@pytest.mark.asyncio
async def test_list_project_memory_requires_chat_use(monkeypatch) -> None:
    fake = _FakeDirectus(rows=[])
    access = _Access()

    async def _resolve(project_id: str, auth) -> _Access:  # noqa: ARG001
        return access

    monkeypatch.setattr(memory_bff, "async_directus", fake)
    monkeypatch.setattr(memory_bff, "resolve_project_access", _resolve)

    res = await _get(_app(), "/api/v2/bff/memory/project/p1")

    assert res.status_code == 200
    assert access.required == ["chat:use"]
    _, query = fake.get_items_calls[0]
    assert query["query"]["filter"] == {
        "scope": {"_eq": "project"},
        "project_id": {"_eq": "p1"},
    }


@pytest.mark.asyncio
async def test_list_workspace_memory_requires_chat_use(monkeypatch) -> None:
    fake = _FakeDirectus(rows=[])
    ctx = _WorkspaceCtx()

    async def _ctx(workspace_id: str, auth) -> _WorkspaceCtx:  # noqa: ARG001
        return ctx

    monkeypatch.setattr(memory_bff, "async_directus", fake)
    monkeypatch.setattr(memory_bff, "get_workspace_context", _ctx)

    res = await _get(_app(), "/api/v2/bff/memory/workspace/ws1")

    assert res.status_code == 200
    assert ctx.required == ["chat:use"]
    _, query = fake.get_items_calls[0]
    assert query["query"]["filter"] == {
        "scope": {"_eq": "workspace"},
        "workspace_id": {"_eq": "ws1"},
    }


@pytest.mark.asyncio
async def test_delete_user_memory_owner_only(monkeypatch) -> None:
    row = {"id": "m1", "scope": "user", "directus_user_id": "du-1"}
    fake = _FakeDirectus(item=row)
    monkeypatch.setattr(memory_bff, "async_directus", fake)

    res = await _delete(_app(user_id="du-2"), "/api/v2/bff/memory/m1")
    assert res.status_code == 404
    assert fake.deleted == []

    res = await _delete(_app(user_id="du-1"), "/api/v2/bff/memory/m1")
    assert res.status_code == 200
    assert fake.deleted == [("agent_memory", "m1")]


@pytest.mark.asyncio
async def test_delete_project_memory_gates_on_chat_use(monkeypatch) -> None:
    row = {"id": "m2", "scope": "project", "project_id": "p1"}
    fake = _FakeDirectus(item=row)

    async def _denied(project_id: str, auth) -> _DeniedAccess:  # noqa: ARG001
        return _DeniedAccess()

    monkeypatch.setattr(memory_bff, "async_directus", fake)
    monkeypatch.setattr(memory_bff, "resolve_project_access", _denied)

    res = await _delete(_app(), "/api/v2/bff/memory/m2")
    assert res.status_code == 403
    assert fake.deleted == []

    access = _Access()

    async def _granted(project_id: str, auth) -> _Access:  # noqa: ARG001
        return access

    monkeypatch.setattr(memory_bff, "resolve_project_access", _granted)

    res = await _delete(_app(), "/api/v2/bff/memory/m2")
    assert res.status_code == 200
    assert access.required == ["chat:use"]
    assert fake.deleted == [("agent_memory", "m2")]


@pytest.mark.asyncio
async def test_delete_workspace_memory_gates_on_chat_use(monkeypatch) -> None:
    row = {"id": "m3", "scope": "workspace", "workspace_id": "ws1"}
    fake = _FakeDirectus(item=row)
    ctx = _WorkspaceCtx()

    async def _ctx(workspace_id: str, auth) -> _WorkspaceCtx:  # noqa: ARG001
        return ctx

    monkeypatch.setattr(memory_bff, "async_directus", fake)
    monkeypatch.setattr(memory_bff, "get_workspace_context", _ctx)

    res = await _delete(_app(), "/api/v2/bff/memory/m3")
    assert res.status_code == 200
    assert ctx.required == ["chat:use"]
    assert fake.deleted == [("agent_memory", "m3")]


@pytest.mark.asyncio
async def test_delete_malformed_row_is_404(monkeypatch) -> None:
    # Unknown scope, or a scope row missing its owner id: unreachable.
    for row in (
        {"id": "m4", "scope": "global"},
        {"id": "m5", "scope": "project"},
        {"id": "m6", "scope": "workspace"},
        None,
    ):
        fake = _FakeDirectus(item=row)
        monkeypatch.setattr(memory_bff, "async_directus", fake)
        res = await _delete(_app(), "/api/v2/bff/memory/x")
        assert res.status_code == 404
        assert fake.deleted == []


def test_initial_prompt_includes_workspace_context() -> None:
    content = _build_initial_agent_prompt_content(
        project_name="Street interviews",
        project_context="Ask about the market",
        user_message="hello",
        workspace_context="Municipality of Utrecht listening programme",
    )
    assert "Workspace Context: Municipality of Utrecht listening programme" in content
    assert content.index("Workspace Context:") < content.index("Project Context:")


def test_initial_prompt_defaults_workspace_context_to_none_marker() -> None:
    content = _build_initial_agent_prompt_content(
        project_name="Street interviews",
        project_context=None,
        user_message="hello",
    )
    assert "Workspace Context: (none)" in content
