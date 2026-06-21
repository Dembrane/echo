"""Tests for the admin-only workspace data-ownership edit endpoint.

PATCH /v2/workspaces/{id}/data-ownership lets a workspace admin edit the owning
organisation + data-owner contact and reclassify the workspace internal↔external.
A reclassification re-scopes the billing account (so the label and the billing /
data-ownership context stay consistent) and refuses when paid billing is attached.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "du-admin-001"
_APP_USER_ID = "au-admin-001"
_WORKSPACE_ID = "ws-1"
_ORG_ID = "org-1"


def _ctx(workspace: dict, role: str = "admin") -> WorkspaceContext:
    return WorkspaceContext(
        workspace_id=workspace["id"],
        workspace=workspace,
        app_user_id=_APP_USER_ID,
        role=role,
        custom_policies=[],
        source="direct",
    )


def _build_app(ctx: WorkspaceContext) -> FastAPI:
    from dembrane.api.v2.workspace_settings import router

    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    async def _fake_ctx() -> WorkspaceContext:
        return ctx

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.dependency_overrides[get_workspace_context] = _fake_ctx
    app.include_router(router, prefix="/v2/workspaces")
    return app


async def _patch_request(ctx: WorkspaceContext, body: dict):
    app = _build_app(ctx)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as client:
        return await client.patch(
            f"/v2/workspaces/{_WORKSPACE_ID}/data-ownership", json=body
        )


@pytest.mark.asyncio
async def test_non_admin_forbidden():
    """A member (no settings:manage) is refused before any work happens."""
    ws = {"id": _WORKSPACE_ID, "org_id": _ORG_ID, "usage_context": "internal"}
    r = await _patch_request(_ctx(ws, role="member"), {"usage_context": "external"})
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_external_requires_org_and_email():
    """Marking a workspace external without the owning org + email is a 400."""
    ws = {"id": _WORKSPACE_ID, "org_id": _ORG_ID, "usage_context": "internal"}
    r = await _patch_request(
        _ctx(ws), {"usage_context": "external", "partner_agreement_accepted": True}
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_internal_to_external_requires_agreement():
    """internal→external without accepting the partner agreement is a 400."""
    ws = {"id": _WORKSPACE_ID, "org_id": _ORG_ID, "usage_context": "internal"}
    with patch(
        "dembrane.api.v2.workspaces._is_org_member_by_email",
        new=AsyncMock(return_value=False),
    ):
        r = await _patch_request(
            _ctx(ws),
            {
                "usage_context": "external",
                "data_owner_org_name": "Acme Org",
                "data_owner_email": "jane@acme.org",
            },
        )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_external_data_owner_must_be_outside_org():
    """Naming an existing org member as the data owner is a 400 (same as create)."""
    ws = {"id": _WORKSPACE_ID, "org_id": _ORG_ID, "usage_context": "internal"}
    with patch(
        "dembrane.api.v2.workspaces._is_org_member_by_email",
        new=AsyncMock(return_value=True),
    ):
        r = await _patch_request(
            _ctx(ws),
            {
                "usage_context": "external",
                "data_owner_org_name": "Acme Org",
                "data_owner_email": "insider@org-1.com",
                "partner_agreement_accepted": True,
            },
        )
    assert r.status_code == 400
    assert "member of your organisation" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_edit_fields_on_external_no_rescope():
    """Editing org/email on an already-external workspace updates the fields and
    does NOT re-scope billing (no new account created)."""
    ws = {
        "id": _WORKSPACE_ID,
        "org_id": _ORG_ID,
        "usage_context": "external",
        "billing_account_id": "acct-ws",
        "data_owner_org_name": "Old Org",
        "data_owner_email": "old@acme.org",
        "partner_agreement_accepted_at": "2026-01-01T00:00:00Z",
    }
    from dembrane.api.v2 import workspace_settings as mod

    update_mock = AsyncMock(return_value={"data": {}})
    with (
        patch.object(mod.async_directus, "update_item", new=update_mock),
        patch(
            "dembrane.api.v2.workspaces._is_org_member_by_email",
            new=AsyncMock(return_value=False),
        ),
        patch(
            "dembrane.billing_account.create_workspace_scoped_account",
            new=AsyncMock(side_effect=AssertionError("must not re-scope")),
        ),
        patch(
            "dembrane.cache_utils.invalidate_workspace_usage", new=AsyncMock()
        ),
        patch("dembrane.cache_utils.invalidate_org_usage", new=AsyncMock()),
        patch(
            "dembrane.api.v2.workspaces._invite_data_owner_observer", new=AsyncMock()
        ),
    ):
        r = await _patch_request(
            _ctx(ws),
            {
                "data_owner_org_name": "New Org",
                "data_owner_email": "new@acme.org",
            },
        )
    assert r.status_code == 200
    # The workspace row was updated with the new external fields.
    payload = update_mock.await_args_list[-1].args[2]
    assert payload["usage_context"] == "external"
    assert payload["data_owner_org_name"] == "New Org"
    assert payload["data_owner_email"] == "new@acme.org"


@pytest.mark.asyncio
async def test_flip_internal_to_external_free_account():
    """internal→external on a free org account mints a workspace-scoped account
    and re-points the workspace at it."""
    ws = {
        "id": _WORKSPACE_ID,
        "org_id": _ORG_ID,
        "name": "Client Alpha",
        "usage_context": "internal",
        "billing_account_id": "acct-org",
    }
    from dembrane.api.v2 import workspace_settings as mod

    update_mock = AsyncMock(return_value={"data": {}})
    # get_item resolves the old (org) account as free.
    with (
        patch.object(
            mod.async_directus,
            "get_item",
            new=AsyncMock(return_value={"id": "acct-org", "org_id": _ORG_ID, "tier": "free"}),
        ),
        patch.object(mod.async_directus, "update_item", new=update_mock),
        patch(
            "dembrane.api.v2.workspaces._is_org_member_by_email",
            new=AsyncMock(return_value=False),
        ),
        patch(
            "dembrane.billing_account.create_workspace_scoped_account",
            new=AsyncMock(return_value="acct-new"),
        ),
        patch("dembrane.billing_account.link_account_to_workspace", new=AsyncMock()),
        patch("dembrane.billing_service.reconcile_account_seats", new=AsyncMock()),
        patch("dembrane.cache_utils.invalidate_workspace_usage", new=AsyncMock()),
        patch("dembrane.cache_utils.invalidate_org_usage", new=AsyncMock()),
        patch(
            "dembrane.api.v2.workspaces._invite_data_owner_observer", new=AsyncMock()
        ),
    ):
        r = await _patch_request(
            _ctx(ws),
            {
                "usage_context": "external",
                "data_owner_org_name": "Acme Org",
                "data_owner_email": "jane@acme.org",
                "partner_agreement_accepted": True,
            },
        )
    assert r.status_code == 200
    # The workspace was re-pointed at the new workspace-scoped account.
    repoints = [
        c.args[2]
        for c in update_mock.await_args_list
        if c.args[0] == "workspace" and c.args[2].get("billing_account_id") == "acct-new"
    ]
    assert repoints, "workspace should be re-pointed at the new account"


@pytest.mark.asyncio
async def test_flip_blocked_when_paid():
    """A paid/active billing account blocks reclassification (409)."""
    ws = {
        "id": _WORKSPACE_ID,
        "org_id": _ORG_ID,
        "usage_context": "internal",
        "billing_account_id": "acct-org",
    }
    from dembrane.api.v2 import workspace_settings as mod

    with (
        patch.object(
            mod.async_directus,
            "get_item",
            new=AsyncMock(
                return_value={"id": "acct-org", "org_id": _ORG_ID, "tier": "changemaker"}
            ),
        ),
        patch(
            "dembrane.api.v2.workspaces._is_org_member_by_email",
            new=AsyncMock(return_value=False),
        ),
    ):
        r = await _patch_request(
            _ctx(ws),
            {
                "usage_context": "external",
                "data_owner_org_name": "Acme Org",
                "data_owner_email": "jane@acme.org",
                "partner_agreement_accepted": True,
            },
        )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_flip_external_to_internal_free_account():
    """external→internal on a free workspace-scoped account moves the workspace
    onto the org's pooled account, clears the data owner, and retires the old
    account."""
    ws = {
        "id": _WORKSPACE_ID,
        "org_id": _ORG_ID,
        "usage_context": "external",
        "billing_account_id": "acct-ws",
        "data_owner_email": "jane@acme.org",
        "data_owner_org_name": "Acme Org",
    }
    from dembrane.api.v2 import workspace_settings as mod

    update_mock = AsyncMock(return_value={"data": {}})
    # First get_item → old (workspace-scoped) account (free); later → org account
    # for the blocks-new-workspace check.
    get_item_mock = AsyncMock(
        side_effect=[
            {"id": "acct-ws", "org_id": None, "tier": "free"},
            {"id": "acct-org", "org_id": _ORG_ID, "tier": "free"},
        ]
    )
    with (
        patch.object(mod.async_directus, "get_item", new=get_item_mock),
        patch.object(mod.async_directus, "update_item", new=update_mock),
        patch(
            "dembrane.billing_account.org_account_for_new_workspace",
            new=AsyncMock(return_value="acct-org"),
        ),
        patch("dembrane.billing_service.reconcile_account_seats", new=AsyncMock()),
        patch("dembrane.cache_utils.invalidate_workspace_usage", new=AsyncMock()),
        patch("dembrane.cache_utils.invalidate_org_usage", new=AsyncMock()),
    ):
        r = await _patch_request(_ctx(ws), {"usage_context": "internal"})
    assert r.status_code == 200
    # The final workspace update clears the data-owner fields and sets internal.
    ws_payloads = [c.args[2] for c in update_mock.await_args_list if c.args[0] == "workspace"]
    final = ws_payloads[-1]
    assert final["usage_context"] == "internal"
    assert final["data_owner_email"] is None
    assert final["data_owner_org_name"] is None
    # The old workspace-scoped account was retired (soft-deleted).
    retired = [
        c.args[2]
        for c in update_mock.await_args_list
        if c.args[0] == "billing_account" and c.args[2].get("deleted_at")
    ]
    assert retired, "old workspace-scoped account should be retired"
