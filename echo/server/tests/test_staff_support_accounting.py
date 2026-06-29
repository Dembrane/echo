"""staff_support memberships must stay invisible to membership accounting (ECHO-863).

Temporary dembrane staff support access grants a real per-user access path
(resolved via _get_direct_membership), but a `source='staff_support'` row must
never be counted as a workspace member: not for seats, billing, previews, or the
customer-facing member count. The chokepoint is get_effective_members, which
all of those reads funnel through; the only bypass is the member_count aggregate
in the workspaces list endpoint. Both must exclude staff_support.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest

from dembrane import inheritance


def _find_membership_query(get_items_mock: AsyncMock) -> dict:
    """Return the query dict from the workspace_membership get_items call."""
    for call in get_items_mock.await_args_list:
        collection = call.args[0] if call.args else None
        if collection == "workspace_membership":
            params = call.args[1] if len(call.args) > 1 else (call.kwargs.get("params") or {})
            return params.get("query", {})
    raise AssertionError("get_effective_members never queried workspace_membership")


@pytest.mark.asyncio
async def test_get_effective_members_excludes_staff_support():
    """The direct-membership read must filter out staff_support rows so they
    never reach the seat / preview / billing consumers."""
    directus = AsyncMock()
    # org_id=None short-circuits the derived-access block; we only care about the
    # direct workspace_membership query here.
    directus.get_item = AsyncMock(return_value={"id": "w-1", "org_id": None})
    directus.get_items = AsyncMock(return_value=[])

    with patch("dembrane.inheritance.async_directus", directus):
        await inheritance.get_effective_members("w-1")

    query = _find_membership_query(directus.get_items)
    assert query["filter"]["source"] == {"_neq": "staff_support"}, (
        "get_effective_members must exclude source='staff_support' so support "
        "access never counts as a member"
    )
    # Sanity: the existing direct-membership predicate is still intact.
    assert query["filter"]["deleted_at"] == {"_null": True}
    assert query["filter"]["workspace_id"] == {"_eq": "w-1"}


@pytest.mark.asyncio
async def test_workspace_settings_member_list_excludes_staff_support():
    """The customer-facing member list (GET /v2/workspaces/{id}/settings, which
    also backs /w/{id}/members) reads workspace_membership directly rather than
    via get_effective_members, so it needs its own staff_support exclusion to
    stay consistent with the seat count and avatar previews."""
    from httpx import AsyncClient, ASGITransport
    from fastapi import FastAPI

    from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
    from dembrane.api.dependency_auth import DirectusSession, require_directus_session
    from dembrane.api.v2.workspace_settings import router

    ws = {
        "id": "ws-1",
        "org_id": "",  # falsy → org fetch skipped, but satisfies the str response model
        "name": "WS",
        "visibility": "open_to_organisation",
    }
    ctx = WorkspaceContext(
        workspace_id="ws-1",
        workspace=ws,
        app_user_id="au-1",
        role="admin",
        custom_policies=[],
        source="direct",
    )

    directus = AsyncMock()
    directus.get_item = AsyncMock(return_value=None)
    directus.get_items = AsyncMock(return_value=[])
    directus.get_users = AsyncMock(return_value=[])

    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id="du-1", is_admin=False)

    async def _ctx() -> WorkspaceContext:
        return ctx

    app.dependency_overrides[require_directus_session] = _auth
    app.dependency_overrides[get_workspace_context] = _ctx
    app.include_router(router, prefix="/v2/workspaces")

    with patch("dembrane.api.v2.workspace_settings.async_directus", directus), patch(
        "dembrane.billing_account.resolve_workspace_billing",
        AsyncMock(return_value={}),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://t"
        ) as client:
            res = await client.get("/v2/workspaces/ws-1/settings")

    assert res.status_code == 200, res.text
    query = _find_membership_query(directus.get_items)
    assert query["filter"]["source"] == {"_neq": "staff_support"}, (
        "the workspace member list must hide staff_support sessions"
    )


# ── expiry is authoritative at access time ─────────────────────────────────


def test_membership_access_expired_helper():
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert inheritance.membership_access_expired(past) is True
    assert inheritance.membership_access_expired(future) is False
    # No expiry (normal memberships) never expires.
    assert inheritance.membership_access_expired(None) is False
    assert inheritance.membership_access_expired("") is False
    # Unparseable must not lock anyone out.
    assert inheritance.membership_access_expired("not-a-date") is False
    # A naive timestamp is read as UTC, not as a never-expiring value.
    naive_past = (
        (datetime.now(timezone.utc) - timedelta(hours=1)).replace(tzinfo=None).isoformat()
    )
    assert inheritance.membership_access_expired(naive_past) is True


@pytest.mark.asyncio
async def test_expired_staff_support_membership_does_not_grant_access():
    """An elapsed staff_support row must not resolve as a direct membership,
    even before the revoke sweep soft-deletes it."""
    expired = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    directus = AsyncMock()
    directus.get_items = AsyncMock(
        return_value=[
            {"id": "m1", "role": "admin", "source": "staff_support", "expires_at": expired}
        ]
    )
    with patch("dembrane.inheritance.async_directus", directus):
        row = await inheritance._get_direct_membership("w-1", "u-1")
    assert row is None


@pytest.mark.asyncio
async def test_live_staff_support_membership_grants_access():
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    directus = AsyncMock()
    directus.get_items = AsyncMock(
        return_value=[
            {"id": "m1", "role": "admin", "source": "staff_support", "expires_at": future}
        ]
    )
    with patch("dembrane.inheritance.async_directus", directus):
        row = await inheritance._get_direct_membership("w-1", "u-1")
    assert row is not None and row["id"] == "m1"


@pytest.mark.asyncio
async def test_membership_without_expiry_still_grants_access():
    """Regression: normal memberships carry no expires_at and must be unaffected."""
    directus = AsyncMock()
    directus.get_items = AsyncMock(
        return_value=[{"id": "m1", "role": "member", "source": "direct"}]
    )
    with patch("dembrane.inheritance.async_directus", directus):
        row = await inheritance._get_direct_membership("w-1", "u-1")
    assert row is not None and row["id"] == "m1"
