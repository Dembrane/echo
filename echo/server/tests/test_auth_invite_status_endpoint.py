"""Tests for the public GET /v2/auth/invite-status probe (ADR 0004).

Unauthenticated. Verifies that revoked invites probe as `not_found` so a
cancelled hash doesn't bounce a visitor into register and create a stray
personal org. Retrofit-checklist regression site: auth.py:94.
"""

from __future__ import annotations

import hmac
import hashlib
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.auth import router


def _invite_hash(invite_id: str) -> str:
    from dembrane.settings import get_settings

    secret = get_settings().directus.secret.encode()
    return hmac.new(secret, invite_id.encode(), hashlib.sha256).hexdigest()[:32]


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router, prefix="/v2/auth")
    return app


def _noop_rate_limiter() -> AsyncMock:
    rl = AsyncMock()
    rl.check = AsyncMock(return_value=None)
    return rl


@pytest.fixture(autouse=True)
def _patch_rate_limiter():
    with patch("dembrane.api.v2.auth._invite_status_rate_limiter", _noop_rate_limiter()):
        yield


@pytest.mark.asyncio
async def test_public_status_revoked_workspace_invite_is_not_found():
    """Revoked workspace_invite must probe as not_found. The query filter
    excludes deleted_at, so get_items returns []; the endpoint cannot
    surface the cancelled invite to the unauthenticated caller. Pins the
    filter shape against future regressions."""
    h = _invite_hash("wi-revoked")
    seen_filter: dict[str, Any] = {}

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "workspace_invite":
            seen_filter.update(params.get("query", {}).get("filter", {}))
        return []  # Filter excludes the revoked row.

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(return_value=None)

    with patch("dembrane.api.v2.auth.async_directus", mock):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/auth/invite-status?email=bob@example.com&h={h}")

    assert resp.status_code == 200
    assert resp.json()["status"] == "not_found"
    assert seen_filter.get("deleted_at") == {"_null": True}, (
        "auth.invite-status must filter workspace_invite by deleted_at:_null "
        "so revoked hashes don't leak as pending to unauthenticated callers"
    )


@pytest.mark.asyncio
async def test_public_status_revoked_org_invite_is_not_found():
    """Same retrofit, org_invite branch. Without the deleted_at filter the
    public probe surfaces a cancelled org-only invite as pending, bouncing
    the visitor into register on a dead link."""
    h = _invite_hash("oi-revoked")
    seen_org_filter: dict[str, Any] = {}

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "org_invite":
            seen_org_filter.update(params.get("query", {}).get("filter", {}))
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(return_value=None)

    with patch("dembrane.api.v2.auth.async_directus", mock):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/auth/invite-status?email=bob@example.com&h={h}")

    assert resp.status_code == 200
    assert resp.json()["status"] == "not_found"
    assert seen_org_filter.get("deleted_at") == {"_null": True}, (
        "auth.invite-status must filter org_invite by deleted_at:_null"
    )
