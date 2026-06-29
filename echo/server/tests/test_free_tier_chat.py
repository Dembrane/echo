"""Free-tier chat gate: resolve_project_tier + conversation_is_locked helper."""

import os

os.environ.setdefault("DIRECTUS_SECRET", "t")
os.environ.setdefault("DIRECTUS_TOKEN", "t")
os.environ.setdefault("DIRECTUS_BASE_URL", "http://l")
os.environ.setdefault("DATABASE_URL", "postgresql://u:p@l:5432/d")
os.environ.setdefault("REDIS_URL", "redis://l:6379/0")

from unittest.mock import AsyncMock, patch  # noqa: E402

import pytest  # noqa: E402

from dembrane.free_tier import (  # noqa: E402
    resolve_project_tier,
    conversation_is_locked,
)


class TestConversationIsLocked:
    def test_free_over_cap_locked(self):
        assert conversation_is_locked({"id": "c1", "is_over_cap": True}, "free") is True

    def test_free_under_cap_unlocked(self):
        assert conversation_is_locked({"id": "c2", "is_over_cap": False}, "free") is False

    def test_paid_over_cap_unlocked(self):
        # paid tiers have unlimited hours; the over-cap stamp never locks them
        assert (
            conversation_is_locked({"id": "c2", "is_over_cap": True}, "changemaker")
            is False
        )

    def test_none_tier_unlocked(self):
        assert (
            conversation_is_locked({"id": "c2", "is_over_cap": True}, None) is False
        )


def _mock_directus_project(workspace_id):
    mock = AsyncMock()

    async def _get_item(collection, item_id, *a, **k):
        if collection == "project":
            return {"id": item_id, "workspace_id": workspace_id} if workspace_id else {"id": item_id}
        return None

    mock.get_item = AsyncMock(side_effect=_get_item)
    return mock


class TestResolveProjectTier:
    @pytest.mark.asyncio
    async def test_resolves_via_workspace(self):
        mock = _mock_directus_project("w1")
        with patch("dembrane.directus_async.async_directus", mock), patch(
            "dembrane.billing_account.resolve_workspace_tier",
            AsyncMock(return_value="free"),
        ):
            assert await resolve_project_tier("p1") == "free"

    @pytest.mark.asyncio
    async def test_none_when_no_workspace(self):
        mock = _mock_directus_project(None)
        with patch("dembrane.directus_async.async_directus", mock):
            assert await resolve_project_tier("p1") is None

    @pytest.mark.asyncio
    async def test_none_for_empty_project_id(self):
        assert await resolve_project_tier("") is None
