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
    is_free_tier,
    free_tier_limit_error,
)


class TestConstants:
    def test_limits_are_one_except_turns(self):
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


class TestCountWorkspaceChats:
    @pytest.mark.asyncio
    async def test_counts_only_chats_with_user_messages(self):
        # two chats exist; countDistinct reports one has a user message
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "project_chat": lambda _q: [{"id": "chat1"}, {"id": "chat2"}],
                "project_chat_message": lambda _q: [
                    {"countDistinct": {"project_chat_id": 1}}
                ],
            }
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_workspace_chats("w1") == 1

    @pytest.mark.asyncio
    async def test_zero_when_chat_is_empty(self):
        # an empty chat exists but has no user messages -> doesn't count
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "project_chat": lambda _q: [{"id": "chat1"}],
                "project_chat_message": lambda _q: [],
            }
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_workspace_chats("w1") == 0

    @pytest.mark.asyncio
    async def test_zero_when_no_chats(self):
        mock = _mock_directus(
            {"project": lambda _q: [{"id": "p1"}], "project_chat": lambda _q: []}
        )
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_workspace_chats("w1") == 0

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

    @pytest.mark.asyncio
    async def test_filters_by_billing_account_when_given(self):
        # When a pooled billing_account_id is passed, the count must be scoped
        # to it so separately-billed (workspace-scoped) client workspaces don't
        # consume the org's free-tier allowance.
        captured: dict = {}

        def _handler(q):
            captured["filter"] = q.get("filter")
            return [{"count": {"id": 1}}]

        mock = _mock_directus({"workspace": _handler})
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_org_workspaces("org1", billing_account_id="acc-1") == 1
        assert captured["filter"].get("billing_account_id") == {"_eq": "acc-1"}

    @pytest.mark.asyncio
    async def test_no_billing_account_filter_when_absent(self):
        captured: dict = {}

        def _handler(q):
            captured["filter"] = q.get("filter")
            return [{"count": {"id": 2}}]

        mock = _mock_directus({"workspace": _handler})
        with patch("dembrane.directus_async.async_directus", mock):
            assert await count_org_workspaces("org1") == 2
        assert "billing_account_id" not in captured["filter"]


# ── build_free_tier_usage_block (Task 3) ──────────────────────────────

from dembrane.free_tier import build_free_tier_usage_block  # noqa: E402


class TestBuildFreeTierUsageBlock:
    def test_free_tier_active(self):
        block = build_free_tier_usage_block(
            tier="free",
            chats_used=1,
            primary_chat_id="chat1",
            reports_used=0,
            primary_report_id=None,
        )
        assert block == {
            "active": True,
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
            chats_used=5,
            primary_chat_id="chat1",
            reports_used=3,
            primary_report_id="rep1",
        )
        assert block["active"] is False

    def test_none_tier_inactive(self):
        block = build_free_tier_usage_block(
            tier=None,
            chats_used=0,
            primary_chat_id=None,
            reports_used=0,
            primary_report_id=None,
        )
        assert block["active"] is False


# ── live over-cap gate (workspace / project) ──────────────────────────


class TestWorkspaceOverCapActive:
    @pytest.mark.asyncio
    async def test_paid_tier_short_circuits(self):
        # Paid tiers are never hour-capped; no directus/cache read needed.
        from dembrane.free_tier import workspace_over_cap_active

        assert await workspace_over_cap_active("w1", "changemaker") is False

    @pytest.mark.asyncio
    async def test_none_tier_false(self):
        from dembrane.free_tier import workspace_over_cap_active

        assert await workspace_over_cap_active("w1", None) is False

    @pytest.mark.asyncio
    async def test_free_over_cap_true_when_hours_exceed(self):
        # 2 hours of audio on Free (1-hour cap) -> over cap.
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "conversation": lambda _q: [{"duration": 3600}, {"duration": 3600}],
            }
        )
        with patch("dembrane.directus_async.async_directus", mock), patch(
            "dembrane.cache_utils.cache_get_json", AsyncMock(return_value=None)
        ), patch("dembrane.cache_utils.cache_set_json", AsyncMock()):
            from dembrane.free_tier import workspace_over_cap_active

            assert await workspace_over_cap_active("w1", "free") is True

    @pytest.mark.asyncio
    async def test_free_under_cap_false(self):
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "conversation": lambda _q: [{"duration": 600}],  # 10 min
            }
        )
        with patch("dembrane.directus_async.async_directus", mock), patch(
            "dembrane.cache_utils.cache_get_json", AsyncMock(return_value=None)
        ), patch("dembrane.cache_utils.cache_set_json", AsyncMock()):
            from dembrane.free_tier import workspace_over_cap_active

            assert await workspace_over_cap_active("w1", "free") is False

    @pytest.mark.asyncio
    async def test_cache_hit_skips_directus(self):
        mock = _mock_directus({})
        with patch("dembrane.directus_async.async_directus", mock), patch(
            "dembrane.cache_utils.cache_get_json", AsyncMock(return_value=True)
        ), patch("dembrane.cache_utils.cache_set_json", AsyncMock()):
            from dembrane.free_tier import workspace_over_cap_active

            assert await workspace_over_cap_active("w1", "free") is True
            mock.get_items.assert_not_called()


class TestResolveProjectGate:
    @pytest.mark.asyncio
    async def test_resolves_tier_and_over_cap(self):
        # Used by the agentic monitor path (only project_id known). Resolves the
        # tier through the workspace, then the live over-cap gate.
        mock = _mock_directus(
            {
                "project": lambda _q: [{"id": "p1"}],
                "conversation": lambda _q: [{"duration": 7200}],  # 2h -> over cap
            }
        )
        mock.get_item = AsyncMock(return_value={"id": "p1", "workspace_id": "w1"})
        with patch("dembrane.directus_async.async_directus", mock), patch(
            "dembrane.billing_account.resolve_workspace_tier",
            AsyncMock(return_value="free"),
        ), patch(
            "dembrane.cache_utils.cache_get_json", AsyncMock(return_value=None)
        ), patch("dembrane.cache_utils.cache_set_json", AsyncMock()):
            from dembrane.free_tier import resolve_project_gate

            tier, over_cap = await resolve_project_gate("p1")
            assert tier == "free"
            assert over_cap is True
