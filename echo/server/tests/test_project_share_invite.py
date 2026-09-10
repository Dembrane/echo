"""Inline workspace invite from the project sharing modal.

Covers the three surfaces that let a project admin share a private project
with someone who isn't on the workspace yet:

1. POST /v2/projects/:id/members returns a structured 404
   (detail.code == "not_a_member") so the modal can offer an invite.
2. POST /v2/workspaces/:id/invite accepts an optional project_id; the share
   level follows the workspace role.
   Existing users get the project share immediately; new users get the
   intent stored on the workspace_invite row.
3. Both accept paths (accept-by-hash for existing accounts, onboarding
   auto-accept for new accounts) grant the stored project share.
"""

from __future__ import annotations

import hmac
import hashlib
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "du-admin-001"
_APP_USER_ID = "au-admin-001"
_APP_USER = {"id": _APP_USER_ID, "email": "admin@example.com", "display_name": "WS Admin"}
_ORG_ID = "org-001"
_WORKSPACE_ID = "ws-target"
_WORKSPACE_ROW = {
    "id": _WORKSPACE_ID,
    "name": "Target WS",
    "org_id": _ORG_ID,
    "tier": "innovator",
    "deleted_at": None,
}
_PROJECT_ID = "proj-001"
_PROJECT_ROW = {
    "id": _PROJECT_ID,
    "name": "Ateliers",
    "workspace_id": _WORKSPACE_ID,
    "visibility": "private",
    "deleted_at": None,
}


def _noop_rate_limiter() -> AsyncMock:
    rl = AsyncMock()
    rl.check = AsyncMock(return_value=None)
    return rl


@pytest.fixture(autouse=True)
def _patch_side_effects():
    with (
        patch("dembrane.api.v2.invites._invite_rate_limiter", _noop_rate_limiter()),
        patch("dembrane.api.v2.me._accept_rate_limiter", _noop_rate_limiter()),
        patch("dembrane.api.v2.onboarding._onboarding_rate_limiter", _noop_rate_limiter()),
        patch("dembrane.api.v2.onboarding._answers_rate_limiter", _noop_rate_limiter()),
        patch("dembrane.api.v2.invites.assert_can_add_seat", new_callable=AsyncMock),
        patch("dembrane.api.v2.me.assert_can_add_seat", new_callable=AsyncMock),
        patch("dembrane.api.v2.onboarding.assert_can_add_seat", new_callable=AsyncMock),
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
        patch("dembrane.cache_utils.invalidate_workspace_and_org_usage", new_callable=AsyncMock),
        patch(
            "dembrane.billing_service.get_account_for_workspace",
            new_callable=AsyncMock,
            return_value=None,
        ),
        patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
    ):
        yield


def _project_membership_creates(mock: AsyncMock) -> list[dict[str, Any]]:
    return [c.args[1] for c in mock.create_item.call_args_list if c.args[0] == "project_membership"]


# ────────────────────────────────────────────────────────────────────
# 1. Members endpoint: structured not_a_member error
# ────────────────────────────────────────────────────────────────────


def _build_sharing_app() -> FastAPI:
    from dembrane.api.v2.project_sharing import router

    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/projects")
    return app


@pytest.mark.asyncio
async def test_add_share_unknown_email_returns_not_a_member_code():
    mock = AsyncMock()

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        return []  # no app_user with that email

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: {
            "project": _PROJECT_ROW,
            "workspace": _WORKSPACE_ROW,
        }.get(col)
    )

    with (
        patch("dembrane.api.v2.project_sharing.async_directus", mock),
        patch(
            "dembrane.api.v2.project_sharing.get_app_user_or_raise",
            new_callable=AsyncMock,
            return_value=_APP_USER,
        ),
        patch(
            "dembrane.api.v2.project_sharing.user_can_access",
            new_callable=AsyncMock,
            return_value=("admin", "direct"),
        ),
        patch(
            "dembrane.billing_account.resolve_workspace_tier",
            new_callable=AsyncMock,
            return_value="innovator",
        ),
    ):
        app = _build_sharing_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/projects/{_PROJECT_ID}/members",
                json={"email": "new@example.com", "role": "viewer"},
            )

    assert resp.status_code == 404, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "not_a_member"
    assert "isn't on this workspace" in detail["message"]
    mock.create_item.assert_not_called()


@pytest.mark.asyncio
async def test_add_share_user_outside_workspace_returns_not_a_member_code():
    mock = AsyncMock()

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "app_user":
            return [{"id": "au-outsider"}]
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: {
            "project": _PROJECT_ROW,
            "workspace": _WORKSPACE_ROW,
        }.get(col)
    )

    async def _fake_access(_ws_id: str, user_id: str) -> Any:
        return ("admin", "direct") if user_id == _APP_USER_ID else None

    with (
        patch("dembrane.api.v2.project_sharing.async_directus", mock),
        patch(
            "dembrane.api.v2.project_sharing.get_app_user_or_raise",
            new_callable=AsyncMock,
            return_value=_APP_USER,
        ),
        patch(
            "dembrane.api.v2.project_sharing.user_can_access",
            new_callable=AsyncMock,
            side_effect=_fake_access,
        ),
        patch(
            "dembrane.billing_account.resolve_workspace_tier",
            new_callable=AsyncMock,
            return_value="innovator",
        ),
    ):
        app = _build_sharing_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/projects/{_PROJECT_ID}/members",
                json={"email": "outsider@example.com", "role": "viewer"},
            )

    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "not_a_member"
    mock.create_item.assert_not_called()


