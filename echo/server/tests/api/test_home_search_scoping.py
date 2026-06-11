"""GET /home/search must only return results the caller can open.

The selector home page navigates straight to a hit's URL, where
ProjectAccessGuard re-checks via get_user_project_access (no staff
exception). Search must apply the same ladder for every session —
including Directus-admin (is_admin) sessions — or the palette shows
rows that 404 on click ("This isn't available to you").
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.search import SearchRouter
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_DIRECTUS_USER_ID = "du-001"
_APP_USER = {"id": "au-001"}
_ALLOWED_PROJECT = {
    "id": "proj-allowed",
    "name": "test allowed",
    "workspace_id": "ws-mine",
    "updated_at": None,
}
_FORBIDDEN_PROJECT = {
    "id": "proj-forbidden",
    "name": "test forbidden",
    "workspace_id": "ws-other",
    "updated_at": None,
}


def _build_app(*, is_admin: bool) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(_DIRECTUS_USER_ID, is_admin)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(SearchRouter)
    return app


def _fake_sync_directus() -> MagicMock:
    def get_items(collection: str, _params: dict[str, Any]) -> list[dict[str, Any]]:
        if collection == "project":
            return [_ALLOWED_PROJECT, _FORBIDDEN_PROJECT]
        return []

    client = MagicMock()
    client.get_items.side_effect = get_items
    return client


async def _fake_project_access(*, project_id: str, **_kwargs: Any) -> tuple[str, str] | None:
    if project_id == _ALLOWED_PROJECT["id"]:
        return "member", "direct"
    return None


async def _run_search(*, is_admin: bool) -> dict[str, Any]:
    app = _build_app(is_admin=is_admin)
    with (
        patch("dembrane.api.search.directus", _fake_sync_directus()),
        patch("dembrane.api.search.search_rate_limiter.check", new=AsyncMock()),
        patch(
            "dembrane.app_user.resolve_app_user",
            new=AsyncMock(return_value=_APP_USER),
        ),
        patch(
            "dembrane.inheritance.get_user_project_access",
            new=AsyncMock(side_effect=_fake_project_access),
        ),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.get("/home/search", params={"query": "test", "limit": 5})
    assert res.status_code == 200
    return res.json()


@pytest.mark.asyncio
async def test_search_scopes_results_for_regular_users():
    body = await _run_search(is_admin=False)
    assert [p["id"] for p in body["projects"]] == [_ALLOWED_PROJECT["id"]]


@pytest.mark.asyncio
async def test_search_scopes_results_for_directus_admin_sessions():
    """is_admin sessions get the same scoping as everyone else.

    The click-time guard (GET /v2/projects/{id}) has no staff bypass, so
    an unscoped admin search produces dead results.
    """
    body = await _run_search(is_admin=True)
    assert [p["id"] for p in body["projects"]] == [_ALLOWED_PROJECT["id"]]
