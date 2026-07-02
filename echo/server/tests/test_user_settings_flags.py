"""Tests for app_user settings JSON feature flags under GET/PATCH /v2/me."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.me import router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "test-user-123"
_APP_USER_ID = "au-test-123"


def _build_app(auth_user_id: str = _USER_ID) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=auth_user_id, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/me")
    return app


@pytest.mark.asyncio
@patch("dembrane.api.v2.me.async_directus")
@patch("dembrane.api.v2.me.resolve_app_user")
@patch("dembrane.api.v2.me.get_directus_user_profile")
async def test_get_me_returns_settings(
    mock_get_profile: AsyncMock,
    mock_resolve_user: AsyncMock,
    mock_directus: AsyncMock,
):
    """GET /v2/me returns settings dict from app_user."""
    mock_get_profile.return_value = {
        "email": "test@example.com",
        "display_name": "Test User",
        "avatar": None,
    }
    # User has some existing feature flags
    mock_resolve_user.return_value = {
        "id": _APP_USER_ID,
        "email": "test@example.com",
        "display_name": "Test User",
        "settings": {"enable_collapsible_sidebar": True},
    }
    mock_directus.get_items.return_value = []  # No memberships, etc.

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.get("/v2/me")

    assert response.status_code == 200
    data = response.json()
    assert data["settings"] == {"enable_collapsible_sidebar": True}


@pytest.mark.asyncio
@patch("dembrane.api.v2.me.async_directus")
@patch("dembrane.api.v2.me.get_app_user_or_raise")
async def test_patch_me_updates_and_merges_settings(
    mock_get_raise: AsyncMock,
    mock_directus: AsyncMock,
):
    """PATCH /v2/me updates and merges settings dict in app_user."""
    # Existing settings in app_user
    mock_get_raise.return_value = {
        "id": _APP_USER_ID,
        "settings": {"enable_collapsible_sidebar": False, "other_flag": True},
    }

    mock_directus.update_item = AsyncMock(return_value={"data": {}})

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.patch(
            "/v2/me",
            json={
                "settings": {"enable_collapsible_sidebar": True}
            },
        )

    assert response.status_code == 200
    assert response.json() == {"status": "success"}

    # Verify update_item payload has the merged dict
    mock_directus.update_item.assert_called_once_with(
        "app_user",
        _APP_USER_ID,
        {
            "settings": {
                "enable_collapsible_sidebar": True,
                "other_flag": True,
            }
        },
    )