# ────────────────────────────────────────────────────────────────────
# 2. Invite endpoint with project_id
# ────────────────────────────────────────────────────────────────────


def _build_invite_app(ctx: WorkspaceContext) -> FastAPI:
    from dembrane.api.v2.invites import router

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


def _build_invite_directus_mock(
    *,
    invitee_directus_user: dict[str, Any] | None,
    existing_workspace_membership: list[dict[str, Any]] | None = None,
    existing_org_membership_for_invitee: list[dict[str, Any]] | None = None,
    existing_workspace_invite: list[dict[str, Any]] | None = None,
    existing_project_membership: list[dict[str, Any]] | None = None,
    project_row: dict[str, Any] | None = None,
) -> AsyncMock:
    mock = AsyncMock()
    project = project_row if project_row is not None else _PROJECT_ROW

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "app_user":
            return [{"id": _APP_USER_ID, "email": _APP_USER["email"], "display_name": "WS Admin"}]
        if collection == "workspace_membership":
            return existing_workspace_membership or []
        if collection == "org_membership":
            return existing_org_membership_for_invitee or []
        if collection == "workspace_invite":
            return existing_workspace_invite or []
        if collection == "project_membership":
            return existing_project_membership or []
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_users = AsyncMock(
        side_effect=lambda _p: [invitee_directus_user] if invitee_directus_user else []
    )

    async def _fake_get_item(collection: str, _id: str) -> Any:
        if collection == "app_user":
            return {"id": _APP_USER_ID, "display_name": "WS Admin"}
        if collection == "org":
            return {"id": _ORG_ID, "name": "Acme"}
        if collection == "project":
            return project
        return None

    mock.get_item = AsyncMock(side_effect=_fake_get_item)
    mock.create_item = AsyncMock(return_value={"data": {"id": "new-id"}})
    mock.update_item = AsyncMock(return_value={"data": {}})
    return mock


async def _post_invite(
    mock: AsyncMock, payload: dict, *, invitee_app_user: dict | None, role="admin"
):
    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=invitee_app_user),
        patch("dembrane.api.v2.invites._enqueue_invite_email", return_value=True),
    ):
        app = _build_invite_app(_make_ctx(role))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.post(f"/v2/workspaces/{_WORKSPACE_ID}/invite", json=payload)


