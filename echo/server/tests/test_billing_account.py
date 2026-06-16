"""Tests for the billing_account resolver/helpers (Phase 1 split).

Covers:
- create_workspace_scoped_account: payload shape, optional fields, returns id.
- link_account_to_workspace: sets workspace_id.
- nested_billing_fields / billing_from_workspace: the join-on-read helpers.
- update_workspace_billing: writes commercial fields to the resolved account.
- resolve_workspace_tier: account is the only source; None when absent.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


class TestCreateWorkspaceScopedAccount:
    @pytest.mark.asyncio
    @patch("dembrane.billing_account.generate_uuid", return_value="acc-1")
    @patch("dembrane.directus_async.async_directus")
    async def test_minimal_payload(self, mock_directus, _uuid):
        from dembrane.billing_account import create_workspace_scoped_account

        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "acc-1"}})
        account_id = await create_workspace_scoped_account(tier="pilot")

        assert account_id == "acc-1"
        coll, payload = mock_directus.create_item.call_args.args
        assert coll == "billing_account"
        assert payload == {"id": "acc-1", "tier": "pilot", "payment_mode": "none"}

    @pytest.mark.asyncio
    @patch("dembrane.billing_account.generate_uuid", return_value="acc-2")
    @patch("dembrane.directus_async.async_directus")
    async def test_optional_fields_included(self, mock_directus, _uuid):
        from dembrane.billing_account import create_workspace_scoped_account

        mock_directus.create_item = AsyncMock()
        await create_workspace_scoped_account(
            tier="innovator",
            tier_expires_at="2026-12-31T00:00:00Z",
            type_discount="scholarship",
            percent_discount=15,
            created_by="user-1",
            label="Acme billing",
        )
        _, payload = mock_directus.create_item.call_args.args
        assert payload["tier_expires_at"] == "2026-12-31T00:00:00Z"
        assert payload["type_discount"] == "scholarship"
        assert payload["percent_discount"] == 15
        assert payload["created_by"] == "user-1"
        assert payload["label"] == "Acme billing"

    @pytest.mark.asyncio
    @patch("dembrane.billing_account.generate_uuid", return_value="acc-3")
    @patch("dembrane.directus_async.async_directus")
    async def test_zero_percent_discount_is_kept(self, mock_directus, _uuid):
        from dembrane.billing_account import create_workspace_scoped_account

        mock_directus.create_item = AsyncMock()
        await create_workspace_scoped_account(tier="free", percent_discount=0)
        _, payload = mock_directus.create_item.call_args.args
        assert payload["percent_discount"] == 0  # 0 is meaningful, not skipped


class TestLinkAccountToWorkspace:
    @pytest.mark.asyncio
    @patch("dembrane.directus_async.async_directus")
    async def test_sets_workspace_id(self, mock_directus):
        from dembrane.billing_account import link_account_to_workspace

        mock_directus.update_item = AsyncMock()
        await link_account_to_workspace("acc-1", "ws-1")
        coll, item_id, patch_data = mock_directus.update_item.call_args.args
        assert coll == "billing_account"
        assert item_id == "acc-1"
        assert patch_data == {"workspace_id": "ws-1"}


class TestNestedJoinHelpers:
    def test_nested_billing_fields_prefixes(self):
        from dembrane.billing_account import BILLING_FIELDS, nested_billing_fields

        fields = nested_billing_fields()
        assert fields == [f"billing_account_id.{f}" for f in BILLING_FIELDS]

    def test_billing_from_workspace_reads_joined_account(self):
        from dembrane.billing_account import billing_from_workspace

        ws = {"id": "ws-1", "billing_account_id": {"tier": "changemaker", "percent_discount": 20}}
        out = billing_from_workspace(ws)
        assert out["tier"] == "changemaker"
        assert out["percent_discount"] == 20

    def test_billing_from_workspace_empty_when_not_joined(self):
        from dembrane.billing_account import tier_from_workspace, billing_from_workspace

        # billing_account_id came back as a bare id string (not joined).
        ws = {"id": "ws-1", "billing_account_id": "acc-1"}
        assert billing_from_workspace(ws) == {}
        assert tier_from_workspace(ws) is None


class TestUpdateWorkspaceBilling:
    @pytest.mark.asyncio
    @patch("dembrane.directus_async.async_directus")
    async def test_writes_to_the_resolved_account(self, mock_directus):
        from dembrane.billing_account import update_workspace_billing

        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "billing_account_id": "acc-1"})
        mock_directus.update_item = AsyncMock()
        account_id = await update_workspace_billing("ws-1", {"tier": "free"})

        assert account_id == "acc-1"
        coll, item_id, patch_data = mock_directus.update_item.call_args.args
        assert coll == "billing_account"
        assert item_id == "acc-1"
        assert patch_data == {"tier": "free"}

    @pytest.mark.asyncio
    @patch("dembrane.directus_async.async_directus")
    async def test_noop_when_no_account(self, mock_directus):
        from dembrane.billing_account import update_workspace_billing

        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "billing_account_id": None})
        mock_directus.update_item = AsyncMock()
        assert await update_workspace_billing("ws-1", {"tier": "free"}) is None
        mock_directus.update_item.assert_not_called()


class TestResolveWorkspaceTier:
    @pytest.mark.asyncio
    @patch("dembrane.directus_async.async_directus")
    async def test_account_tier_wins(self, mock_directus):
        from dembrane.billing_account import resolve_workspace_tier

        async def fake_get_item(collection, _item_id, **_kwargs):
            if collection == "workspace":
                return {"id": "ws-1", "tier": "free", "billing_account_id": "acc-1"}
            return {"id": "acc-1", "tier": "changemaker"}

        mock_directus.get_item = AsyncMock(side_effect=fake_get_item)
        assert await resolve_workspace_tier("ws-1") == "changemaker"

    @pytest.mark.asyncio
    @patch("dembrane.directus_async.async_directus")
    async def test_none_when_no_account(self, mock_directus):
        from dembrane.billing_account import resolve_workspace_tier

        async def fake_get_item(collection, _item_id, **_kwargs):
            if collection == "workspace":
                return {"id": "ws-1", "billing_account_id": None}
            return None

        mock_directus.get_item = AsyncMock(side_effect=fake_get_item)
        # No authoritative workspace.tier any more: account is the only source.
        assert await resolve_workspace_tier("ws-1") is None

    @pytest.mark.asyncio
    @patch("dembrane.directus_async.async_directus")
    async def test_none_when_workspace_missing(self, mock_directus):
        from dembrane.billing_account import resolve_workspace_tier

        mock_directus.get_item = AsyncMock(return_value=None)
        assert await resolve_workspace_tier("ws-1") is None
