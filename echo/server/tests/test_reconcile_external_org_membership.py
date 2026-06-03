"""Tests for reconcile_external_membership_org_row (external-lockdown spec)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from dembrane.api.v2._invite_helpers import reconcile_external_membership_org_row

_ORG = "org-1"
_USER = "user-1"


def _mock(*, ws_roles: list[str], org_membership_ids: list[str]) -> AsyncMock:
    async def get_items(collection: str, _params: dict[str, Any]) -> list[dict[str, Any]]:
        if collection == "workspace":
            return [{"id": "ws-1"}]
        if collection == "workspace_membership":
            return [{"role": r} for r in ws_roles]
        if collection == "org_membership":
            return [{"id": i} for i in org_membership_ids]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=get_items)
    mock.update_item = AsyncMock(return_value={"data": {}})
    return mock


@pytest.mark.asyncio
async def test_soft_deletes_stale_org_membership_when_no_internal():
    mock = _mock(ws_roles=[], org_membership_ids=["om-1"])
    with patch("dembrane.api.v2._invite_helpers.async_directus", mock):
        await reconcile_external_membership_org_row(_ORG, _USER)
    mock.update_item.assert_awaited_once()
    args = mock.update_item.await_args.args
    assert args[0] == "org_membership"
    assert args[1] == "om-1"
    assert args[2].get("deleted_at") is not None


@pytest.mark.asyncio
async def test_rejects_when_user_has_internal_membership():
    mock = _mock(ws_roles=["member"], org_membership_ids=["om-1"])
    with patch("dembrane.api.v2._invite_helpers.async_directus", mock):
        with pytest.raises(HTTPException) as exc:
            await reconcile_external_membership_org_row(_ORG, _USER)
    assert exc.value.status_code == 400
    mock.update_item.assert_not_awaited()


@pytest.mark.asyncio
async def test_noop_when_no_org_membership():
    mock = _mock(ws_roles=[], org_membership_ids=[])
    with patch("dembrane.api.v2._invite_helpers.async_directus", mock):
        await reconcile_external_membership_org_row(_ORG, _USER)
    mock.update_item.assert_not_awaited()