@pytest.mark.asyncio
async def test_invite_existing_user_with_project_grants_share_immediately():
    invitee_app_user = {"id": "au-bob", "email": "bob@example.com"}
    mock = _build_invite_directus_mock(
        invitee_directus_user={"id": "du-bob", "email": "bob@example.com"},
        existing_org_membership_for_invitee=[{"id": "om-1"}],
    )

    resp = await _post_invite(
        mock,
        {
            "email": "bob@example.com",
            "role": "member",
            "project_id": _PROJECT_ID,
        },
        invitee_app_user=invitee_app_user,
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "added"
    creates = _project_membership_creates(mock)
    assert len(creates) == 1
    assert creates[0]["project_id"] == _PROJECT_ID
    assert creates[0]["user_id"] == "au-bob"
    assert "role" not in creates[0]  # access follows the workspace role
    assert creates[0]["granted_by"] == _APP_USER_ID


@pytest.mark.asyncio
async def test_invite_existing_member_with_project_still_grants_share():
    """already_member is idempotent for the workspace but must still share the project."""
    invitee_app_user = {"id": "au-bob", "email": "bob@example.com"}
    mock = _build_invite_directus_mock(
        invitee_directus_user={"id": "du-bob", "email": "bob@example.com"},
        existing_workspace_membership=[
            {"id": "wm-1", "user_id": "au-bob", "role": "member", "deleted_at": None}
        ],
    )

    resp = await _post_invite(
        mock,
        {"email": "bob@example.com", "role": "member", "project_id": _PROJECT_ID},
        invitee_app_user=invitee_app_user,
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "already_member"
    creates = _project_membership_creates(mock)
    assert len(creates) == 1
    assert "role" not in creates[0]


@pytest.mark.asyncio
async def test_invite_existing_user_with_existing_share_is_noop():
    invitee_app_user = {"id": "au-bob", "email": "bob@example.com"}
    mock = _build_invite_directus_mock(
        invitee_directus_user={"id": "du-bob", "email": "bob@example.com"},
        existing_workspace_membership=[
            {"id": "wm-1", "user_id": "au-bob", "role": "member", "deleted_at": None}
        ],
        existing_project_membership=[{"id": "pm-1", "role": "viewer"}],
    )

    resp = await _post_invite(
        mock,
        {
            "email": "bob@example.com",
            "role": "member",
            "project_id": _PROJECT_ID,
        },
        invitee_app_user=invitee_app_user,
    )

    assert resp.status_code == 200, resp.text
    assert _project_membership_creates(mock) == []
    assert not [c for c in mock.update_item.call_args_list if c.args[0] == "project_membership"]


@pytest.mark.asyncio
async def test_invite_new_user_with_project_stores_intent_on_invite():
    mock = _build_invite_directus_mock(invitee_directus_user=None)

    resp = await _post_invite(
        mock,
        {
            "email": "new@example.com",
            "role": "member",
            "project_id": _PROJECT_ID,
        },
        invitee_app_user=None,
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "invited"
    invite_creates = [
        c.args[1] for c in mock.create_item.call_args_list if c.args[0] == "workspace_invite"
    ]
    assert len(invite_creates) == 1
    assert invite_creates[0]["project_id"] == _PROJECT_ID
    assert "project_role" not in invite_creates[0]
    assert _project_membership_creates(mock) == []


@pytest.mark.asyncio
async def test_invite_new_user_without_project_leaves_invite_unchanged():
    """Regression: plain invites must not carry project fields."""
    mock = _build_invite_directus_mock(invitee_directus_user=None)

    resp = await _post_invite(
        mock, {"email": "new@example.com", "role": "member"}, invitee_app_user=None
    )

    assert resp.status_code == 200, resp.text
    invite_creates = [
        c.args[1] for c in mock.create_item.call_args_list if c.args[0] == "workspace_invite"
    ]
    assert len(invite_creates) == 1
    assert "project_id" not in invite_creates[0]
    assert "project_role" not in invite_creates[0]


@pytest.mark.asyncio
async def test_reinvite_pending_user_sets_project_when_invite_has_none():
    mock = _build_invite_directus_mock(
        invitee_directus_user=None,
        existing_workspace_invite=[{"id": "wi-pending", "project_id": None}],
    )

    resp = await _post_invite(
        mock,
        {
            "email": "new@example.com",
            "role": "member",
            "project_id": _PROJECT_ID,
        },
        invitee_app_user=None,
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "already_invited"
    assert resp.json()["project_share"] == "pending"
    updates = [c.args for c in mock.update_item.call_args_list if c.args[0] == "workspace_invite"]
    assert updates == [("workspace_invite", "wi-pending", {"project_id": _PROJECT_ID})]


@pytest.mark.asyncio
async def test_reinvite_pending_user_keeps_other_project():
    """A pending invite already carrying project A is not hijacked by project B."""
    mock = _build_invite_directus_mock(
        invitee_directus_user=None,
        existing_workspace_invite=[{"id": "wi-pending", "project_id": "proj-other"}],
    )

    resp = await _post_invite(
        mock,
        {"email": "new@example.com", "role": "member", "project_id": _PROJECT_ID},
        invitee_app_user=None,
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "already_invited"
    assert resp.json()["project_share"] == "pending_other_project"
    assert not [c for c in mock.update_item.call_args_list if c.args[0] == "workspace_invite"]


@pytest.mark.asyncio
async def test_invite_response_reports_project_share_outcome():
    invitee_app_user = {"id": "au-bob", "email": "bob@example.com"}
    mock = _build_invite_directus_mock(
        invitee_directus_user={"id": "du-bob", "email": "bob@example.com"},
        existing_org_membership_for_invitee=[{"id": "om-1"}],
    )
    resp = await _post_invite(
        mock, {"email": "bob@example.com", "role": "member", "project_id": _PROJECT_ID},
        invitee_app_user=invitee_app_user,
    )
    assert resp.json()["project_share"] == "granted"

    mock = _build_invite_directus_mock(invitee_directus_user=None)
    resp = await _post_invite(
        mock, {"email": "new@example.com", "role": "member", "project_id": _PROJECT_ID},
        invitee_app_user=None,
    )
    assert resp.json()["project_share"] == "pending"

    mock = _build_invite_directus_mock(invitee_directus_user=None)
    resp = await _post_invite(mock, {"email": "new@example.com", "role": "member"}, invitee_app_user=None)
    assert resp.json()["project_share"] is None


@pytest.mark.asyncio
async def test_invite_with_project_in_other_workspace_rejected():
    mock = _build_invite_directus_mock(
        invitee_directus_user=None,
        project_row={**_PROJECT_ROW, "workspace_id": "ws-other"},
    )

    resp = await _post_invite(
        mock,
        {"email": "new@example.com", "role": "member", "project_id": _PROJECT_ID},
        invitee_app_user=None,
    )

    assert resp.status_code == 404, resp.text
    mock.create_item.assert_not_called()


@pytest.mark.asyncio
async def test_invite_with_non_private_project_rejected():
    mock = _build_invite_directus_mock(
        invitee_directus_user=None,
        project_row={**_PROJECT_ROW, "visibility": "workspace"},
    )

    resp = await _post_invite(
        mock,
        {"email": "new@example.com", "role": "member", "project_id": _PROJECT_ID},
        invitee_app_user=None,
    )

    assert resp.status_code == 400, resp.text
    mock.create_item.assert_not_called()


@pytest.mark.asyncio
async def test_invite_with_project_requires_share_policy():
    """A workspace member has member:invite? No. Give them the invite policy
    via custom_policies and confirm project:share is still required."""
    mock = _build_invite_directus_mock(invitee_directus_user=None)
    ctx = WorkspaceContext(
        workspace_id=_WORKSPACE_ID,
        workspace=_WORKSPACE_ROW,
        app_user_id=_APP_USER_ID,
        role="member",
        custom_policies=["member:invite"],
        source="direct",
    )

    with (
        patch("dembrane.api.v2.invites.async_directus", mock),
        patch("dembrane.api.v2.invites.resolve_app_user", return_value=None),
        patch("dembrane.api.v2.invites._enqueue_invite_email", return_value=True),
    ):
        app = _build_invite_app(ctx)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/invite",
                json={"email": "new@example.com", "role": "member", "project_id": _PROJECT_ID},
            )

    assert resp.status_code == 403, resp.text
    mock.create_item.assert_not_called()


# ────────────────────────────────────────────────────────────────────
# 3a. Accept by hash grants the stored project share
# ────────────────────────────────────────────────────────────────────

_BOB_USER_ID = "du-bob"
_BOB_APP_USER_ID = "au-bob"
_BOB_EMAIL = "bob@example.com"
_BOB_APP_USER = {"id": _BOB_APP_USER_ID, "email": _BOB_EMAIL, "display_name": "Bob"}


def _invite_hash(invite_id: str) -> str:
    from dembrane.settings import get_settings

    secret = get_settings().directus.secret.encode()
    return hmac.new(secret, invite_id.encode(), hashlib.sha256).hexdigest()[:32]


def _build_me_app() -> FastAPI:
    from dembrane.api.v2.me import router

    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_BOB_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/me")
    return app


def _build_accept_mock(invite_row: dict, *, project_row: dict | None = _PROJECT_ROW) -> AsyncMock:
    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "workspace_invite":
            return [invite_row]
        if collection == "org_membership":
            return [{"id": "om-existing", "role": "member", "deleted_at": None}]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: {
            "workspace": _WORKSPACE_ROW,
            "project": project_row,
        }.get(col)
    )
    mock.create_item = AsyncMock(return_value={"data": {"id": "new"}})
    mock.update_item = AsyncMock(return_value={"data": {}})
    return mock


async def _accept_by_hash(mock: AsyncMock, invite_id: str):
    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_BOB_APP_USER),
    ):
        app = _build_me_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": _invite_hash(invite_id), "claimed_role": "member"},
            )


