"""Tests for POST /v2/workspaces/:id/access-requests role gating."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.dependency_auth import DirectusSession, require_directus_session
from dembrane.api.v2.access_requests import router

_USER_ID = "du-1"
_APP_USER = {"id": "au-1", "email": "u@example.com", "display_name": "U"}
_ORG_ID = "org-1"
_WS_ID = "ws-1"
_WS = {"id": _WS_ID, "org_id": _ORG_ID, "visibility": "open_to_organisation", "tier": "pioneer", "name": "WS"}


def _build_app() -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/workspaces")
    return app


def _mock(*, org_role: str | None) -> AsyncMock:
    async def get_items(collection: str, _params: dict[str, Any]) -> list[dict[str, Any]]:
        if collection == "org_membership":
            return [{"role": org_role}] if org_role else []
        if collection == "workspace_membership":
            return []
        if collection == "access_request":
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=get_items)
    mock.get_item = AsyncMock(return_value=dict(_WS))
    mock.create_item = AsyncMock(return_value={"data": {"id": "req-1"}})
    return mock


def _ba_mock() -> AsyncMock:
    """billing_account directus client: tier resolves to the workspace's tier."""

    def _gi(coll, item_id, *_args, **_kwargs):
        if coll == "billing_account":
            return {"id": item_id, "tier": _WS["tier"]}
        return {"id": _WS_ID, "billing_account_id": "acc-1"}

    mock = AsyncMock()
    mock.get_item = AsyncMock(side_effect=_gi)
    return mock


async def _post(*, org_role: str, is_external: bool) -> int:
    mock = _mock(org_role=org_role)
    with (
        patch("dembrane.api.v2.access_requests.async_directus", mock),
        patch("dembrane.directus_async.async_directus", _ba_mock()),
        patch("dembrane.api.v2.access_requests._request_access_rate_limiter.check", AsyncMock()),
        patch("dembrane.api.v2.access_requests.get_app_user_or_raise", AsyncMock(return_value=_APP_USER)),
        patch("dembrane.api.v2.access_requests.is_org_external_only", AsyncMock(return_value=is_external)),
        patch("dembrane.notifications.emit_to_audience", AsyncMock()),
        patch("dembrane.notifications.audience_workspace_admins", AsyncMock(return_value=[])),
        patch("dembrane.notifications.audience_organisation_admins", AsyncMock(return_value=[])),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.post(f"/v2/workspaces/{_WS_ID}/access-requests")
    return res.status_code


@pytest.mark.asyncio
async def test_member_can_request():
    assert await _post(org_role="member", is_external=False) == 200


@pytest.mark.asyncio
async def test_billing_can_request():
    assert await _post(org_role="billing", is_external=False) == 200


@pytest.mark.asyncio
async def test_external_only_rejected():
    assert await _post(org_role="member", is_external=True) == 403
