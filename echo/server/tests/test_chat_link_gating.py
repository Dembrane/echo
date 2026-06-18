"""Tests for chat-link gating (slice 07).

Covers:
- is_conversation_locked() (shared with BFF via tier_capacity)
- _check_conversation_not_locked() raises 402 for locked conversations
- _resolve_workspace_tier() returns the correct tier
- select-all skips locked conversations
- auto-select filters out locked conversation IDs
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from dembrane.api.chat import (
    CONVERSATION_LOCKED_ERROR,
    _resolve_workspace_tier,
    _check_conversation_not_locked,
)
from dembrane.tier_capacity import is_conversation_locked

TIERS_OVERAGE = ["innovator", "changemaker", "guardian"]
TIERS_NO_OVERAGE = ["free", "pilot"]
ALL_TIERS = TIERS_NO_OVERAGE + TIERS_OVERAGE


def _chat_and_account(conversation: dict, tier: str):
    """Mocks for the two clients in the lock check: chat.async_directus serves
    conversation + project; directus_async serves the workspace's billing
    account (where tier now lives)."""
    mock_chat = AsyncMock()
    mock_chat.get_item = AsyncMock(side_effect=[conversation, {"id": "p1", "workspace_id": "w1"}])

    def _da_get_item(coll, _item_id, *_args, **_kwargs):
        if coll == "workspace":
            return {"id": "w1", "billing_account_id": "acc-1"}
        return {"id": "acc-1", "tier": tier}

    mock_da = AsyncMock()
    mock_da.get_item = AsyncMock(side_effect=_da_get_item)
    return mock_chat, mock_da


# ── is_conversation_locked (tier_capacity, shared with BFF) ────────


class TestIsConversationLockedChat:
    """Same formula as BFF: is_over_cap AND NOT tier_allows_overage."""

    @pytest.mark.parametrize("tier", ALL_TIERS)
    def test_not_over_cap_never_locked(self, tier: str) -> None:
        assert is_conversation_locked({"is_over_cap": False}, tier) is False

    @pytest.mark.parametrize("tier", TIERS_NO_OVERAGE)
    def test_over_cap_on_non_overage_tier(self, tier: str) -> None:
        assert is_conversation_locked({"is_over_cap": True}, tier) is True

    @pytest.mark.parametrize("tier", TIERS_OVERAGE)
    def test_over_cap_on_overage_tier(self, tier: str) -> None:
        assert is_conversation_locked({"is_over_cap": True}, tier) is False

    def test_none_tier(self) -> None:
        assert is_conversation_locked({"is_over_cap": True}, None) is False

    def test_missing_field(self) -> None:
        assert is_conversation_locked({}, "free") is False

    def test_none_value(self) -> None:
        assert is_conversation_locked({"is_over_cap": None}, "free") is False


# ── _resolve_workspace_tier ──────────────────────────────────────────


class TestResolveWorkspaceTier:
    @pytest.mark.asyncio
    async def test_resolves_tier(self) -> None:
        mock_chat = AsyncMock()
        mock_chat.get_item = AsyncMock(return_value={"id": "p1", "workspace_id": "w1"})

        def _da_get_item(coll, _item_id, *_args, **_kwargs):
            if coll == "workspace":
                return {"id": "w1", "billing_account_id": "acc-1"}
            return {"id": "acc-1", "tier": "changemaker"}

        mock_da = AsyncMock()
        mock_da.get_item = AsyncMock(side_effect=_da_get_item)
        with patch("dembrane.api.chat.async_directus", mock_chat), \
             patch("dembrane.directus_async.async_directus", mock_da):
            tier = await _resolve_workspace_tier("p1")
        assert tier == "changemaker"

    @pytest.mark.asyncio
    async def test_missing_project(self) -> None:
        mock_directus = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value=None)
        with patch("dembrane.api.chat.async_directus", mock_directus):
            tier = await _resolve_workspace_tier("bad")
        assert tier is None

    @pytest.mark.asyncio
    async def test_project_without_workspace(self) -> None:
        mock_directus = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value={"id": "p1"})
        with patch("dembrane.api.chat.async_directus", mock_directus):
            tier = await _resolve_workspace_tier("p1")
        assert tier is None

    @pytest.mark.asyncio
    async def test_missing_workspace(self) -> None:
        mock_chat = AsyncMock()
        mock_chat.get_item = AsyncMock(return_value={"id": "p1", "workspace_id": "w1"})
        mock_da = AsyncMock()
        mock_da.get_item = AsyncMock(return_value=None)  # workspace gone
        with patch("dembrane.api.chat.async_directus", mock_chat), \
             patch("dembrane.directus_async.async_directus", mock_da):
            tier = await _resolve_workspace_tier("p1")
        assert tier is None


# ── _check_conversation_not_locked ───────────────────────────────────


class TestCheckConversationNotLocked:
    @pytest.mark.asyncio
    async def test_not_over_cap_passes(self) -> None:
        mock_directus = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value={"id": "c1", "is_over_cap": False})
        with patch("dembrane.api.chat.async_directus", mock_directus):
            await _check_conversation_not_locked("c1", "p1")

    @pytest.mark.asyncio
    async def test_missing_conversation_passes(self) -> None:
        mock_directus = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value=None)
        with patch("dembrane.api.chat.async_directus", mock_directus):
            await _check_conversation_not_locked("bad", "p1")

    @pytest.mark.asyncio
    async def test_over_cap_on_free_raises_402(self) -> None:
        mock_chat, mock_da = _chat_and_account({"id": "c1", "is_over_cap": True}, "free")
        with patch("dembrane.api.chat.async_directus", mock_chat), \
             patch("dembrane.directus_async.async_directus", mock_da):
            with pytest.raises(HTTPException) as exc_info:
                await _check_conversation_not_locked("c1", "p1")
            assert exc_info.value.status_code == 402
            assert exc_info.value.detail["error"] == CONVERSATION_LOCKED_ERROR

    @pytest.mark.asyncio
    async def test_over_cap_on_pilot_raises_402(self) -> None:
        mock_chat, mock_da = _chat_and_account({"id": "c1", "is_over_cap": True}, "pilot")
        with patch("dembrane.api.chat.async_directus", mock_chat), \
             patch("dembrane.directus_async.async_directus", mock_da):
            with pytest.raises(HTTPException) as exc_info:
                await _check_conversation_not_locked("c1", "p1")
            assert exc_info.value.status_code == 402

    @pytest.mark.asyncio
    async def test_over_cap_on_changemaker_passes(self) -> None:
        mock_chat, mock_da = _chat_and_account({"id": "c1", "is_over_cap": True}, "changemaker")
        with patch("dembrane.api.chat.async_directus", mock_chat), \
             patch("dembrane.directus_async.async_directus", mock_da):
            await _check_conversation_not_locked("c1", "p1")

    @pytest.mark.asyncio
    async def test_over_cap_upgrade_unlocks(self) -> None:
        """ADR 0001: upgrading to a tier with overage unlocks locked conversations."""
        mock_chat, mock_da = _chat_and_account({"id": "c1", "is_over_cap": True}, "innovator")
        with patch("dembrane.api.chat.async_directus", mock_chat), \
             patch("dembrane.directus_async.async_directus", mock_da):
            await _check_conversation_not_locked("c1", "p1")

    @pytest.mark.asyncio
    async def test_pre_existing_link_unaffected(self) -> None:
        """Gate is at insert time only; this helper is called before insert.
        Pre-existing links are never checked — this test documents intent."""
        mock_directus = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value={"id": "c1", "is_over_cap": False})
        with patch("dembrane.api.chat.async_directus", mock_directus):
            await _check_conversation_not_locked("c1", "p1")


# ── select-all locked filtering ──────────────────────────────────────


class TestSelectAllLockedFiltering:
    """is_conversation_locked filters out locked conversations in select-all."""

    def test_locked_conversations_skipped_free(self) -> None:
        conversations = [
            {"id": "c1", "is_over_cap": False},
            {"id": "c2", "is_over_cap": True},
            {"id": "c3", "is_over_cap": True},
        ]
        tier = "free"
        non_locked = [c for c in conversations if not is_conversation_locked(c, tier)]
        assert len(non_locked) == 1
        assert non_locked[0]["id"] == "c1"

    def test_no_filtering_on_changemaker(self) -> None:
        conversations = [
            {"id": "c1", "is_over_cap": False},
            {"id": "c2", "is_over_cap": True},
        ]
        tier = "changemaker"
        non_locked = [c for c in conversations if not is_conversation_locked(c, tier)]
        assert len(non_locked) == 2

    def test_empty_conversations_list(self) -> None:
        conversations: list[dict] = []
        tier = "free"
        non_locked = [c for c in conversations if not is_conversation_locked(c, tier)]
        assert len(non_locked) == 0


# ── auto-select locked filtering ─────────────────────────────────────


class TestAutoSelectLockedFiltering:
    """Auto-select pickup path filters out locked conversation IDs."""

    def test_locked_ids_excluded(self) -> None:
        selected = ["c1", "c2", "c3"]
        locked_ids = {"c2"}
        existing = set()
        added = []

        for cid in selected:
            if cid in existing or cid in added or cid in locked_ids:
                continue
            added.append(cid)

        assert added == ["c1", "c3"]

    def test_no_locked_ids(self) -> None:
        selected = ["c1", "c2"]
        locked_ids: set[str] = set()
        existing = set()
        added = []

        for cid in selected:
            if cid in existing or cid in added or cid in locked_ids:
                continue
            added.append(cid)

        assert added == ["c1", "c2"]

    def test_all_locked(self) -> None:
        selected = ["c1", "c2"]
        locked_ids = {"c1", "c2"}
        existing = set()
        added = []

        for cid in selected:
            if cid in existing or cid in added or cid in locked_ids:
                continue
            added.append(cid)

        assert added == []
