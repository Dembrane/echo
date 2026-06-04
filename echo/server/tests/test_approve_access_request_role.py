"""Tests for the workspace role granted by approve_access_request.

Matrix v1.1 §4/§5: a biller is finance-visibility only. When their workspace
access request is approved they must be granted the workspace 'billing' role
(finance-only preset), NOT 'member' (operational access to projects +
conversations). Biller-ness comes from inheritance.is_org_billing_only:
org role 'billing', or workspace-scoped billers (only 'billing' workspace
roles in the org). Everyone else still gets 'member'.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.dependency_auth import DirectusSession
from dembrane.api.v2.access_requests import approve_access_request

_ACTOR_DU = "du-actor"
_ACTOR_APP = {"id": "actor-1", "email": "a@example.com", "display_name": "A"}
_ORG_ID = "org-1"
_WS_ID = "ws-1"
_REQUESTER_ID = "requester-1"
_WS = {"id": _WS_ID, "org_id": _ORG_ID, "visibility": "open_to_organisation", "tier": "pioneer", "name": "WS"}


def _mock() -> AsyncMock:
    async def get_items(collection: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        filt = params.get("query", {}).get("filter", {})
        if collection == "org_membership":
            # Actor authorization (_require_can_action_requests) filters on role.
            if "role" in filt:
                return [{"role": "admin"}]
            return []
        if collection == "workspace_membership":
            # No direct rows for either actor or requester.
            return []
        if collection == "access_request":
            return [
                {
                    "id": "req-1",
                    "workspace_id": _WS_ID,
                    "user_id": _REQUESTER_ID,
                    "status": "pending",
                }
            ]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=get_items)
    mock.get_item = AsyncMock(return_value=dict(_WS))
    mock.create_item = AsyncMock(return_value={"data": {"id": "wm-1"}})
    mock.update_item = AsyncMock(return_value={"data": {}})
    return mock


async def _approve(*, requester_is_biller: bool) -> str:
    """Run approve and return the workspace_membership role that was created."""
    mock = _mock()
    biller_mock = AsyncMock(return_value=requester_is_biller)
    with (
        patch("dembrane.api.v2.access_requests.async_directus", mock),
        patch(
            "dembrane.api.v2.access_requests.get_app_user_or_raise",
            AsyncMock(return_value=_ACTOR_APP),
        ),
        patch(
            "dembrane.api.v2.access_requests.assert_can_add_seat", AsyncMock()
        ),
        patch(
            "dembrane.api.v2.access_requests.is_org_billing_only", biller_mock
        ),
        patch(
            "dembrane.cache_utils.invalidate_workspace_and_org_usage", AsyncMock()
        ),
        patch("dembrane.notifications.emit", AsyncMock()),
    ):
        auth = DirectusSession(user_id=_ACTOR_DU, is_admin=False)
        await approve_access_request(_WS_ID, "req-1", auth)

    # The predicate must be evaluated for the REQUESTER in the workspace's org.
    biller_mock.assert_awaited_once_with(_ORG_ID, _REQUESTER_ID)

    membership_calls = [
        c for c in mock.create_item.call_args_list if c[0][0] == "workspace_membership"
    ]
    assert membership_calls, "expected a workspace_membership to be created"
    return membership_calls[0][0][1]["role"]


@pytest.mark.asyncio
async def test_non_biller_requester_granted_member_role():
    assert await _approve(requester_is_biller=False) == "member"


@pytest.mark.asyncio
async def test_biller_requester_granted_billing_role():
    assert await _approve(requester_is_biller=True) == "billing"