@pytest.mark.asyncio
async def test_accept_by_hash_grants_project_share():
    invite_row = {
        "id": "wi-1",
        "email": _BOB_EMAIL,
        "workspace_id": _WORKSPACE_ID,
        "role": "member",
        "project_id": _PROJECT_ID,
        "invited_by": _APP_USER_ID,
    }
    mock = _build_accept_mock(invite_row)

    resp = await _accept_by_hash(mock, "wi-1")

    assert resp.status_code == 200, resp.text
    creates = _project_membership_creates(mock)
    assert len(creates) == 1
    assert creates[0]["project_id"] == _PROJECT_ID
    assert creates[0]["user_id"] == _BOB_APP_USER_ID
    assert creates[0]["granted_by"] == _APP_USER_ID


@pytest.mark.asyncio
async def test_accept_by_hash_without_project_creates_no_share():
    invite_row = {
        "id": "wi-1",
        "email": _BOB_EMAIL,
        "workspace_id": _WORKSPACE_ID,
        "role": "member",
    }
    mock = _build_accept_mock(invite_row)

    resp = await _accept_by_hash(mock, "wi-1")

    assert resp.status_code == 200, resp.text
    assert _project_membership_creates(mock) == []


@pytest.mark.asyncio
async def test_accept_by_hash_skips_share_when_project_moved_or_deleted():
    """Project moved to another workspace after the invite went out: the
    workspace membership still lands, the project share is skipped."""
    invite_row = {
        "id": "wi-1",
        "email": _BOB_EMAIL,
        "workspace_id": _WORKSPACE_ID,
        "role": "member",
        "project_id": _PROJECT_ID,
    }
    mock = _build_accept_mock(invite_row, project_row={**_PROJECT_ROW, "workspace_id": "ws-other"})

    resp = await _accept_by_hash(mock, "wi-1")

    assert resp.status_code == 200, resp.text
    wm_creates = [c for c in mock.create_item.call_args_list if c.args[0] == "workspace_membership"]
    assert len(wm_creates) == 1
    assert _project_membership_creates(mock) == []


# ────────────────────────────────────────────────────────────────────
# 3b. Onboarding auto-accept grants the stored project share
# ────────────────────────────────────────────────────────────────────


def _build_onboarding_app() -> FastAPI:
    from dembrane.api.v2.onboarding import router

    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_BOB_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/onboarding")
    return app


