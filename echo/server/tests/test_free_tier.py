"""Tests for the shared free-tier gating module (PR1 foundation)."""

import pytest
from fastapi import HTTPException

from dembrane.free_tier import (
    FREE_TIER,
    FREE_TIER_MAX_CHATS,
    FREE_TIER_LIMIT_ERROR,
    FREE_TIER_MAX_REPORTS,
    FREE_TIER_MAX_WORKSPACES,
    FREE_TIER_UPGRADE_CTA_TIER,
    FREE_TIER_MAX_CHAT_USER_TURNS,
    FREE_TIER_MAX_UNLOCKED_CONVERSATIONS,
    is_free_tier,
    free_tier_limit_error,
)


class TestConstants:
    def test_limits_are_one_except_turns(self):
        assert FREE_TIER_MAX_UNLOCKED_CONVERSATIONS == 1
        assert FREE_TIER_MAX_CHATS == 1
        assert FREE_TIER_MAX_REPORTS == 1
        assert FREE_TIER_MAX_WORKSPACES == 1
        assert FREE_TIER_MAX_CHAT_USER_TURNS == 3

    def test_upgrade_cta_is_purchasable_tier(self):
        assert FREE_TIER_UPGRADE_CTA_TIER == "changemaker"


class TestIsFreeTier:
    def test_free_is_true(self):
        assert is_free_tier(FREE_TIER) is True

    @pytest.mark.parametrize("tier", ["innovator", "changemaker", "guardian"])
    def test_paid_is_false(self, tier):
        assert is_free_tier(tier) is False

    def test_none_is_false(self):
        assert is_free_tier(None) is False

    def test_unknown_is_false(self):
        assert is_free_tier("pilot") is False


class TestFreeTierLimitError:
    def test_returns_402_with_shared_body(self):
        exc = free_tier_limit_error("chats")
        assert isinstance(exc, HTTPException)
        assert exc.status_code == 402
        assert exc.detail == {
            "error": FREE_TIER_LIMIT_ERROR,
            "limit": "chats",
            "upgrade_cta_tier": FREE_TIER_UPGRADE_CTA_TIER,
        }

    def test_limit_is_passed_through(self):
        assert free_tier_limit_error("report").detail["limit"] == "report"


# ── async counters and oldest-resolvers (Task 2) ──────────────────────

from unittest.mock import AsyncMock, patch  # noqa: E402

from dembrane.free_tier import (  # noqa: E402
    count_org_workspaces,
    count_chat_user_turns,
    count_workspace_chats,
    count_workspace_reports,
    resolve_workspace_primary_chat_id,
    resolve_workspace_primary_report_id,
    resolve_workspace_unlocked_conversation_id,
)


def _mock_directus(handlers: dict):
    """AsyncMock for directus_async.async_directus. `handlers` maps a
    collection name to a callable(query_dict) -> return value."""
    mock = AsyncMock()

    async def _get_items(collection, params=None, *a, **k):
        fn = handlers.get(collection)
        return fn((params or {}).get("query", {})) if fn else []

    mock.get_items = AsyncMock(side_effect=_get_items)
    return mock


class TestWorkspaceProjectIds:
    @pytest.mark.asyncio
    async def test_returns_ids(self):
        mock = _mock_directus({"project": lambda _q: [{"id": "p1"}, {"id": "p2"}]})
        with patch("dembrane.directus_async.async_directus", mock):
            from dembrane.free_tier import _workspace_project_ids

            assert await _workspace_project_ids("w1") == ["p1", "p2"]

    @pytest.mark.asyncio
    async def test_no_projects(self):
        mock = _mock_directus({"project": lambda _q: []})
        with patch("dembrane.directus_async.async_directus", mock):
            from dembrane.free_tier import _workspace_project_ids

            assert await _workspace_project_ids("w1") == []


