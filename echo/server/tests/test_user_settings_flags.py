"""Tests for app_user settings JSON feature flags under GET/PATCH /v2/me."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch, MagicMock

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
    mock_directus.get_items = AsyncMock(return_value=[])  # No memberships, etc.

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


@pytest.mark.asyncio
@patch("dembrane.api.v2.me.async_directus")
@patch("dembrane.api.v2.me.get_app_user_or_raise")
async def test_patch_me_rejects_nested_settings(
    mock_get_raise: AsyncMock,
    mock_directus: AsyncMock,
):
    """PATCH /v2/me rejects nested dictionaries under settings with 400."""
    mock_get_raise.return_value = {
        "id": _APP_USER_ID,
        "settings": {},
    }

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.patch(
            "/v2/me",
            json={
                "settings": {"nested_key": {"some": "value"}}
            },
        )

    assert response.status_code == 400
    assert "Nested settings objects are not supported" in response.json()["detail"]


@pytest.mark.asyncio
@patch("psycopg.AsyncConnection.connect")
@patch("dembrane.api.v2.me.async_directus")
@patch("dembrane.api.v2.me.get_app_user_or_raise")
async def test_patch_me_uses_psycopg_atomically(
    mock_get_raise: AsyncMock,
    mock_directus: AsyncMock,
    mock_psycopg_connect: AsyncMock,
):
    """PATCH /v2/me uses psycopg.AsyncConnection to atomically merge settings."""
    mock_get_raise.return_value = {
        "id": _APP_USER_ID,
        "settings": {"existing_flag": True},
    }

    # Setup the mock connection and cursor context managers
    mock_cursor = AsyncMock()
    mock_cursor.__aenter__.return_value = mock_cursor
    mock_cursor.__aexit__.return_value = None

    mock_conn = AsyncMock()
    mock_conn.__aenter__.return_value = mock_conn
    mock_conn.__aexit__.return_value = None
    mock_conn.cursor = MagicMock(return_value=mock_cursor)

    mock_psycopg_connect.return_value = mock_conn

    app = _build_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.patch(
            "/v2/me",
            json={
                "settings": {"new_flag": "yes"}
            },
        )

    assert response.status_code == 200
    assert response.json() == {"status": "success"}

    # Verify that the directus update_item is NOT called for settings
    # because the atomic psycopg update succeeded
    mock_directus.update_item.assert_not_called()

    # Verify psycopg execute was called with correct arguments
    mock_cursor.execute.assert_called_once()
    sql_args = mock_cursor.execute.call_args[0]
    assert "UPDATE app_user SET settings = COALESCE(settings, '{}'::jsonb) ||" in sql_args[0]
    assert sql_args[1][0] == '{"new_flag": "yes"}'
    assert sql_args[1][1] == _APP_USER_ID
