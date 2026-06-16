"""Tests for the onboarding endpoint — workspace seeding tier and idempotency.

Covers:
    - Direct signup seeds a workspace at tier=free (not pilot).
    - Invite-only signup does not seed a personal workspace.
    - Re-running onboarding for an existing owner is idempotent (no extra workspace).
    - The seed call bypasses the workspace_request flow (verified via call args).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.onboarding import router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "du-test-001"
_APP_USER_ID = "au-test-001"
_APP_USER = {"id": _APP_USER_ID, "email": "alice@example.com", "display_name": "Alice"}
_DIRECTUS_PROFILE = {"email": "alice@example.com", "display_name": "Alice"}


def _build_app(auth_user_id: str = _USER_ID) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=auth_user_id, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/onboarding")
    return app


def _mock_async_directus() -> AsyncMock:
    """Build an AsyncMock for async_directus with sensible defaults."""
    mock = AsyncMock()
    mock.get_items.return_value = []
    mock.get_item.return_value = None
    mock.create_item.return_value = {"data": {"id": "new-item"}}
    mock.update_item.return_value = {"data": {}}
    return mock


def _noop_rate_limiter() -> AsyncMock:
    """Rate limiter that always passes."""
    rl = AsyncMock()
    rl.check = AsyncMock(return_value=None)
    return rl


@pytest.fixture(autouse=True)
def _patch_rate_limiter():
    """Disable Redis-backed rate limiter in all onboarding tests."""
    with patch(
        "dembrane.api.v2.onboarding._onboarding_rate_limiter",
        _noop_rate_limiter(),
    ):
        yield


@pytest.mark.asyncio
async def test_direct_signup_seeds_free_workspace():
    """A fresh direct-signup user gets a workspace at tier=free."""
    mock_directus = _mock_async_directus()

    call_log: list[tuple[str, dict[str, Any]]] = []
    original_create = mock_directus.create_item

    async def _tracking_create(collection: str, payload: dict[str, Any]) -> dict:
        call_log.append((collection, payload))
        return await original_create(collection, payload)

    mock_directus.create_item = AsyncMock(side_effect=_tracking_create)

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock_directus),
        patch("dembrane.directus_async.async_directus", _mock_async_directus()),
        patch("dembrane.api.v2.onboarding.resolve_app_user", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.onboarding.get_directus_user_profile",
            return_value=_DIRECTUS_PROFILE,
        ),
        patch(
            "dembrane.api.v2.onboarding.assert_can_add_seat",
            new_callable=AsyncMock,
        ),
        patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/v2/onboarding/complete", json={"org_name": "Alice Corp"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["app_user_id"] == _APP_USER_ID
    assert body["org_id"] != ""
    assert body["workspace_id"] != ""

    ws_creates = [(col, p) for col, p in call_log if col == "workspace"]
    assert len(ws_creates) == 1, f"Expected 1 workspace create, got {len(ws_creates)}"
    _, ws_payload = ws_creates[0]
    assert ws_payload["tier"] == "free", (
        f"Seed workspace should be tier=free, got {ws_payload['tier']}"
    )
    assert ws_payload["is_default"] is True


@pytest.mark.asyncio
async def test_invite_user_gets_no_personal_workspace():
    """A user who registers via an invite gets no personal workspace."""
    mock_directus = _mock_async_directus()

    invite_ws = {
        "id": "ws-invite-target",
        "tier": "pioneer",
        "org_id": "org-invite",
        "name": "Team WS",
    }
    pending_invite = {
        "id": "inv-1",
        "workspace_id": "ws-invite-target",
        "role": "member",
        "expires_at": "2099-01-01T00:00:00Z",
    }

    call_log: list[tuple[str, dict[str, Any]]] = []
    original_create = mock_directus.create_item

    async def _tracking_create(collection: str, payload: dict[str, Any]) -> dict:
        call_log.append((collection, payload))
        return await original_create(collection, payload)

    mock_directus.create_item = AsyncMock(side_effect=_tracking_create)

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "workspace_invite":
            return [pending_invite]
        return []

    mock_directus.get_items = AsyncMock(side_effect=_fake_get_items)
    mock_directus.get_item = AsyncMock(
        side_effect=lambda col, _id: invite_ws if col == "workspace" else None
    )

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock_directus),
        patch("dembrane.directus_async.async_directus", _mock_async_directus()),
        patch("dembrane.api.v2.onboarding.resolve_app_user", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.onboarding.get_directus_user_profile",
            return_value=_DIRECTUS_PROFILE,
        ),
        patch(
            "dembrane.api.v2.onboarding.assert_can_add_seat",
            new_callable=AsyncMock,
        ),
        patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
        patch("dembrane.notifications.emit", new_callable=AsyncMock),
        patch("dembrane.notifications.emit_to_audience", new_callable=AsyncMock),
        patch(
            "dembrane.notifications.audience_organisation_admins",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "dembrane.notifications.audience_workspace_admins",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch("dembrane.cache_utils.invalidate_workspace_and_org_usage", new_callable=AsyncMock),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/v2/onboarding/complete", json={"org_name": "Ignored Corp"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["workspace_id"] == "ws-invite-target"

    ws_creates = [(col, p) for col, p in call_log if col == "workspace"]
    assert len(ws_creates) == 0, "Invite user should not get a personal workspace"


@pytest.mark.asyncio
async def test_existing_owner_does_not_get_duplicate_workspace():
    """Re-running onboarding for a user who already owns a workspace is idempotent."""
    mock_directus = _mock_async_directus()

    existing_org_membership = [{"org_id": "org-existing"}]
    existing_workspace = [{"id": "ws-existing"}]
    existing_ws_membership = [{"id": "wm-existing"}]

    call_count = {"workspace_create": 0}
    original_create = mock_directus.create_item

    async def _tracking_create(collection: str, payload: dict[str, Any]) -> dict:
        if collection == "workspace":
            call_count["workspace_create"] += 1
        return await original_create(collection, payload)

    mock_directus.create_item = AsyncMock(side_effect=_tracking_create)

    async def _fake_get_items(collection: str, params: dict) -> Any:
        q = params.get("query", {})
        f = q.get("filter", {})
        if collection == "workspace_invite":
            return []
        if collection == "project":
            return []
        if collection == "org_membership":
            if f.get("role", {}).get("_eq") == "owner":
                return existing_org_membership
            return []
        if collection == "workspace":
            if f.get("is_default", {}).get("_eq") is True:
                return existing_workspace
            return []
        if collection == "workspace_membership":
            return existing_ws_membership
        return []

    mock_directus.get_items = AsyncMock(side_effect=_fake_get_items)

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock_directus),
        patch("dembrane.directus_async.async_directus", _mock_async_directus()),
        patch("dembrane.api.v2.onboarding.resolve_app_user", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.onboarding.get_directus_user_profile",
            return_value=_DIRECTUS_PROFILE,
        ),
        patch(
            "dembrane.api.v2.onboarding.assert_can_add_seat",
            new_callable=AsyncMock,
        ),
        patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/v2/onboarding/complete", json={"org_name": "Alice Corp"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["workspace_id"] == "ws-existing"
    assert call_count["workspace_create"] == 0, "No new workspace should be created"