class TestUnlockedConversationId:
    @pytest.mark.asyncio
    async def test_oldest_conversation(self):
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "conversation": lambda _q: [{"id": "c-old"}],
            }
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await resolve_workspace_unlocked_conversation_id("w1") == "c-old"

    @pytest.mark.asyncio
    async def test_none_when_no_projects(self):
        mock = _mock_directus({"project": lambda _q: []})
        with patch("dembrane.directus_async.async_directus", mock):
            assert await resolve_workspace_unlocked_conversation_id("w1") is None

    @pytest.mark.asyncio
    async def test_none_when_no_conversations(self):
        mock = _mock_directus(
            {"project": lambda _q: [{"id": "p1"}], "conversation": lambda _q: []}
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await resolve_workspace_unlocked_conversation_id("w1") is None

    @pytest.mark.asyncio
    async def test_uses_passed_project_ids_without_fetching(self):
        # No "project" handler: if the helper tried to fetch project ids it
        # would get [] and return None. Passing project_ids must bypass that.
        mock = _mock_directus({"conversation": lambda _q: [{"id": "c-old"}]})
        with patch("dembrane.directus_async.async_directus", mock):
            result = await resolve_workspace_unlocked_conversation_id(
                "w1", project_ids=["p1", "p2"]
            )
        assert result == "c-old"


class TestCountWorkspaceChats:
    @pytest.mark.asyncio
    async def test_counts_via_aggregate(self):
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "project_chat": lambda _q: [{"count": {"id": 2}}],
            }
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_workspace_chats("w1") == 2

    @pytest.mark.asyncio
    async def test_zero_when_no_projects(self):
        mock = _mock_directus({"project": lambda _q: []})
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_workspace_chats("w1") == 0


class TestPrimaryChatId:
    @pytest.mark.asyncio
    async def test_oldest_chat(self):
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "project_chat": lambda _q: [{"id": "chat-old"}],
            }
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await resolve_workspace_primary_chat_id("w1") == "chat-old"


class TestCountChatUserTurns:
    @pytest.mark.asyncio
    async def test_counts_user_messages(self):
        mock = _mock_directus(
            {"project_chat_message": lambda _q: [{"count": {"id": 3}}]}
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_chat_user_turns("chat1") == 3

    @pytest.mark.asyncio
    async def test_zero_when_empty(self):
        mock = _mock_directus({"project_chat_message": lambda _q: []})
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_chat_user_turns("chat1") == 0


class TestCountWorkspaceReports:
    @pytest.mark.asyncio
    async def test_counts_reports(self):
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "project_report": lambda _q: [{"count": {"id": 1}}],
            }
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_workspace_reports("w1") == 1


class TestPrimaryReportId:
    @pytest.mark.asyncio
    async def test_oldest_report(self):
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "project_report": lambda _q: [{"id": "rep-old"}],
            }
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await resolve_workspace_primary_report_id("w1") == "rep-old"


class TestCountOrgWorkspaces:
    @pytest.mark.asyncio
    async def test_counts_workspaces(self):
        mock = _mock_directus({"workspace": lambda _q: [{"count": {"id": 1}}]})
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_org_workspaces("org1") == 1

    @pytest.mark.asyncio
    async def test_zero_when_empty(self):
        mock = _mock_directus({"workspace": lambda _q: []})
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_org_workspaces("org1") == 0


# ── build_free_tier_usage_block (Task 3) ──────────────────────────────

from dembrane.free_tier import build_free_tier_usage_block  # noqa: E402


class TestBuildFreeTierUsageBlock:
    def test_free_tier_active(self):
        block = build_free_tier_usage_block(
            tier="free",
            unlocked_conversation_id="c1",
            chats_used=1,
            primary_chat_id="chat1",
            reports_used=0,
            primary_report_id=None,
        )
        assert block == {
            "active": True,
            "unlocked_conversation_id": "c1",
            "chats_used": 1,
            "chats_limit": 1,
            "primary_chat_id": "chat1",
            "reports_used": 0,
            "reports_limit": 1,
            "primary_report_id": None,
        }

    def test_paid_tier_inactive(self):
        block = build_free_tier_usage_block(
            tier="changemaker",
            unlocked_conversation_id=None,
            chats_used=5,
            primary_chat_id="chat1",
            reports_used=3,
            primary_report_id="rep1",
        )
        assert block["active"] is False

    def test_none_tier_inactive(self):
        block = build_free_tier_usage_block(
            tier=None,
            unlocked_conversation_id=None,
            chats_used=0,
            primary_chat_id=None,
            reports_used=0,
            primary_report_id=None,
        )
        assert block["active"] is False
