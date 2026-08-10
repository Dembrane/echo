"""Tests for deep merge and atomic app_user.settings updates."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
from fastapi import HTTPException

from dembrane.api.v2.me import deep_merge, update_user_settings_atomic


class MockAsyncContextManager:
    """Mock for psycopg async context managers (conn, cursor, transaction)."""
    def __init__(self, target):
        self.target = target

    async def __aenter__(self):
        return self.target

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return False


def test_deep_merge_flat_keys() -> None:
    """Verifies that flat keys merge alongside siblings properly."""
    dict1 = {"release_video_seen": "v1.0.0", "beta_feature_enabled": True}
    dict2 = {"release_video_seen": "v1.1.0"}
    
    merged = deep_merge(dict1, dict2)
    assert merged == {"release_video_seen": "v1.1.0", "beta_feature_enabled": True}


def test_deep_merge_nested_objects() -> None:
    """Verifies that nested objects recursively merge instead of wholesale replacing siblings."""
    dict1 = {
        "preferences": {
            "theme": "dark",
            "notifications": {
                "email": True,
                "sms": False
            }
        }
    }
    dict2 = {
        "preferences": {
            "notifications": {
                "sms": True
            }
        }
    }
    
    merged = deep_merge(dict1, dict2)
    assert merged == {
        "preferences": {
            "theme": "dark",
            "notifications": {
                "email": True,
                "sms": True
            }
        }
    }


def test_deep_merge_type_mismatch() -> None:
    """Verifies that if one side is not a dictionary, it gets replaced instead of crashing."""
    dict1 = {"preferences": "not-a-dict"}
    dict2 = {"preferences": {"theme": "light"}}
    
    merged = deep_merge(dict1, dict2)
    assert merged == {"preferences": {"theme": "light"}}


@pytest.mark.asyncio
async def test_update_user_settings_atomic_success() -> None:
    """Mocks psycopg Connection and transaction to verify execution of FOR UPDATE select and update."""
    app_user_id = "user-1"
    existing_db_settings = {"release_video_seen": "v1.0.0", "preferences": {"theme": "dark"}}
    new_settings = {"release_video_seen": "v1.1.0", "preferences": {"notifications": True}}

    # Setup the psycopg mock connection/cursor tree
    mock_cursor = AsyncMock()
    mock_cursor.fetchone.return_value = (existing_db_settings,)

    mock_conn = MagicMock()
    mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn.__aexit__ = AsyncMock(return_value=False)
    
    mock_conn.cursor.return_value = MockAsyncContextManager(mock_cursor)
    mock_conn.transaction.return_value = MockAsyncContextManager(AsyncMock())

    with (
        patch("psycopg.AsyncConnection.connect", new=AsyncMock(return_value=mock_conn)),
        patch("dembrane.settings.get_settings") as mock_get_settings
    ):
        # Mock settings database url
        mock_get_settings.return_value.database.database_url = "postgresql+psycopg://user:pass@host/db"

        result = await update_user_settings_atomic(app_user_id, new_settings)

    # Verify return value of merged dict
    assert result == {
        "release_video_seen": "v1.1.0",
        "preferences": {
            "theme": "dark",
            "notifications": True
        }
    }

    # Verify correct query and parameter for FOR UPDATE row locking
    mock_cursor.execute.assert_any_call(
        "SELECT settings FROM app_user WHERE id = %s FOR UPDATE",
        (app_user_id,)
    )

    # Verify correct query and serialized payload for DB writeback
    mock_cursor.execute.assert_any_call(
        "UPDATE app_user SET settings = %s WHERE id = %s",
        (json.dumps(result), app_user_id)
    )


@pytest.mark.asyncio
async def test_update_user_settings_atomic_user_not_found() -> None:
    """Verifies that an HTTPException(404) is raised when app_user is missing."""
    mock_cursor = AsyncMock()
    mock_cursor.fetchone.return_value = None  # User not found

    mock_conn = MagicMock()
    mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn.__aexit__ = AsyncMock(return_value=False)
    
    mock_conn.cursor.return_value = MockAsyncContextManager(mock_cursor)
    mock_conn.transaction.return_value = MockAsyncContextManager(AsyncMock())

    with (
        patch("psycopg.AsyncConnection.connect", new=AsyncMock(return_value=mock_conn)),
        patch("dembrane.settings.get_settings") as mock_get_settings
    ):
        mock_get_settings.return_value.database.database_url = "postgresql+psycopg://user:pass@host/db"

        with pytest.raises(HTTPException) as exc_info:
            await update_user_settings_atomic("invalid-user", {"some_key": True})

        assert exc_info.value.status_code == 404
        assert "User not found" in exc_info.value.detail
