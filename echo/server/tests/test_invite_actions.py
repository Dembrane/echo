"""Tests for the unified resend/revoke endpoints (ADR 0004 issue 4):
POST   /v2/invites/:id/resend
DELETE /v2/invites/:id
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException

from dembrane.api.dependency_auth import DirectusSession, require_directus_session
from dembrane.api.v2.invite_actions import router

_USER_ID = "du-admin-001"
_APP_USER_ID = "au-admin-001"
_APP_USER = {"id": _APP_USER_ID, "email": "admin@example.com", "display_name": "Org Admin"}
_OTHER_USER_ID = "au-other"
_OTHER_USER = {"id": _OTHER_USER_ID, "email": "other@example.com", "display_name": "Other"}
_ORG_ID = "org-001"
_ORG_ROW = {"id": _ORG_ID, "name": "Acme", "deleted_at": None}
_WS_ID = "ws-001"
_WS_ROW = {"id": _WS_ID, "name": "Workspace One", "org_id": _ORG_ID, "deleted_at": None}


def _build_app(auth_user_id: str = _USER_ID) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=auth_user_id, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/invites")
    return app


def _noop_rate_limiter() -> AsyncMock:
    rl = AsyncMock()
    rl.check = AsyncMock(return_value=None)
    return rl


@pytest.fixture(autouse=True)
def _patch_rate_limiter():
    with patch("dembrane.api.v2.invite_actions._resend_rate_limiter", _noop_rate_limiter()):
        yield


@pytest.fixture(autouse=True)
def _patch_email_enqueue():
    with patch("dembrane.api.v2.invite_actions._enqueue_invite_email", return_value=True):
        yield


def _make_directus_mock(
    *,
    org_invite_row: dict | None = None,
    workspace_invite_row: dict | None = None,
    caller_is_admin: bool = True,
    caller_is_member: bool | None = None,
) -> AsyncMock:
    """Build the async_directus mock.

    Pass exactly one of org_invite_row / workspace_invite_row to simulate
    "invite exists in this table"; the other lookup returns no rows.

    caller_is_admin: simulates the org admin/owner check used to gate
    resend/revoke for non-inviters.

    caller_is_member: simulates the live-org-membership check used to
    re-validate the inviter path (a former admin who left the org no
    longer counts as the inviter for permission purposes). Defaults to
    `caller_is_admin` because every admin is also a member; pass False
    explicitly to simulate a removed user.

    The implementation uses filter-based `get_items` for the invite
    lookups (to dodge Directus's FORBIDDEN-on-missing probe trap), so the
    mock must serve those queries — NOT `get_item`. Earlier versions of
    this fixture stubbed `get_item` and silently returned `[]` from
    `get_items`, masking every positive test case as a 404.
    """
    mock = AsyncMock()
    member_flag = caller_is_admin if caller_is_member is None else caller_is_member

    async def _fake_get_item(collection: str, _id: str) -> Any:
        # Used for org/workspace dereferences and app_user lookups; the
        # invite tables themselves go through get_items.
        if collection == "workspace":
            return _WS_ROW
        if collection == "org":
            return _ORG_ROW
        if collection == "app_user":
            return _APP_USER
        return None

    mock.get_item = AsyncMock(side_effect=_fake_get_item)

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "org_invite":
            return [org_invite_row] if org_invite_row is not None else []
        if collection == "workspace_invite":
            return [workspace_invite_row] if workspace_invite_row is not None else []
        if collection == "org_membership":
            # Two distinct probes hit this collection:
            #   - _user_is_org_admin: filter.role._in = [admin, owner]
            #   - _user_is_org_member: no role filter
            filter_ = params.get("query", {}).get("filter", {})
            role_filter = filter_.get("role")
            if role_filter and "_in" in role_filter:
                return [{"role": "admin"}] if caller_is_admin else []
            return [{"id": "om-1"}] if member_flag else []
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.update_item = AsyncMock(return_value={"data": {}})
    return mock


def _org_invite(invited_by: str = _APP_USER_ID) -> dict:
    return {
        "id": "oi-1",
        "org_id": _ORG_ID,
        "email": "newuser@example.com",
        "role": "member",
        "invited_by": invited_by,
        "expires_at": "2026-05-08T10:00:00Z",
        "accepted_at": None,
        "deleted_at": None,
        "created_at": "2026-05-01T10:00:00Z",
    }


def _workspace_invite(invited_by: str = _APP_USER_ID) -> dict:
    return {
        "id": "wi-1",
        "workspace_id": _WS_ID,
        "email": "newuser@example.com",
        "role": "member",
        "invited_by": invited_by,
        "expires_at": "2026-05-08T10:00:00Z",
        "accepted_at": None,
        "deleted_at": None,
        "created_at": "2026-05-01T10:00:00Z",
    }


# ── resend ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resend_org_invite_extends_expiry_and_sends_email():
    """Resending an org_invite extends expires_at and queues the org_invite template."""
    inv = _org_invite()
    mock = _make_directus_mock(org_invite_row=inv)

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.invite_actions._enqueue_invite_email", return_value=True
        ) as enqueue_mock,
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/v2/invites/{inv['id']}/resend")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "success"
    assert body["type"] == "org"
    assert body["email_sent"] is True

    updates = [c.args for c in mock.update_item.call_args_list]
    assert updates and updates[0][0] == "org_invite" and updates[0][1] == inv["id"]
    assert "expires_at" in updates[0][2]

    assert enqueue_mock.called
    kwargs = enqueue_mock.call_args.kwargs
    assert kwargs["template"] == "org_invite"


@pytest.mark.asyncio
async def test_resend_workspace_invite_uses_workspace_template():
    """Resending a workspace_invite uses the workspace_invite template."""
    inv = _workspace_invite()
    mock = _make_directus_mock(workspace_invite_row=inv)

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.invite_actions._enqueue_invite_email", return_value=True
        ) as enqueue_mock,
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/v2/invites/{inv['id']}/resend")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["type"] == "workspace"
    updates = [c.args for c in mock.update_item.call_args_list]
    assert updates and updates[0][0] == "workspace_invite"
    assert enqueue_mock.call_args.kwargs["template"] == "workspace_invite"


@pytest.mark.asyncio
async def test_resend_returns_404_when_invite_missing():
    """Unknown id (or already soft-deleted) → 404."""
    mock = _make_directus_mock()
    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/v2/invites/missing-id/resend")

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_resend_rejects_non_inviter_non_admin():
    """A user who is neither the inviter nor an org admin gets 403."""
    inv = _org_invite(invited_by=_OTHER_USER_ID)
    mock = _make_directus_mock(org_invite_row=inv, caller_is_admin=False)

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/v2/invites/{inv['id']}/resend")

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_resend_allows_original_inviter_even_if_not_admin():
    """The original inviter can resend even without org-admin role,
    provided they still have a live org_membership. A former admin who
    was removed from the org should not retain this power."""
    inv = _org_invite(invited_by=_APP_USER_ID)
    mock = _make_directus_mock(
        org_invite_row=inv,
        caller_is_admin=False,
        caller_is_member=True,
    )

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/v2/invites/{inv['id']}/resend")

    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_resend_rejects_former_inviter_not_in_org():
    """A user who originally sent the invite but has since been removed
    from the org cannot resend it. The is_inviter path is gated by a
    live org_membership check to keep removed admins from driving
    branded org emails."""
    inv = _org_invite(invited_by=_APP_USER_ID)
    mock = _make_directus_mock(
        org_invite_row=inv,
        caller_is_admin=False,
        caller_is_member=False,
    )

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/v2/invites/{inv['id']}/resend")

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_resend_rejects_already_accepted_invite():
    """Accepted invites can't be resent."""
    inv = _org_invite()
    inv["accepted_at"] = "2026-05-02T10:00:00Z"
    mock = _make_directus_mock(org_invite_row=inv)

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/v2/invites/{inv['id']}/resend")

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_resend_rate_limited():
    """Rate limiter raises → 429 propagated."""
    inv = _org_invite()
    mock = _make_directus_mock(org_invite_row=inv)

    failing = AsyncMock()
    failing.check = AsyncMock(side_effect=HTTPException(status_code=429, detail="Too many resends"))

    with (
        patch("dembrane.api.v2.invite_actions._resend_rate_limiter", failing),
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(f"/v2/invites/{inv['id']}/resend")

    assert resp.status_code == 429


# ── revoke ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_revoke_org_invite_soft_deletes():
    """DELETE on an org_invite sets deleted_at."""
    inv = _org_invite()
    mock = _make_directus_mock(org_invite_row=inv)

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.delete(f"/v2/invites/{inv['id']}")

    assert resp.status_code == 200
    assert resp.json()["type"] == "org"
    updates = [c.args for c in mock.update_item.call_args_list]
    assert updates and updates[0][0] == "org_invite"
    assert updates[0][2]["deleted_at"] is not None


@pytest.mark.asyncio
async def test_revoke_workspace_invite_soft_deletes():
    """DELETE on a workspace_invite sets deleted_at."""
    inv = _workspace_invite()
    mock = _make_directus_mock(workspace_invite_row=inv)

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.delete(f"/v2/invites/{inv['id']}")

    assert resp.status_code == 200
    assert resp.json()["type"] == "workspace"
    updates = [c.args for c in mock.update_item.call_args_list]
    assert updates and updates[0][0] == "workspace_invite"
    assert updates[0][2]["deleted_at"] is not None


@pytest.mark.asyncio
async def test_revoke_rejects_non_inviter_non_admin():
    """Same permission model as resend."""
    inv = _org_invite(invited_by=_OTHER_USER_ID)
    mock = _make_directus_mock(org_invite_row=inv, caller_is_admin=False)

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.delete(f"/v2/invites/{inv['id']}")

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_revoke_returns_404_for_missing_invite():
    mock = _make_directus_mock()
    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.delete("/v2/invites/does-not-exist")

    assert resp.status_code == 404