@pytest.mark.asyncio
async def test_onboarding_auto_accept_grants_project_share():
    pending_invite = {
        "id": "inv-1",
        "workspace_id": _WORKSPACE_ID,
        "role": "member",
        "expires_at": "2099-01-01T00:00:00Z",
        "project_id": _PROJECT_ID,
        "invited_by": _APP_USER_ID,
    }
    requested_fields: list[list[str]] = []

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "workspace_invite":
            requested_fields.append(params["query"].get("fields", []))
            return [pending_invite]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: {
            "workspace": {**_WORKSPACE_ROW, "tier": "innovator"},
            "project": _PROJECT_ROW,
        }.get(col)
    )
    mock.create_item = AsyncMock(return_value={"data": {"id": "new-item"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock),
        patch("dembrane.api.v2.onboarding.resolve_app_user", return_value=_BOB_APP_USER),
        patch(
            "dembrane.api.v2.onboarding.get_directus_user_profile",
            return_value={"email": _BOB_EMAIL, "display_name": "Bob"},
        ),
    ):
        app = _build_onboarding_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/v2/onboarding/complete", json={"org_name": "Ignored"})

    assert resp.status_code == 200, resp.text
    # The pending-invite query must ask Directus for the project columns.
    assert any("project_id" in f for f in requested_fields)
    creates = _project_membership_creates(mock)
    assert len(creates) == 1
    assert creates[0]["project_id"] == _PROJECT_ID
    assert creates[0]["user_id"] == _BOB_APP_USER_ID
    assert creates[0]["granted_by"] == _APP_USER_ID


# ────────────────────────────────────────────────────────────────────
# 4. Shared helper: upsert_project_membership
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upsert_project_membership_creates_when_missing():
    from dembrane.api.v2._invite_helpers import upsert_project_membership

    mock = AsyncMock()
    mock.get_items = AsyncMock(return_value=[])
    mock.create_item = AsyncMock(return_value={"data": {"id": "pm-new"}})

    result = await upsert_project_membership(mock, project_id=_PROJECT_ID, user_id="au-x", granted_by="au-admin")

    assert result == "created"
    payload = mock.create_item.call_args.args[1]
    assert payload["project_id"] == _PROJECT_ID
    assert payload["user_id"] == "au-x"
    assert payload["granted_by"] == "au-admin"
    assert "role" not in payload
    assert payload["id"]


@pytest.mark.asyncio
async def test_upsert_project_membership_is_noop_when_present():
    from dembrane.api.v2._invite_helpers import upsert_project_membership

    mock = AsyncMock()
    mock.get_items = AsyncMock(return_value=[{"id": "pm-1"}])

    result = await upsert_project_membership(mock, project_id=_PROJECT_ID, user_id="au-x", granted_by="au-admin")

    assert result == "exists"
    mock.create_item.assert_not_called()
    mock.update_item.assert_not_called()


# ────────────────────────────────────────────────────────────────────
# 5. Workspace role is the single source of truth for what a share allows
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_private_project_share_resolves_to_workspace_role():
    """A share only unlocks the private project; permissions stay those of the workspace role."""
    from dembrane.inheritance import get_user_project_access

    mock = AsyncMock()
    mock.get_items = AsyncMock(return_value=[{"id": "pm-1"}])  # share row exists

    with (
        patch("dembrane.inheritance.async_directus", mock),
        patch(
            "dembrane.inheritance.user_can_access",
            new_callable=AsyncMock,
            return_value=("external", "direct"),
        ),
    ):
        access = await get_user_project_access(_PROJECT_ID, "au-ext", project=_PROJECT_ROW)

    assert access == ("external", "project_share")


def test_project_share_access_uses_workspace_preset():
    from dembrane.api.v2.bff._access import ResourceAccess

    def _access(role: str) -> ResourceAccess:
        return ResourceAccess(
            app_user_id="au", directus_user_id="du", project_id=_PROJECT_ID, workspace_id=_WORKSPACE_ID,
            tier="innovator", role=role, source="project_share",
        )

    ext = _access("external")
    assert ext.allows("project:read") and ext.allows("chat:use")
    assert not ext.allows("conversation:delete") and not ext.allows("export:data")
    obs = _access("observer")
    assert obs.allows("conversation:read") and not obs.allows("chat:use")
    billing = _access("billing")
    assert not billing.allows("project:read")


@pytest.mark.asyncio
async def test_add_share_has_no_role_and_reports_workspace_role():
    members = {"au-obs": {"email": "obs@example.com", "display_name": "Obs"}}
    mock = _build_share_mock(ws_members=members)
    resp = await _post_share(mock, {"email": "obs@example.com"}, invitee_ws_role="observer")
    assert resp.status_code == 200, resp.text
    creates = _project_membership_creates(mock)
    assert len(creates) == 1 and "role" not in creates[0]
    assert resp.json()["workspace_role"] == "observer"
    assert "role" not in resp.json()


@pytest.mark.asyncio
async def test_list_shares_resolves_workspace_roles_once():
    """No per-row user_can_access: roles come from one get_effective_members call."""
    mock = AsyncMock()

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "project_membership":
            return [
                {"user_id": "au-1", "granted_by": _APP_USER_ID, "created_at": None},
                {"user_id": "au-2", "granted_by": _APP_USER_ID, "created_at": None},
            ]
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: {
            "project": _PROJECT_ROW,
            "workspace": _WORKSPACE_ROW,
            "app_user": {"id": _id, "email": f"{_id}@example.com", "display_name": _id},
        }.get(col)
    )
    mock.get_users = AsyncMock(return_value=[])
    access_calls: list[str] = []

    async def _fake_access(_ws_id: str, user_id: str) -> Any:
        access_calls.append(user_id)
        return ("admin", "direct")

    with (
        patch("dembrane.api.v2.project_sharing.async_directus", mock),
        patch(
            "dembrane.api.v2.project_sharing.get_app_user_or_raise",
            new_callable=AsyncMock,
            return_value=_APP_USER,
        ),
        patch(
            "dembrane.api.v2.project_sharing.user_can_access",
            new_callable=AsyncMock,
            side_effect=_fake_access,
        ),
        patch(
            "dembrane.api.v2.project_sharing.get_effective_members",
            new_callable=AsyncMock,
            return_value=[
                {"user_id": "au-1", "role": "member", "source": "direct"},
                {"user_id": "au-2", "role": "observer", "source": "direct"},
            ],
        ) as eff,
    ):
        app = _build_sharing_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/projects/{_PROJECT_ID}/members")

    assert resp.status_code == 200, resp.text
    roles = {m["user_id"]: m["workspace_role"] for m in resp.json()}
    assert roles == {"au-1": "member", "au-2": "observer"}
    eff.assert_awaited_once_with(_WORKSPACE_ID)
    assert access_calls == [_APP_USER_ID]  # reader check only


