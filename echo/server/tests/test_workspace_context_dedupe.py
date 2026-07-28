"""get_workspace_context must fetch the workspace exactly once."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from dembrane import inheritance as inh, billing_account as ba
from dembrane.api.v2 import middleware as mw

WS = {"id": "ws-1", "org_id": "org-1", "visibility": "private", "settings": {},
      "billing_account_id": "acc-1", "deleted_at": None}


@pytest.mark.asyncio
async def test_resolve_workspace_billing_skips_fetch_with_prefetched_row():
    get_item = AsyncMock(return_value={"tier": "pioneer", "org_id": "org-1"})
    with patch.object(ba.directus_async.async_directus, "get_item", new=get_item):
        out = await ba.resolve_workspace_billing("ws-1", workspace=WS)
    # only the billing_account fetch remains
    assert get_item.await_count == 1
    assert get_item.await_args.args[0] == "billing_account"
    assert out["tier"] == "pioneer" and out["org_scoped"] is True


@pytest.mark.asyncio
async def test_resolve_workspace_access_direct_row_carries_policies():
    direct = {"role": "member", "custom_policies": ["extra:policy"]}
    with patch.object(inh, "_get_direct_membership", new=AsyncMock(return_value=direct)):
        out = await inh.resolve_workspace_access(WS, "u1")
    assert out == ("member", "direct", direct)


@pytest.mark.asyncio
async def test_context_single_workspace_fetch_and_fields():
    ws_fetches = []

    async def _get_item(collection, item_id):
        if collection == "workspace":
            ws_fetches.append(item_id)
            return dict(WS)
        raise AssertionError(collection)

    direct = {"role": "member", "custom_policies": ["a:b"]}
    with (
        patch.object(mw, "resolve_app_user", new=AsyncMock(return_value={"id": "au-1"})),
        patch.object(mw.async_directus, "get_item", new=AsyncMock(side_effect=_get_item)),
        patch.object(ba, "resolve_workspace_billing", new=AsyncMock(return_value={"tier": "free"})),
        patch.object(inh, "_get_direct_membership", new=AsyncMock(return_value=direct)),
    ):
        ctx = await mw.get_workspace_context("ws-1", type("A", (), {"user_id": "du-1"})())

    assert ws_fetches == ["ws-1"]
    assert ctx.role == "member" and ctx.source == "direct"
    assert ctx.custom_policies == ["a:b"]
    assert ctx.workspace["tier"] == "free"


@pytest.mark.asyncio
async def test_context_403_when_no_access():
    with (
        patch.object(mw, "resolve_app_user", new=AsyncMock(return_value={"id": "au-1"})),
        patch.object(mw.async_directus, "get_item", new=AsyncMock(return_value=dict(WS))),
        patch.object(ba, "resolve_workspace_billing", new=AsyncMock(return_value={})),
        patch.object(inh, "_get_direct_membership", new=AsyncMock(return_value=None)),
        patch.object(inh, "_get_org_role", new=AsyncMock(return_value=None)),
    ):
        with pytest.raises(HTTPException) as exc:
            await mw.get_workspace_context("ws-1", type("A", (), {"user_id": "du-1"})())
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_resolve_workspace_access_denies_deleted_workspace():
    """Defense in depth: a soft-deleted row resolves to None before any query."""
    membership_mock = AsyncMock()
    deleted = {**WS, "deleted_at": "2026-07-01T00:00:00+00:00"}
    with patch.object(inh, "_get_direct_membership", new=membership_mock):
        assert await inh.resolve_workspace_access(deleted, "u1") is None
    membership_mock.assert_not_awaited()
