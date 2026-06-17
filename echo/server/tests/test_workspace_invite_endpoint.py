"""Tests for POST /v2/workspaces/:id/invite — workspace invite endpoint.

Covers the two ADR-0004 / issue-05 behaviors layered onto the existing
endpoint:

1. Idempotent re-invite — invitee already a member of this workspace →
   200 with status='already_member' and no email sent.
2. External-to-member promotion — invitee is role='external' in some
   other workspace of this org; inviting them to a different workspace
   as a non-external role creates the org_membership but leaves the
   existing external workspace_membership row byte-for-byte unchanged.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.invites import router
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "du-admin-001"
_APP_USER_ID = "au-admin-001"
_APP_USER = {
    "id": _APP_USER_ID,
    "email": "admin@example.com",
    "display_name": "WS Admin",
}
_ORG_ID = "org-001"
_WORKSPACE_ID = "ws-target"
_WORKSPACE_ROW = {
    "id": _WORKSPACE_ID,
    "name": "Target WS",
    "org_id": _ORG_ID,
    "tier": "pro",
    "deleted_at": None,
}


def _build_app(ctx: WorkspaceContext) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    async def _fake_ctx() -> WorkspaceContext:
        return ctx

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.dependency_overrides[get_workspace_context] = _fake_ctx
    app.include_router(router, prefix="/v2/workspaces")
    return app


def _make_ctx(role: str = "admin") -> WorkspaceContext:
    return WorkspaceContext(
        workspace_id=_WORKSPACE_ID,
        workspace=_WORKSPACE_ROW,
        app_user_id=_APP_USER_ID,
        role=role,
        custom_policies=[],
        source="direct",
    )


def _noop_rate_limiter() -> AsyncMock:
    rl = AsyncMock()
    rl.check = AsyncMock(return_value=None)
    return rl


@pytest.fixture(autouse=True)
def _patch_rate_limiter():
    with patch("dembrane.api.v2.invites._invite_rate_limiter", _noop_rate_limiter()):
        yield


@pytest.fixture(autouse=True)
def _patch_seat_capacity():
    """Seat cap is enforced by another module; bypass for these tests."""
    with patch("dembrane.api.v2.invites.assert_can_add_seat", new_callable=AsyncMock):
        yield


@pytest.fixture(autouse=True)
def _patch_notifications():
    """Notification emitters are tested elsewhere; no-op here."""
    with (
        patch("dembrane.notifications.emit", new_callable=AsyncMock),
        patch("dembrane.notifications.emit_to_audience", new_callable=AsyncMock),
        patch(
            "dembrane.notifications.audience_organisation_admins",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "dembrane.notifications.audience_workspace_admins",
            new_callable=AsyncMock,
            return_value=[],
        ),
    ):
        yield


@pytest.fixture(autouse=True)
def _patch_cache_invalidation():
    with patch(
        "dembrane.cache_utils.invalidate_workspace_and_org_usage",
        new_callable=AsyncMock,
    ):
        yield


def _build_directus_mock(
    *,
    invitee_directus_user: dict[str, Any] | None,
    existing_workspace_membership: list[dict[str, Any]] | None = None,
    existing_org_membership_for_invitee: list[dict[str, Any]] | None = None,
    existing_workspace_invite: list[dict[str, Any]] | None = None,
) -> AsyncMock:
    """Mock async_directus for the workspace invite codepath.

    Endpoint call order:
      1. get_items("app_user") — caller's email (self-invite probe)
      2. get_items("workspace_membership") — list memberships for target ws
      3. get_users — find invitee
      4. resolve_app_user → app_user (mocked separately)
      5. get_items("org_membership") — invitee's existing org membership
         (only when app_user exists and role != 'external')
      6. get_item("app_user") — fetch inviter display name
      ... plus any create_item / get_items('app_user') for inviter_name on
      the create-invite path.
    """
    mock = AsyncMock()

    workspace_membership_rows = existing_workspace_membership or []
    org_membership_rows = existing_org_membership_for_invitee or []
    workspace_invite_rows = (
        existing_workspace_invite if existing_workspace_invite is not None else []
    )

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "app_user":
            return [
                {
                    "id": _APP_USER_ID,
                    "email": _APP_USER["email"],
                    "display_name": _APP_USER["display_name"],
                }
            ]
        if collection == "workspace_membership":
            return workspace_membership_rows
        if collection == "org_membership":
            return org_membership_rows
        if collection == "workspace_invite":
            return workspace_invite_rows
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)

    async def _fake_get_users(_params: dict) -> Any:
        return [invitee_directus_user] if invitee_directus_user else []

    mock.get_users = AsyncMock(side_effect=_fake_get_users)

    async def _fake_get_item(collection: str, _id: str) -> Any:
        if collection == "app_user":
            return {"id": _APP_USER_ID, "display_name": _APP_USER["display_name"]}
        if collection == "org":
            return {"id": _ORG_ID, "name": "Acme"}
        return None

    mock.get_item = AsyncMock(side_effect=_fake_get_item)
    mock.create_item = AsyncMock(return_value={"data": {"id": "new-id"}})
    mock.update_item = AsyncMock(return_value={"data": {}})
    return mock


# ────────────────────────────────────────────────────────────────────
# 1. Idempotent re-invite
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reinvite_existing_member_returns_already_member_no_email():
    """Existing workspace member is re-invited → 200 already_member, no
    email, no create_item side effects."""
    invitee_directus = {"id": "du-bob", "email": "bob@example.com"}
    invitee_app_user = {"id": "au-bob", "email": "bob@example.com"}

    mock = _build_directus_mock(
        invitee_directus_user=invitee_directus,
        existing_workspace_membership=[
            {"user_id": "au-bob", "role": "member"},
        ],
    )

    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=invitee_app_user),
        patch("dembrane.api.v2.invites._enqueue_invite_email", return_value=True) as enqueue_mock,
    ):
        app = _build_app(_make_ctx())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/invite",
                json={"email": "bob@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "already_member"
    assert body["user_existed"] is True
    assert body["email_sent"] is False
    enqueue_mock.assert_not_called()
    # No state changes on the idempotent path.
    mock.create_item.assert_not_called()
    mock.update_item.assert_not_called()
    assert body.get("invite_url") is None


# ────────────────────────────────────────────────────────────────────
# 2. External-to-member promotion
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_external_in_other_workspace_promoted_to_member_in_target():
    """User is external in WS-A, invited to WS-B (this endpoint's target)
    as member → org_membership created, WS-B workspace_membership created,
    no touches to the existing external WS-A row."""
    invitee_directus = {"id": "du-ext", "email": "ext@example.com"}
    invitee_app_user = {"id": "au-ext", "email": "ext@example.com"}

    # User is external in WS-A; no membership in WS-B (target).
    # The endpoint only queries workspace_membership for the target WS,
    # so existing_workspace_membership=[] models "not a member of WS-B".
    # Note: the WS-A external row is never read or modified by this
    # endpoint — its presence is established by absence of org_membership
    # for this user, which is the ADR-0003 invariant.
    mock = _build_directus_mock(
        invitee_directus_user=invitee_directus,
        existing_workspace_membership=[],
        existing_org_membership_for_invitee=[],  # external ⟺ no org_membership
    )

    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=invitee_app_user),
    ):
        app = _build_app(_make_ctx())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/invite",
                json={"email": "ext@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "added"
    assert body["user_existed"] is True

    creates = [c.args for c in mock.create_item.call_args_list]
    collections = [c[0] for c in creates]
    # Both the org_membership (promotion) and the workspace_membership
    # (target WS access) are created.
    assert "org_membership" in collections
    assert "workspace_membership" in collections

    om_payload = next(c[1] for c in creates if c[0] == "org_membership")
    assert om_payload["org_id"] == _ORG_ID
    assert om_payload["user_id"] == "au-ext"
    assert om_payload["role"] == "member"

    wm_payload = next(c[1] for c in creates if c[0] == "workspace_membership")
    assert wm_payload["workspace_id"] == _WORKSPACE_ID
    assert wm_payload["user_id"] == "au-ext"
    assert wm_payload["role"] == "member"

    # No updates to existing rows. The WS-A external row would surface as
    # an update_item call if the endpoint touched it.
    mock.update_item.assert_not_called()


@pytest.mark.asyncio
async def test_external_to_member_promotion_never_updates_workspace_membership():
    """Promotion must NEVER issue update_item on workspace_membership; an
    existing external row in another workspace must survive unchanged
    (ADR-0003 invariant: role='external' ⟺ no org_membership)."""
    invitee_directus = {"id": "du-ext2", "email": "ext2@example.com"}
    invitee_app_user = {"id": "au-ext2", "email": "ext2@example.com"}

    mock = _build_directus_mock(
        invitee_directus_user=invitee_directus,
        existing_workspace_membership=[],
        existing_org_membership_for_invitee=[],
    )

    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=invitee_app_user),
    ):
        app = _build_app(_make_ctx())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/invite",
                json={"email": "ext2@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    updates = [c.args for c in mock.update_item.call_args_list]
    wm_updates = [u for u in updates if u[0] == "workspace_membership"]
    assert wm_updates == []


# ────────────────────────────────────────────────────────────────────
# Regression: net-new invite path (no app_user) still works
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_net_new_invite_still_creates_workspace_invite_row():
    """Sanity check that issue-05 changes didn't regress the net-new path."""
    mock = _build_directus_mock(invitee_directus_user=None)

    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=None),
        patch("dembrane.api.v2.invites._enqueue_invite_email", return_value=True),
    ):
        app = _build_app(_make_ctx())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/invite",
                json={"email": "newbie@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "invited"
    assert body["user_existed"] is False

    creates = [c.args for c in mock.create_item.call_args_list]
    collections = [c[0] for c in creates]
    assert "workspace_invite" in collections


# ────────────────────────────────────────────────────────────────────
# 4. Existing org member, not in this workspace (idempotency third state)
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_existing_org_member_added_to_workspace_silently():
    """ADR 0004 idempotency: invitee already has app_user + org_membership
    but is NOT in this workspace → create only the workspace_membership,
    do not duplicate the org_membership, send the 'you've been added'
    email. Pins the third branch of the idempotency table."""
    invitee_directus = {"id": "du-carol", "email": "carol@example.com"}
    invitee_app_user = {"id": "au-carol", "email": "carol@example.com"}

    mock = _build_directus_mock(
        invitee_directus_user=invitee_directus,
        existing_workspace_membership=[],
        # Already in the org — but not in this workspace.
        existing_org_membership_for_invitee=[
            {"user_id": "au-carol", "role": "member", "deleted_at": None}
        ],
    )

    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=invitee_app_user),
        patch("dembrane.api.v2.invites._enqueue_invite_email", return_value=True),
    ):
        app = _build_app(_make_ctx())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/invite",
                json={"email": "carol@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "added"
    assert body["user_existed"] is True

    create_collections = [c.args[0] for c in mock.create_item.call_args_list]
    # Workspace membership created.
    assert "workspace_membership" in create_collections
    # Org membership NOT touched — Carol's existing row stays as-is.
    assert "org_membership" not in create_collections


# ────────────────────────────────────────────────────────────────────
# Soft-delete: revoked invite must not block re-invite (retrofit lesson)
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_revoked_invite_does_not_block_reinvite():
    """A previously revoked workspace_invite (deleted_at set) must not
    cause `already_invited` on a re-invite. The filter at invites.py
    `existing_invites` lookup includes deleted_at:_null so the revoked
    row is excluded; the endpoint should proceed to create a fresh
    invite. Regression site: invites.py:321 in the retrofit checklist."""
    seen_filters: list[dict[str, Any]] = []

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "app_user":
            return [
                {
                    "id": _APP_USER_ID,
                    "email": _APP_USER["email"],
                    "display_name": _APP_USER["display_name"],
                }
            ]
        if collection == "workspace_membership":
            return []
        if collection == "workspace_invite":
            # Record the filter so we can assert deleted_at:_null is part
            # of the live-row predicate — the whole point of the filter
            # is to exclude revoked rows from this lookup.
            seen_filters.append(params.get("query", {}).get("filter", {}))
            # Mimic the DB: the revoked row exists, but the filter
            # excludes it, so the get_items result is empty.
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_users = AsyncMock(return_value=[])  # net-new path: no Directus user
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: (
            {"id": _APP_USER_ID, "display_name": "WS Admin"}
            if col == "app_user"
            else {"id": _ORG_ID, "name": "Acme"}
            if col == "org"
            else None
        )
    )
    mock.create_item = AsyncMock(return_value={"data": {"id": "new-id"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=None),
        patch("dembrane.api.v2.invites._enqueue_invite_email", return_value=True),
    ):
        app = _build_app(_make_ctx())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/invite",
                json={"email": "newbie@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # New invite was issued — NOT short-circuited to already_invited.
    assert body["status"] == "invited"

    # Pin the filter so a future refactor that drops deleted_at:_null
    # from the live-row predicate fails this test instead of silently
    # re-introducing the regression.
    live_filters = [f for f in seen_filters if "accepted_at" in f and "expires_at" in f]
    assert live_filters, "Expected a live-invite filter on workspace_invite"
    assert live_filters[0].get("deleted_at") == {"_null": True}, (
        "workspace_invite live-row filter must include deleted_at:_null "
        "so revoked rows don't block re-invites"
    )

    creates = [c.args[0] for c in mock.create_item.call_args_list]
    assert "workspace_invite" in creates


@pytest.mark.asyncio
async def test_new_invitee_returns_invite_url_with_valid_hash():
    """Inviting a brand-new email creates a workspace_invite and the
    response carries invite_url whose h matches compute_invite_hash."""
    from urllib.parse import parse_qs, urlparse

    from dembrane.api.v2.invites import compute_invite_hash

    mock = _build_directus_mock(invitee_directus_user=None)

    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=None),
        patch("dembrane.api.v2.invites._enqueue_invite_email", return_value=True),
    ):
        app = _build_app(_make_ctx())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/invite",
                json={"email": "new@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "invited"
    assert body["invite_url"]
    assert "/invite/accept" in body["invite_url"]

    created = next(
        c.args for c in mock.create_item.call_args_list if c.args[0] == "workspace_invite"
    )
    created_id = created[1]["id"]
    parsed = parse_qs(urlparse(body["invite_url"]).query)
    assert parsed["h"][0] == compute_invite_hash(created_id)
    assert parsed["email"][0] == "new@example.com"


# ────────────────────────────────────────────────────────────────────
# already_invited branch: existing pending invite returns invite_url
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_already_invited_returns_invite_url_with_valid_hash():
    """Inviting a brand-new email when a pending workspace_invite already
    exists returns status='already_invited' with an invite_url whose h
    param matches compute_invite_hash of the existing invite id."""
    from urllib.parse import parse_qs, urlparse

    from dembrane.api.v2.invites import compute_invite_hash

    _EXISTING_INVITE_ID = "existing-wi-1"

    mock = _build_directus_mock(
        invitee_directus_user=None,
        existing_workspace_invite=[{"id": _EXISTING_INVITE_ID}],
    )

    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=None),
        patch("dembrane.api.v2.invites._enqueue_invite_email", return_value=True),
    ):
        app = _build_app(_make_ctx())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/invite",
                json={"email": "pending@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "already_invited"
    assert body["invite_url"], "invite_url must be present on already_invited"
    assert "/invite/accept" in body["invite_url"]

    parsed = parse_qs(urlparse(body["invite_url"]).query)
    assert parsed["h"][0] == compute_invite_hash(_EXISTING_INVITE_ID)

    # No new workspace_invite row should be created on this path.
    creates = [c.args[0] for c in mock.create_item.call_args_list]
    assert "workspace_invite" not in creates
