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
