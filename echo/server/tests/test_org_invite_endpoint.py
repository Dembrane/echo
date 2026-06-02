"""Tests for POST /v2/orgs/:id/invites — org-only invite endpoint (ADR 0004).

Covers the four invitee-state branches plus role-escalation, self-invite,
permission, and duplicate-pending guards.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.orgs import router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "du-admin-001"
_APP_USER_ID = "au-admin-001"
_APP_USER = {
    "id": _APP_USER_ID,
    "email": "admin@example.com",
    "display_name": "Org Admin",
}
_ORG_ID = "org-001"
_ORG_ROW = {"id": _ORG_ID, "name": "Acme Org", "deleted_at": None}


def _build_app(auth_user_id: str = _USER_ID) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=auth_user_id, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/orgs")
    return app


def _noop_rate_limiter() -> AsyncMock:
    rl = AsyncMock()
    rl.check = AsyncMock(return_value=None)
    return rl


@pytest.fixture(autouse=True)
def _patch_rate_limiter():
    with patch(
        "dembrane.api.v2.orgs._org_invite_rate_limiter", _noop_rate_limiter()
    ):
        yield


@pytest.fixture(autouse=True)
def _patch_email_enqueue():
    """Email enqueue stubbed to a no-op that reports success."""
    with patch("dembrane.api.v2.orgs._enqueue_invite_email", return_value=True):
        yield


def _make_directus_mock(
    *,
    caller_role: str = "admin",
    invitee_directus_user: dict[str, Any] | None = None,
    existing_org_membership: list[dict[str, Any]] | None = None,
    existing_pending_org_invite: list[dict[str, Any]] | None = None,
) -> AsyncMock:
    """Build an async_directus mock with branch-aware get_items/get_item/etc.

    The endpoint queries (in order):
      1. org_membership (caller role check via _require_org_role)
      2. app_user (caller's email for self-invite check)
      3. org (subject org row)
      4. directus_users (find invitee)
      5. resolve_app_user → app_user (only when invitee user exists)
      6. org_membership (invitee's existing membership)
      7. org_invite (existing pending)
    """
    mock = AsyncMock()
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: _ORG_ROW if col == "org" else None
    )

    call_state = {"org_membership_call": 0}

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "org_membership":
            # First call = _require_org_role for caller. Subsequent calls =
            # invitee's existing membership lookup.
            call_state["org_membership_call"] += 1
            if call_state["org_membership_call"] == 1:
                return [{"role": caller_role}]
            return existing_org_membership or []
        if collection == "app_user":
            # Self-invite probe.
            return [{"email": _APP_USER["email"]}]
        if collection == "org_invite":
            return existing_pending_org_invite or []
        if collection == "workspace_invite":
            return []
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)

    async def _fake_get_users(_params: dict) -> Any:
        return [invitee_directus_user] if invitee_directus_user else []

    mock.get_users = AsyncMock(side_effect=_fake_get_users)
    mock.create_item = AsyncMock(return_value={"data": {"id": "new-1"}})
    mock.update_item = AsyncMock(return_value={"data": {}})
    return mock


def _common_patches():
    """Patches shared across all happy-path tests."""
    return (
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
        patch("dembrane.notifications.emit_to_audience", new_callable=AsyncMock),
        patch(
            "dembrane.notifications.audience_organisation_admins",
            new_callable=AsyncMock,
            return_value=[],
        ),
    )


@pytest.mark.asyncio
async def test_invite_new_user_creates_org_invite_row():
    """No Directus user → org_invite row + invite email."""
    mock = _make_directus_mock()

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
        patch("dembrane.api.v2.orgs.resolve_app_user", return_value=None),
    ):
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                f"/v2/orgs/{_ORG_ID}/invites",
                json={"email": "newbie@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "invited"
    assert body["user_existed"] is False
    assert body["email_sent"] is True

    creates = [c.args for c in mock.create_item.call_args_list]
    collections_created = [c[0] for c in creates]
    assert "org_invite" in collections_created
    org_invite_payload = next(
        c[1] for c in creates if c[0] == "org_invite"
    )
    assert org_invite_payload["org_id"] == _ORG_ID
    assert org_invite_payload["email"] == "newbie@example.com"
    assert org_invite_payload["role"] == "member"


@pytest.mark.asyncio
async def test_invite_existing_user_not_in_org_creates_org_membership():
    """Existing Directus user with no org_membership → membership added,
    status='added'."""
    invitee_directus = {"id": "du-bob", "email": "bob@example.com"}
    invitee_app_user = {"id": "au-bob", "email": "bob@example.com"}

    mock = _make_directus_mock(invitee_directus_user=invitee_directus)

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.orgs.resolve_app_user", return_value=invitee_app_user
        ),
        patch("dembrane.notifications.emit_to_audience", new_callable=AsyncMock),
        patch(
            "dembrane.notifications.audience_organisation_admins",
            new_callable=AsyncMock,
            return_value=[],
        ),
    ):
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                f"/v2/orgs/{_ORG_ID}/invites",
                json={"email": "bob@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "added"
    assert body["user_existed"] is True

    om_creates = [
        c.args for c in mock.create_item.call_args_list if c.args[0] == "org_membership"
    ]
    assert len(om_creates) == 1
    payload = om_creates[0][1]
    assert payload["org_id"] == _ORG_ID
    assert payload["user_id"] == invitee_app_user["id"]
    assert payload["role"] == "member"


@pytest.mark.asyncio
async def test_invite_existing_member_is_idempotent_no_email():
    """User already actively in org → 200 already_member, no email enqueued."""
    invitee_directus = {"id": "du-carol", "email": "carol@example.com"}
    invitee_app_user = {"id": "au-carol", "email": "carol@example.com"}

    mock = _make_directus_mock(
        invitee_directus_user=invitee_directus,
        existing_org_membership=[
            {"id": "om-1", "role": "member", "deleted_at": None}
        ],
    )

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.orgs.resolve_app_user", return_value=invitee_app_user
        ),
        patch(
            "dembrane.api.v2.orgs._enqueue_invite_email", return_value=True
        ) as enqueue_mock,
    ):
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                f"/v2/orgs/{_ORG_ID}/invites",
                json={"email": "carol@example.com", "role": "admin"},
            )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "already_member"
    assert body["email_sent"] is False
    enqueue_mock.assert_not_called()


@pytest.mark.asyncio
async def test_invite_reactivates_soft_deleted_org_membership():
    """Soft-deleted org_membership → reactivate (clear deleted_at, set role)
    and notify."""
    invitee_directus = {"id": "du-dave", "email": "dave@example.com"}
    invitee_app_user = {"id": "au-dave", "email": "dave@example.com"}

    mock = _make_directus_mock(
        invitee_directus_user=invitee_directus,
        existing_org_membership=[
            {"id": "om-soft", "role": "member", "deleted_at": "2024-01-01T00:00:00Z"}
        ],
    )

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.orgs.resolve_app_user", return_value=invitee_app_user
        ),
    ):
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                f"/v2/orgs/{_ORG_ID}/invites",
                json={"email": "dave@example.com", "role": "admin"},
            )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "reactivated"

    updates = [c.args for c in mock.update_item.call_args_list]
    om_updates = [u for u in updates if u[0] == "org_membership"]
    assert len(om_updates) == 1
    _, om_id, payload = om_updates[0]
    assert om_id == "om-soft"
    assert payload["deleted_at"] is None
    assert payload["role"] == "admin"


@pytest.mark.asyncio
async def test_invite_rejects_role_escalation_above_caller_level():
    """Admin (level 3) cannot grant owner (level 4). 403."""
    mock = _make_directus_mock(caller_role="admin")

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                f"/v2/orgs/{_ORG_ID}/invites",
                json={"email": "claimer@example.com", "role": "owner"},
            )

    assert resp.status_code == 403
    assert "higher than your own" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_invite_rejects_non_admin_caller():
    """Non-admin org member cannot invite. 403 from _require_org_role."""
    mock = _make_directus_mock(caller_role="member")

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                f"/v2/orgs/{_ORG_ID}/invites",
                json={"email": "x@example.com", "role": "member"},
            )

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_invite_blocks_self_invite():
    """Inviting yourself is rejected before any state change."""
    mock = _make_directus_mock()

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                f"/v2/orgs/{_ORG_ID}/invites",
                json={"email": _APP_USER["email"], "role": "member"},
            )

    assert resp.status_code == 400
    assert "yourself" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_invite_is_idempotent_when_pending_invite_exists():
    """Pending org_invite already exists for (org, email) → 200 with
    status='already_invited' (ADR 0004). The modal's per-row status
    surface needs this to render gracefully instead of a global 409."""
    mock = _make_directus_mock(
        existing_pending_org_invite=[{"id": "pending-1"}],
    )

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
        patch("dembrane.api.v2.orgs.resolve_app_user", return_value=None),
    ):
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                f"/v2/orgs/{_ORG_ID}/invites",
                json={"email": "ghost@example.com", "role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "already_invited"
    assert body["email_sent"] is False
    # No new org_invite row should have been created on the idempotent path.
    create_calls = [
        c.args for c in mock.create_item.call_args_list if c.args[0] == "org_invite"
    ]
    assert not create_calls


@pytest.mark.asyncio
async def test_invite_rate_limit_returns_429():
    """Rate limiter raises → 429 propagated."""
    from fastapi import HTTPException

    failing_limiter = AsyncMock()
    failing_limiter.check = AsyncMock(
        side_effect=HTTPException(status_code=429, detail="Too many invites")
    )

    mock = _make_directus_mock()

    with (
        patch("dembrane.api.v2.orgs._org_invite_rate_limiter", failing_limiter),
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                f"/v2/orgs/{_ORG_ID}/invites",
                json={"email": "y@example.com", "role": "member"},
            )

    assert resp.status_code == 429