# ────────────────────────────────────────────────────────────────────
# 7. Org multi-consume grants the share too
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_org_invite_accept_consumes_project_share_invite():
    """Accepting an org invite consumes every pending invite in the org; a consumed
    workspace invite that carries project_id must still grant the share."""
    org_invite = {"id": "oi-1", "org_id": _ORG_ID, "role": "member", "email": _BOB_EMAIL}
    ws_invite = {
        "id": "wi-proj",
        "workspace_id": _WORKSPACE_ID,
        "role": "member",
        "project_id": _PROJECT_ID,
        "invited_by": _APP_USER_ID,
    }

    async def _fake_get_items(collection: str, params: dict) -> Any:
        f = params.get("query", {}).get("filter", {})
        if collection == "workspace_invite":
            # accept-by-hash probe (email filter) finds nothing; the consume sweep (workspace_id filter) finds ours.
            return [ws_invite] if "workspace_id" in f else []
        if collection == "org_invite":
            return [org_invite]
        if collection == "workspace":
            return [{"id": _WORKSPACE_ID}]
        if collection == "org_membership":
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: {
            "org": {"id": _ORG_ID, "name": "Acme", "deleted_at": None},
            "workspace": _WORKSPACE_ROW,
            "project": _PROJECT_ROW,
        }.get(col)
    )
    mock.create_item = AsyncMock(return_value={"data": {"id": "new"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_BOB_APP_USER),
        patch("dembrane.api.v2.me.resolve_workspace_billing", new_callable=AsyncMock, return_value={}),
    ):
        app = _build_me_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": _invite_hash("oi-1"), "claimed_role": "member"},
            )

    assert resp.status_code == 200, resp.text
    wm = [c.args[1] for c in mock.create_item.call_args_list if c.args[0] == "workspace_membership"]
    assert len(wm) == 1 and wm[0]["workspace_id"] == _WORKSPACE_ID
    creates = _project_membership_creates(mock)
    assert len(creates) == 1
    assert creates[0]["project_id"] == _PROJECT_ID
    assert creates[0]["user_id"] == _BOB_APP_USER_ID


# ────────────────────────────────────────────────────────────────────
# 8. Workspace admins can revoke invites sent from their workspace
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_workspace_admin_can_revoke_workspace_invite():
    from dembrane.api.v2.invite_actions import router as invite_actions_router

    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(invite_actions_router, prefix="/v2/invites")

    invite = {"id": "wi-1", "workspace_id": _WORKSPACE_ID, "invited_by": "au-someone-else", "accepted_at": None, "deleted_at": None}
    mock = AsyncMock()
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.invite_actions.async_directus", mock),
        patch("dembrane.api.v2.invite_actions.get_app_user_or_raise", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.invite_actions._load_invite_including_deleted",
            new_callable=AsyncMock,
            return_value=("workspace", invite),
        ),
        patch("dembrane.api.v2.invite_actions._workspace_org_id", new_callable=AsyncMock, return_value=_ORG_ID),
        patch("dembrane.api.v2.invite_actions._user_is_org_admin", new_callable=AsyncMock, return_value=False),
        patch("dembrane.api.v2.invite_actions._user_is_org_member", new_callable=AsyncMock, return_value=True),
        patch(
            "dembrane.api.v2.invite_actions.user_can_access",
            new_callable=AsyncMock,
            return_value=("admin", "direct"),
        ),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.delete("/v2/invites/wi-1")

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "success"
    assert [c.args[0] for c in mock.update_item.call_args_list] == ["workspace_invite"]


async def _post_share(mock: AsyncMock, payload: dict, invitee_ws_role: str):
    async def _fake_access(_ws_id: str, user_id: str) -> Any:
        if user_id == _APP_USER_ID:
            return ("admin", "direct")
        return (invitee_ws_role, "direct")

    with (
        patch("dembrane.api.v2.project_sharing.async_directus", mock),
        patch(
            "dembrane.api.v2.project_sharing.get_app_user_or_raise",
            new_callable=AsyncMock,
            return_value=_APP_USER,
        ),
        patch(
            "dembrane.api.v2.project_sharing.user_can_access",
            new_callable=AsyncMock,
            side_effect=_fake_access,
        ),
        patch(
            "dembrane.billing_account.resolve_workspace_tier",
            new_callable=AsyncMock,
            return_value="innovator",
        ),
    ):
        app = _build_sharing_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.post(f"/v2/projects/{_PROJECT_ID}/members", json=payload)


