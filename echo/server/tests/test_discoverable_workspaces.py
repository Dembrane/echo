"""Tests for GET /v2/orgs/:id/discoverable-workspaces.

ADR 0004 issue 03: the discovery list powers the Org Home page. Two
shapes matter for these tests:
  - member_count is populated from a per-workspace aggregate so the row
    can render "12 members" alongside the Request access button.
  - Private workspaces stay hidden for org members (not admins); pending
    requests surface as action='pending' so the button can disable.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.dependency_auth import DirectusSession, require_directus_session
from dembrane.api.v2.access_requests import discover_router

_USER_ID = "du-member-001"
_APP_USER_ID = "au-member-001"
_APP_USER = {"id": _APP_USER_ID, "email": "user@example.com", "display_name": "Org Member"}
_ORG_ID = "org-001"
_WS_OPEN_A = {"id": "ws-open-a", "name": "WS-A", "visibility": "open_to_organisation"}
_WS_OPEN_B = {"id": "ws-open-b", "name": "WS-B", "visibility": "open_to_organisation"}
_WS_PRIVATE = {"id": "ws-priv", "name": "WS-Private", "visibility": "private"}


def _build_app() -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(discover_router, prefix="/v2/orgs")
    return app


def _make_directus_mock(
    *,
    caller_role: str | None,
    workspaces: list[dict[str, Any]],
    existing_direct_ws_ids: list[str] | None = None,
    pending_request_ws_ids: list[str] | None = None,
    member_counts_by_ws: dict[str, int] | None = None,
) -> AsyncMock:
    """Branch-aware async_directus mock.

    Endpoint calls in order:
      1. org_membership (role lookup via _org_role)
      2. workspace (filtered list)
      3. workspace_membership (caller's direct rows)
      4. access_request (caller's pending requests; non-admin only)
      5. workspace_membership (grouped aggregate for member_count)
    """
    existing = set(existing_direct_ws_ids or [])
    pending = set(pending_request_ws_ids or [])
    counts = member_counts_by_ws or {}

    mock = AsyncMock()

    org_membership_calls = {"n": 0}

    async def get_items(collection: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        if collection == "org_membership":
            org_membership_calls["n"] += 1
            return [{"role": caller_role}] if caller_role else []
        if collection == "workspace":
            return list(workspaces)
        if collection == "workspace_membership":
            agg = (params.get("query") or {}).get("aggregate")
            if agg:
                # Grouped member_count aggregate
                return [{"workspace_id": wid, "count": {"id": cnt}} for wid, cnt in counts.items()]
            # Caller's direct rows
            return [{"workspace_id": wid} for wid in existing]
        if collection == "access_request":
            return [{"id": f"req-{wid}", "workspace_id": wid} for wid in pending]
        return []

    mock.get_items = AsyncMock(side_effect=get_items)
    return mock


@pytest.fixture(autouse=True)
def _default_not_external():
    with patch(
        "dembrane.api.v2.access_requests.is_org_external_only",
        AsyncMock(return_value=False),
    ):
        yield


@pytest.mark.asyncio
async def test_member_only_sees_open_workspaces_with_member_counts():
    """Org member: private hidden, open workspaces return member_count."""
    mock = _make_directus_mock(
        caller_role="member",
        workspaces=[_WS_OPEN_A, _WS_OPEN_B],
        member_counts_by_ws={"ws-open-a": 7, "ws-open-b": 12},
    )

    with (
        patch("dembrane.api.v2.access_requests.async_directus", mock),
        patch(
            "dembrane.api.v2.access_requests.get_app_user_or_raise",
            AsyncMock(return_value=_APP_USER),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/discoverable-workspaces")
    assert res.status_code == 200
    payload = res.json()
    by_id = {w["id"]: w for w in payload["workspaces"]}
    assert by_id["ws-open-a"]["member_count"] == 7
    assert by_id["ws-open-a"]["action"] == "request-access"
    assert by_id["ws-open-b"]["member_count"] == 12
    assert by_id["ws-open-b"]["action"] == "request-access"


@pytest.mark.asyncio
async def test_pending_request_returns_action_pending():
    """A workspace with a pending access_request is surfaced as action='pending'."""
    mock = _make_directus_mock(
        caller_role="member",
        workspaces=[_WS_OPEN_A],
        pending_request_ws_ids=["ws-open-a"],
        member_counts_by_ws={"ws-open-a": 3},
    )

    with (
        patch("dembrane.api.v2.access_requests.async_directus", mock),
        patch(
            "dembrane.api.v2.access_requests.get_app_user_or_raise",
            AsyncMock(return_value=_APP_USER),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/discoverable-workspaces")
    assert res.status_code == 200
    workspaces = res.json()["workspaces"]
    assert len(workspaces) == 1
    assert workspaces[0]["action"] == "pending"
    assert workspaces[0]["pending_request_id"] == "req-ws-open-a"
    assert workspaces[0]["member_count"] == 3


@pytest.mark.asyncio
async def test_existing_member_returns_action_member():
    """Workspaces the user already belongs to surface as action='member'."""
    mock = _make_directus_mock(
        caller_role="member",
        workspaces=[_WS_OPEN_A, _WS_OPEN_B],
        existing_direct_ws_ids=["ws-open-a"],
        member_counts_by_ws={"ws-open-a": 5, "ws-open-b": 9},
    )

    with (
        patch("dembrane.api.v2.access_requests.async_directus", mock),
        patch(
            "dembrane.api.v2.access_requests.get_app_user_or_raise",
            AsyncMock(return_value=_APP_USER),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/discoverable-workspaces")
    assert res.status_code == 200
    by_id = {w["id"]: w for w in res.json()["workspaces"]}
    assert by_id["ws-open-a"]["action"] == "member"
    assert by_id["ws-open-b"]["action"] == "request-access"


@pytest.mark.asyncio
async def test_non_member_gets_403():
    """Users without an org_membership row can't enumerate the org."""
    mock = _make_directus_mock(
        caller_role=None,
        workspaces=[_WS_OPEN_A],
    )

    with (
        patch("dembrane.api.v2.access_requests.async_directus", mock),
        patch(
            "dembrane.api.v2.access_requests.get_app_user_or_raise",
            AsyncMock(return_value=_APP_USER),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/discoverable-workspaces")
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_org_admin_sees_all_workspaces_with_action_join():
    """Org admins see EVERY workspace (open + private) with action='join'
    instead of 'request-access'. Pins the admin-branch divergence the
    audit flagged as missing test coverage."""
    mock = _make_directus_mock(
        caller_role="admin",
        workspaces=[_WS_OPEN_A, _WS_PRIVATE],
        member_counts_by_ws={"ws-open-a": 2, "ws-priv": 1},
    )

    with (
        patch("dembrane.api.v2.access_requests.async_directus", mock),
        patch(
            "dembrane.api.v2.access_requests.get_app_user_or_raise",
            AsyncMock(return_value=_APP_USER),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/discoverable-workspaces")

    assert res.status_code == 200
    by_id = {w["id"]: w for w in res.json()["workspaces"]}
    # Private workspace surfaces for admins (not for members).
    assert "ws-priv" in by_id
    # All non-member rows should be 'join' for admins, not 'request-access'.
    assert by_id["ws-open-a"]["action"] == "join"
    assert by_id["ws-priv"]["action"] == "join"


@pytest.mark.asyncio
async def test_workspace_query_filters_deleted_tier_and_for_member_filters_visibility():
    """Pins three filters: deleted_at:_null, tier:_neq:free, and (non-admin)
    visibility:_eq:open_to_organisation — the positive match prevents
    NULL-visibility rows from surfacing a CTA that submit 404s on."""
    mock = _make_directus_mock(
        caller_role="member",
        workspaces=[],
    )

    with (
        patch("dembrane.api.v2.access_requests.async_directus", mock),
        patch(
            "dembrane.api.v2.access_requests.get_app_user_or_raise",
            AsyncMock(return_value=_APP_USER),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/discoverable-workspaces")

    assert res.status_code == 200

    workspace_calls = [
        c for c in mock.get_items.call_args_list if c.args[0] == "workspace"
    ]
    assert workspace_calls, "Expected a get_items('workspace', ...) call"
    filt = workspace_calls[0].args[1].get("query", {}).get("filter", {})
    assert filt.get("deleted_at") == {"_null": True}, (
        "workspace query must exclude deleted rows"
    )
    assert filt.get("tier") == {"_neq": "free"}, (
        "workspace query must exclude free-tier (personal) workspaces from discovery"
    )
    assert filt.get("visibility") == {"_eq": "open_to_organisation"}, (
        "non-admin caller must positive-match open_to_organisation; "
        "_neq:private would surface NULL-visibility rows that the submit endpoint 404s on"
    )


@pytest.mark.asyncio
async def test_external_only_caller_gets_empty_discovery():
    """A member-role caller who is external-only (stale org_membership) sees nothing."""
    mock = _make_directus_mock(
        caller_role="member",
        workspaces=[_WS_OPEN_A, _WS_OPEN_B],
        member_counts_by_ws={"ws-open-a": 4, "ws-open-b": 8},
    )

    with (
        patch("dembrane.api.v2.access_requests.async_directus", mock),
        patch(
            "dembrane.api.v2.access_requests.get_app_user_or_raise",
            AsyncMock(return_value=_APP_USER),
        ),
        patch(
            "dembrane.api.v2.access_requests.is_org_external_only",
            AsyncMock(return_value=True),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/discoverable-workspaces")
    assert res.status_code == 200
    assert res.json()["workspaces"] == []
