"""Tests for the partner / observer work (Waves F & G).

Covers the new correctness paths that aren't already in test_seat_capacity.py:
- `workspace_is_external_client` classification helper (ISSUE-026/030 gate).
- Observer invites are rejected in internal-use workspaces (ISSUE-030 scope).
- Handoff is refused for org-pooled (internal) workspaces (ISSUE-027 guard).
- `_partner_orgs_user_is_external_of` (ISSUE-028 staff-notify signal).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from httpx import AsyncClient, ASGITransport

from dembrane.billing_account import workspace_is_external_client
from dembrane.api.v2._invite_helpers import is_outsider_role
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DirectusSession, require_directus_session


# ── Outsider classification (security-critical: send + all accept paths) ─


def test_is_outsider_role_covers_external_and_observer():
    """Both outsider roles must classify identically across invite send AND
    every accept path; otherwise accepting an observer invite would create an
    org_membership and escalate the user to a full org member (regression guard
    for the Wave G acceptance-path fix)."""
    assert is_outsider_role("external") is True
    assert is_outsider_role("observer") is True
    for insider in ("member", "billing", "admin", "owner", None, ""):
        assert is_outsider_role(insider) is False


# ── workspace_is_external_client (pure) ─────────────────────────────────


@pytest.mark.parametrize(
    "ws,expected",
    [
        ({"usage_context": "external"}, True),
        ({"usage_context": "internal"}, False),
        ({"usage_context": "External"}, True),  # case-insensitive
        ({"usage_context": None, "billed_to_team_id": "B", "org_id": "A"}, True),
        ({"usage_context": None, "billed_to_team_id": "A", "org_id": "A"}, False),
        ({"usage_context": None, "billed_to_team_id": None, "org_id": "A"}, False),
        ({}, False),
    ],
)
def test_workspace_is_external_client(ws: dict, expected: bool):
    assert workspace_is_external_client(ws) is expected


# ── Observer invite gating (ISSUE-030 scope: partner-only) ──────────────

_USER_ID = "du-admin-001"
_APP_USER_ID = "au-admin-001"
_WORKSPACE_ID = "ws-1"
_ORG_ID = "org-1"


def _build_app(ctx: WorkspaceContext) -> FastAPI:
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


def _ctx(workspace: dict, role: str = "admin") -> WorkspaceContext:
    return WorkspaceContext(
        workspace_id=workspace["id"],
        workspace=workspace,
        app_user_id=_APP_USER_ID,
        role=role,
        custom_policies=[],
        source="direct",
    )


@pytest.mark.asyncio
async def test_observer_invite_rejected_in_internal_workspace():
    """An observer invite to an internal-use workspace is a 400: the free
    observer is partner-only (ISSUE-030). The gate fires before any DB write."""
    ws = {"id": _WORKSPACE_ID, "org_id": _ORG_ID, "usage_context": "internal"}
    app = _build_app(_ctx(ws))
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        r = await client.post(
            f"/v2/workspaces/{_WORKSPACE_ID}/invite",
            json={"email": "obs@client.com", "role": "observer"},
        )
    assert r.status_code == 400
    assert "external client" in r.json()["detail"].lower()


# ── Handoff guard: refuse for org-pooled (internal) workspaces ──────────


@pytest.mark.asyncio
async def test_handoff_initiate_refused_for_org_pooled_workspace():
    """A workspace billed under its org's shared (org-scoped) account can't be
    handed off (ISSUE-027). The guard reads the account and 409s."""
    from dembrane.api.v2 import workspaces as ws_mod

    ws = {
        "id": _WORKSPACE_ID,
        "org_id": _ORG_ID,
        "billing_account_id": "acct-org",
        "billed_to_team_id": None,
    }

    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    async def _fake_ctx() -> WorkspaceContext:
        return _ctx(ws)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.dependency_overrides[get_workspace_context] = _fake_ctx
    app.include_router(ws_mod.router, prefix="/v2/workspaces")

    # Caller is an org admin (authority check passes) and the account is
    # org-scoped (org_id set) → the guard must refuse.
    with (
        patch.object(
            ws_mod, "_caller_admins_organisation", new=AsyncMock(return_value=True)
        ),
        patch.object(
            ws_mod.async_directus,
            "get_item",
            new=AsyncMock(return_value={"id": "acct-org", "org_id": _ORG_ID}),
        ),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://t") as client:
            r = await client.post(
                f"/v2/workspaces/{_WORKSPACE_ID}/handoff/initiate",
                json={"target_organisation_id": "org-2"},
            )
    assert r.status_code == 409
    assert "shared plan" in r.json()["detail"].lower()


# ── ISSUE-028: external-of-partner detection ────────────────────────────


@pytest.mark.asyncio
async def test_partner_orgs_user_is_external_of():
    from dembrane.api.v2 import orgs as orgs_mod

    # get_items is called 3×: external memberships, workspaces, partner orgs.
    calls = [
        [{"workspace_id": "ws-9"}],  # external membership rows
        [{"org_id": "org-partner"}],  # workspace → org
        [{"name": "Facilitation BV"}],  # partner orgs among those
    ]
    with patch.object(
        orgs_mod.async_directus, "get_items", new=AsyncMock(side_effect=calls)
    ):
        names = await orgs_mod._partner_orgs_user_is_external_of("au-ext")
    assert names == ["Facilitation BV"]


@pytest.mark.asyncio
async def test_partner_orgs_user_is_external_of_empty_when_no_external():
    from dembrane.api.v2 import orgs as orgs_mod

    with patch.object(
        orgs_mod.async_directus, "get_items", new=AsyncMock(side_effect=[[]])
    ):
        names = await orgs_mod._partner_orgs_user_is_external_of("au-internal")
    assert names == []


# ── ISSUE-033: project move only within the same billing context ────────


@pytest.mark.asyncio
async def test_same_billing_context_rules():
    from dembrane.billing_service import same_billing_context

    accounts = {
        "ws-int-a": {"id": "acct-org", "org_id": "org-1"},   # internal, org-scoped
        "ws-int-b": {"id": "acct-org", "org_id": "org-1"},   # same org pool
        "ws-int-other-org": {"id": "acct-org2", "org_id": "org-2"},
        "ws-ext-a": {"id": "acct-wsa", "org_id": None},      # external, workspace-scoped
        "ws-ext-b": {"id": "acct-wsb", "org_id": None},      # different external
    }

    async def fake_get_account(ws_id):
        return accounts.get(ws_id)

    with patch(
        "dembrane.billing_service.get_account_for_workspace",
        new=AsyncMock(side_effect=fake_get_account),
    ):
        # internal ↔ internal, same org → allowed
        assert await same_billing_context("ws-int-a", "ws-int-b") is True
        # internal → internal in a DIFFERENT org → blocked
        assert await same_billing_context("ws-int-a", "ws-int-other-org") is False
        # external → internal → blocked (can't move out of external)
        assert await same_billing_context("ws-ext-a", "ws-int-a") is False
        # internal → external → blocked
        assert await same_billing_context("ws-int-a", "ws-ext-a") is False
        # external → different external → blocked
        assert await same_billing_context("ws-ext-a", "ws-ext-b") is False
    # same workspace → trivially allowed (no account lookup needed)
    assert await same_billing_context("ws-ext-a", "ws-ext-a") is True


@pytest.mark.asyncio
async def test_move_project_blocked_across_billing_context():
    """Moving a project out of an external-client workspace is rejected (403)."""
    from dembrane.api.v2 import projects as proj_mod

    project = {"id": "p-1", "workspace_id": "ws-ext-a", "deleted_at": None}
    target_ws = {"id": "ws-int-a", "deleted_at": None}

    async def fake_get_item(collection, item_id):
        return project if collection == "project" else target_ws

    app = FastAPI()

    async def _fake_auth():
        return DirectusSession(user_id="du-1", is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(proj_mod.router, prefix="/v2/projects")

    with (
        patch.object(
            proj_mod, "get_app_user_or_raise", new=AsyncMock(return_value={"id": "au-1"})
        ),
        patch.object(
            proj_mod.async_directus, "get_item", new=AsyncMock(side_effect=fake_get_item)
        ),
        patch.object(
            proj_mod, "user_can_access", new=AsyncMock(return_value=("admin", "direct"))
        ),
        patch(
            "dembrane.billing_service.same_billing_context",
            new=AsyncMock(return_value=False),
        ),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://t") as client:
            r = await client.post(
                "/v2/projects/p-1/move",
                json={"target_workspace_id": "ws-int-a"},
            )
    assert r.status_code == 403
    assert "context" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_move_project_allowed_same_context():
    """Moving between two workspaces in the same context succeeds."""
    from dembrane.api.v2 import projects as proj_mod

    project = {"id": "p-1", "workspace_id": "ws-int-a", "deleted_at": None}
    target_ws = {"id": "ws-int-b", "deleted_at": None}

    async def fake_get_item(collection, item_id):
        return project if collection == "project" else target_ws

    app = FastAPI()

    async def _fake_auth():
        return DirectusSession(user_id="du-1", is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(proj_mod.router, prefix="/v2/projects")

    with (
        patch.object(
            proj_mod, "get_app_user_or_raise", new=AsyncMock(return_value={"id": "au-1"})
        ),
        patch.object(
            proj_mod.async_directus, "get_item", new=AsyncMock(side_effect=fake_get_item)
        ),
        patch.object(
            proj_mod.async_directus, "update_item", new=AsyncMock(return_value={})
        ),
        patch.object(
            proj_mod, "user_can_access", new=AsyncMock(return_value=("owner", "direct"))
        ),
        patch(
            "dembrane.billing_service.same_billing_context",
            new=AsyncMock(return_value=True),
        ),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://t") as client:
            r = await client.post(
                "/v2/projects/p-1/move",
                json={"target_workspace_id": "ws-int-b"},
            )
    assert r.status_code == 200
    assert r.json()["workspace_id"] == "ws-int-b"


# ── ISSUE-032: usage_context is immutable (not a settings field) ────────


def test_usage_context_not_in_update_request():
    """The internal/external flag is creation-only; it must not be patchable."""
    from dembrane.api.v2.workspace_settings import UpdateWorkspaceRequest

    assert "usage_context" not in UpdateWorkspaceRequest.model_fields
    assert "data_owner_email" not in UpdateWorkspaceRequest.model_fields


# ── ISSUE-032: per-workspace whitelabel is external-only ────────────────


def test_whitelabel_gate_external_only():
    from fastapi import HTTPException as _HTTPExc

    from dembrane.api.v2.workspace_settings import _require_external_for_whitelabel

    def ctx_for(ws: dict):
        return WorkspaceContext(
            workspace_id=ws["id"],
            workspace=ws,
            app_user_id="au-1",
            role="admin",
            custom_policies=[],
            source="direct",
        )

    # Internal workspace → blocked (403).
    with pytest.raises(_HTTPExc) as exc:
        _require_external_for_whitelabel(
            ctx_for({"id": "w", "usage_context": "internal"})
        )
    assert exc.value.status_code == 403
    # External-client workspace → allowed (no raise).
    _require_external_for_whitelabel(ctx_for({"id": "w", "usage_context": "external"}))


# ── Generalization: no bill_separately flag; data owner implies external ─


def test_create_request_has_no_bill_separately_flag():
    """External/separate billing is derived from a named data owner, not a
    boolean (generalized 2026-06-21). The flag must be gone from the contract."""
    from dembrane.api.v2.schemas import CreateWorkspaceRequest

    fields = CreateWorkspaceRequest.model_fields
    assert "bill_separately" not in fields
    assert "data_owner_org_name" in fields
    assert "data_owner_email" in fields
    assert "partner_agreement_accepted" in fields


# ── ISSUE-026 guard: data owner must be external to the org ─────────────


@pytest.mark.asyncio
async def test_data_owner_org_member_check():
    from dembrane.api.v2 import workspaces as ws_mod

    # email maps to an app_user who IS an active member of the org → True (block).
    async def get_items_member(collection, query=None):
        if collection == "app_user":
            return [{"id": "au-x"}]
        return [{"id": "m-1"}]  # org_membership row exists

    with patch.object(ws_mod.async_directus, "get_items", new=AsyncMock(side_effect=get_items_member)):
        assert await ws_mod._is_org_member_by_email("org-1", "x@org.com") is True

    # email has no app_user → not a member.
    async def get_items_no_user(collection, query=None):
        return []

    with patch.object(ws_mod.async_directus, "get_items", new=AsyncMock(side_effect=get_items_no_user)):
        assert await ws_mod._is_org_member_by_email("org-1", "ext@client.com") is False

    # app_user exists but no membership in this org → external, allowed.
    async def get_items_no_membership(collection, query=None):
        return [{"id": "au-x"}] if collection == "app_user" else []

    with patch.object(ws_mod.async_directus, "get_items", new=AsyncMock(side_effect=get_items_no_membership)):
        assert await ws_mod._is_org_member_by_email("org-1", "ext@client.com") is False