def _build_share_mock(*, ws_members: dict[str, dict]) -> AsyncMock:
    """ws_members: app_user id -> app_user row (email, display_name)."""
    mock = AsyncMock()

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "app_user":
            email = params["query"]["filter"]["email"]["_eq"]
            return [{"id": uid} for uid, row in ws_members.items() if row["email"] == email]
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)

    async def _fake_get_item(col: str, _id: str) -> Any:
        if col == "project":
            return _PROJECT_ROW
        if col == "workspace":
            return _WORKSPACE_ROW
        if col == "app_user":
            return {"id": _id, **ws_members.get(_id, {})}
        return None

    mock.get_item = AsyncMock(side_effect=_fake_get_item)
    mock.get_users = AsyncMock(return_value=[])
    mock.create_item = AsyncMock(return_value={"data": {"id": "pm-new"}})
    mock.update_item = AsyncMock(return_value={"data": {}})
    return mock


# ────────────────────────────────────────────────────────────────────
# 6. Pending invites carrying this project (Access tab)
# ────────────────────────────────────────────────────────────────────


def _build_invites_list_mock(rows: list[dict]) -> AsyncMock:
    mock = AsyncMock()
    seen: dict[str, dict] = {}

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "workspace_invite":
            seen["query"] = params["query"]
            return rows
        if collection == "app_user":
            return [{"id": _APP_USER_ID, "display_name": "WS Admin"}]
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: {"project": _PROJECT_ROW, "workspace": _WORKSPACE_ROW}.get(col)
    )
    mock.seen = seen  # type: ignore[attr-defined]
    return mock


async def _get_project_invites(mock: AsyncMock, caller_role: str):
    with (
        patch("dembrane.api.v2.project_sharing.async_directus", mock),
        patch(
            "dembrane.api.v2.project_sharing.get_app_user_or_raise",
            new_callable=AsyncMock,
            return_value=_APP_USER,
        ),
        patch(
            "dembrane.api.v2.project_sharing.user_can_access",
            new_callable=AsyncMock,
            return_value=(caller_role, "direct"),
        ),
        patch(
            "dembrane.billing_account.resolve_workspace_tier",
            new_callable=AsyncMock,
            return_value="innovator",
        ),
    ):
        app = _build_sharing_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.get(f"/v2/projects/{_PROJECT_ID}/invites")


@pytest.mark.asyncio
async def test_list_project_invites_returns_pending_rows_for_this_project():
    rows = [
        {
            "id": "wi-1",
            "email": "new@example.com",
            "role": "member",
            "created_at": "2026-09-09T10:00:00Z",
            "expires_at": "2026-09-16T10:00:00Z",
        }
    ]
    mock = _build_invites_list_mock(rows)
    resp = await _get_project_invites(mock, "admin")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == [
        {
            "id": "wi-1",
            "email": "new@example.com",
            "role": "member",
            "created_at": "2026-09-09T10:00:00Z",
            "expires_at": "2026-09-16T10:00:00Z",
        }
    ]
    f = mock.seen["query"]["filter"]  # type: ignore[attr-defined]
    assert f["project_id"] == {"_eq": _PROJECT_ID}
    assert f["workspace_id"] == {"_eq": _WORKSPACE_ID}
    assert f["accepted_at"] == {"_null": True}
    assert f["deleted_at"] == {"_null": True}
    assert "_gt" in f["expires_at"]


@pytest.mark.asyncio
async def test_list_project_invites_requires_share_admin():
    mock = _build_invites_list_mock([])
    resp = await _get_project_invites(mock, "member")
    assert resp.status_code == 403, resp.text


# ────────────────────────────────────────────────────────────────────
# 9. Review round 3: billing rejected, sweep grants share, stale rows hidden
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_add_share_rejects_billing_role_member():
    """Billing has no project:read, so a share would be a silent no-op."""
    mock = _build_share_mock(ws_members={"au-bill": {"email": "bill@example.com", "display_name": "Bill"}})
    resp = await _post_share(mock, {"email": "bill@example.com"}, invitee_ws_role="billing")
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["code"] == "role_cannot_access_projects"
    mock.create_item.assert_not_called()


@pytest.mark.asyncio
async def test_invite_with_project_rejects_billing_role():
    mock = _build_invite_directus_mock(invitee_directus_user=None)
    resp = await _post_invite(
        mock,
        {"email": "new@example.com", "role": "billing", "project_id": _PROJECT_ID},
        invitee_app_user=None,
    )
    assert resp.status_code == 400, resp.text
    mock.create_item.assert_not_called()


@pytest.mark.asyncio
async def test_already_member_sweep_grants_pending_project_share():
    """Re-inviting an active member sweeps their stale pending invites; a swept
    invite carrying project_id must still grant that share."""
    invitee_app_user = {"id": "au-bob", "email": "bob@example.com"}
    mock = _build_invite_directus_mock(
        invitee_directus_user={"id": "du-bob", "email": "bob@example.com"},
        existing_workspace_membership=[{"id": "wm-1", "user_id": "au-bob", "role": "member", "deleted_at": None}],
        existing_workspace_invite=[{"id": "wi-stale", "workspace_id": _WORKSPACE_ID, "project_id": "proj-other", "invited_by": _APP_USER_ID}],
    )
    other_project = {**_PROJECT_ROW, "id": "proj-other"}
    orig = mock.get_item.side_effect

    async def _get_item(col: str, _id: str) -> Any:
        if col == "project" and _id == "proj-other":
            return other_project
        return await orig(col, _id)

    mock.get_item = AsyncMock(side_effect=_get_item)

    resp = await _post_invite(mock, {"email": "bob@example.com", "role": "member"}, invitee_app_user=invitee_app_user)

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "already_member"
    creates = _project_membership_creates(mock)
    assert [c["project_id"] for c in creates] == ["proj-other"]
    swept = [c.args for c in mock.update_item.call_args_list if c.args[0] == "workspace_invite"]
    assert len(swept) == 1 and "accepted_at" in swept[0][2]


@pytest.mark.asyncio
async def test_list_shares_hides_rows_without_workspace_access():
    """A share row for someone removed from the workspace is stale; don't list it."""
    mock = AsyncMock()

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "project_membership":
            return [
                {"user_id": "au-1", "granted_by": _APP_USER_ID, "created_at": None},
                {"user_id": "au-gone", "granted_by": _APP_USER_ID, "created_at": None},
            ]
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: {
            "project": _PROJECT_ROW,
            "workspace": _WORKSPACE_ROW,
            "app_user": {"id": _id, "email": f"{_id}@example.com", "display_name": _id},
        }.get(col)
    )
    mock.get_users = AsyncMock(return_value=[])

    with (
        patch("dembrane.api.v2.project_sharing.async_directus", mock),
        patch("dembrane.api.v2.project_sharing.get_app_user_or_raise", new_callable=AsyncMock, return_value=_APP_USER),
        patch("dembrane.api.v2.project_sharing.user_can_access", new_callable=AsyncMock, return_value=("admin", "direct")),
        patch(
            "dembrane.api.v2.project_sharing.get_effective_members",
            new_callable=AsyncMock,
            return_value=[{"user_id": "au-1", "role": "member", "source": "direct"}],
        ),
    ):
        app = _build_sharing_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/projects/{_PROJECT_ID}/members")

    assert resp.status_code == 200, resp.text
    assert [m["user_id"] for m in resp.json()] == ["au-1"]


@pytest.mark.asyncio
async def test_list_project_invites_returns_empty_below_tier():
    """Lapsed tier: no 403 storm from the Access tab, just an empty list."""
    mock = _build_invites_list_mock([{"id": "wi-1", "email": "x@example.com", "role": "member"}])
    with (
        patch("dembrane.api.v2.project_sharing.async_directus", mock),
        patch("dembrane.api.v2.project_sharing.get_app_user_or_raise", new_callable=AsyncMock, return_value=_APP_USER),
        patch("dembrane.api.v2.project_sharing.user_can_access", new_callable=AsyncMock, return_value=("admin", "direct")),
        patch("dembrane.billing_account.resolve_workspace_tier", new_callable=AsyncMock, return_value="free"),
    ):
        app = _build_sharing_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/projects/{_PROJECT_ID}/invites")
    assert resp.status_code == 200, resp.text
    assert resp.json() == []


@pytest.mark.asyncio
async def test_add_share_existing_does_not_renotify():
    members = {"au-mem": {"email": "mem@example.com", "display_name": "Mem"}}
    mock = _build_share_mock(ws_members=members)
    mock.get_items = AsyncMock(side_effect=lambda col, _p: (
        [{"id": "au-mem"}] if col == "app_user" else [{"id": "pm-1"}] if col == "project_membership" else []
    ))
    with patch("dembrane.notifications.emit", new_callable=AsyncMock) as emit:
        resp = await _post_share(mock, {"email": "mem@example.com"}, invitee_ws_role="member")
    assert resp.status_code == 200, resp.text
    emit.assert_not_called()


@pytest.mark.asyncio
async def test_list_project_invites_non_admin_below_tier_still_403():
    """The tier gate must not swallow the admin check: a plain member on a
    lapsed-tier workspace gets 403, not an empty list."""
    mock = _build_invites_list_mock([])
    with (
        patch("dembrane.api.v2.project_sharing.async_directus", mock),
        patch(
            "dembrane.api.v2.project_sharing.get_app_user_or_raise",
            new_callable=AsyncMock,
            return_value=_APP_USER,
        ),
        patch(
            "dembrane.api.v2.project_sharing.user_can_access",
            new_callable=AsyncMock,
            return_value=("member", "direct"),
        ),
        patch(
            "dembrane.billing_account.resolve_workspace_tier",
            new_callable=AsyncMock,
            return_value="free",
        ),
    ):
        app = _build_sharing_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/projects/{_PROJECT_ID}/invites")
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
async def test_add_share_below_tier_keeps_the_plan_message():
    """Regression guard: the tier 403 stays a plain string the toast can show."""
    mock = _build_share_mock(ws_members={"au-mem": {"email": "mem@example.com", "display_name": "Mem"}})
    with (
        patch("dembrane.api.v2.project_sharing.async_directus", mock),
        patch(
            "dembrane.api.v2.project_sharing.get_app_user_or_raise",
            new_callable=AsyncMock,
            return_value=_APP_USER,
        ),
        patch(
            "dembrane.api.v2.project_sharing.user_can_access",
            new_callable=AsyncMock,
            return_value=("admin", "direct"),
        ),
        patch(
            "dembrane.billing_account.resolve_workspace_tier",
            new_callable=AsyncMock,
            return_value="free",
        ),
    ):
        app = _build_sharing_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/v2/projects/{_PROJECT_ID}/members", json={"email": "mem@example.com"}
            )
    assert resp.status_code == 403, resp.text
    assert "plan" in resp.json()["detail"]
