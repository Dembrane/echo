"""Tests for GET /v2/orgs/:id/pending-invites — union of org_invite +
workspace_invite (ADR 0004 issue 4)."""

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
_APP_USER = {"id": _APP_USER_ID, "email": "admin@example.com", "display_name": "Org Admin"}
_ORG_ID = "org-001"
_WS_A = {"id": "ws-a", "name": "Alpha"}
_WS_B = {"id": "ws-b", "name": "Beta"}


def _build_app(auth_user_id: str = _USER_ID) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=auth_user_id, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/orgs")
    return app


def _make_directus_mock(
    *,
    caller_role: str = "admin",
    workspaces: list[dict] | None = None,
    org_invites: list[dict] | None = None,
    workspace_invites: list[dict] | None = None,
    inviters: list[dict] | None = None,
) -> AsyncMock:
    mock = AsyncMock()

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "org_membership":
            # _require_org_role caller check.
            return [{"role": caller_role}]
        if collection == "workspace":
            return workspaces if workspaces is not None else [_WS_A, _WS_B]
        if collection == "org_invite":
            return org_invites or []
        if collection == "workspace_invite":
            # honor _in filter on workspace_id so the ?workspace_id= path
            # test can isolate a single workspace's rows.
            wid_filter = params.get("query", {}).get("filter", {}).get("workspace_id", {})
            wanted = set(wid_filter.get("_in", []))
            base = workspace_invites or []
            if wanted:
                return [r for r in base if r.get("workspace_id") in wanted]
            return base
        if collection == "app_user":
            return inviters or []
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(return_value=None)
    return mock


@pytest.mark.asyncio
async def test_unions_org_and_workspace_invites_sorted_desc():
    """Both tables surface, sorted by created_at DESC, with type field set."""
    org_inv = {
        "id": "oi-1",
        "email": "a@x.com",
        "role": "member",
        "created_at": "2026-05-01T10:00:00Z",
        "expires_at": "2026-05-08T10:00:00Z",
        "invited_by": _APP_USER_ID,
    }
    ws_inv = {
        "id": "wi-1",
        "email": "b@x.com",
        "role": "admin",
        "workspace_id": "ws-a",
        "created_at": "2026-05-02T10:00:00Z",
        "expires_at": "2026-05-09T10:00:00Z",
        "invited_by": _APP_USER_ID,
    }

    mock = _make_directus_mock(
        org_invites=[org_inv],
        workspace_invites=[ws_inv],
        inviters=[{"id": _APP_USER_ID, "display_name": "Org Admin", "email": "admin@example.com"}],
    )

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/orgs/{_ORG_ID}/pending-invites")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 2
    # ws_inv has the later created_at so it sorts first.
    assert body[0]["id"] == "wi-1"
    assert body[0]["type"] == "workspace"
    assert body[0]["workspace_id"] == "ws-a"
    assert body[0]["workspace_name"] == "Alpha"
    assert body[1]["id"] == "oi-1"
    assert body[1]["type"] == "org"
    assert body[1]["workspace_id"] is None
    assert body[1]["workspace_name"] is None
    assert body[0]["invited_by_name"] == "Org Admin"
    assert body[0]["invited_by_email"] == "admin@example.com"


@pytest.mark.asyncio
async def test_workspace_filter_excludes_org_invites_and_other_workspaces():
    """?workspace_id=ws-a returns only ws-a workspace_invites, no org-typed."""
    org_inv = {
        "id": "oi-1",
        "email": "a@x.com",
        "role": "member",
        "created_at": "2026-05-01T10:00:00Z",
        "expires_at": "2026-05-08T10:00:00Z",
        "invited_by": _APP_USER_ID,
    }
    ws_a = {
        "id": "wi-a",
        "email": "in-a@x.com",
        "role": "member",
        "workspace_id": "ws-a",
        "created_at": "2026-05-02T10:00:00Z",
        "expires_at": "2026-05-09T10:00:00Z",
        "invited_by": _APP_USER_ID,
    }
    ws_b = {
        "id": "wi-b",
        "email": "in-b@x.com",
        "role": "member",
        "workspace_id": "ws-b",
        "created_at": "2026-05-03T10:00:00Z",
        "expires_at": "2026-05-10T10:00:00Z",
        "invited_by": _APP_USER_ID,
    }

    mock = _make_directus_mock(
        org_invites=[org_inv],
        workspace_invites=[ws_a, ws_b],
    )

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(
                f"/v2/orgs/{_ORG_ID}/pending-invites", params={"workspace_id": "ws-a"}
            )

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == "wi-a"
    assert body[0]["type"] == "workspace"


@pytest.mark.asyncio
async def test_unknown_workspace_id_returns_empty():
    """?workspace_id pointing to a workspace outside the org returns []."""
    mock = _make_directus_mock(
        workspaces=[_WS_A],
        workspace_invites=[
            {
                "id": "wi-x",
                "email": "x@x.com",
                "role": "member",
                "workspace_id": "ws-a",
                "created_at": "2026-05-02T10:00:00Z",
                "expires_at": "2026-05-09T10:00:00Z",
                "invited_by": _APP_USER_ID,
            }
        ],
    )

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(
                f"/v2/orgs/{_ORG_ID}/pending-invites",
                params={"workspace_id": "ws-elsewhere"},
            )

    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_non_admin_caller_is_forbidden():
    """Only org admins/owners may list pending invites."""
    mock = _make_directus_mock(caller_role="member")

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/orgs/{_ORG_ID}/pending-invites")

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_empty_when_no_invites():
    """No org_invite + no workspace_invite rows → empty list."""
    mock = _make_directus_mock()
    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/orgs/{_ORG_ID}/pending-invites")

    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_rows_include_invite_url_with_matching_hash():
    """Every row carries an invite_url whose h param equals
    compute_invite_hash(row id), for both org and workspace rows."""
    from urllib.parse import parse_qs, urlparse

    from dembrane.api.v2.invites import compute_invite_hash

    org_inv = {
        "id": "oi-1",
        "email": "a@x.com",
        "role": "member",
        "created_at": "2026-05-01T10:00:00Z",
        "expires_at": "2026-05-08T10:00:00Z",
        "invited_by": _APP_USER_ID,
    }
    ws_inv = {
        "id": "wi-1",
        "email": "b@x.com",
        "role": "admin",
        "workspace_id": "ws-a",
        "created_at": "2026-05-02T10:00:00Z",
        "expires_at": "2026-05-09T10:00:00Z",
        "invited_by": _APP_USER_ID,
    }
    mock = _make_directus_mock(
        org_invites=[org_inv],
        workspace_invites=[ws_inv],
        inviters=[{"id": _APP_USER_ID, "display_name": "Org Admin", "email": "admin@example.com"}],
    )
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: {"id": _ORG_ID, "name": "Acme Org"} if col == "org" else None
    )

    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/orgs/{_ORG_ID}/pending-invites")

    assert resp.status_code == 200, resp.text
    by_id = {r["id"]: r for r in resp.json()}

    ws_url = by_id["wi-1"]["invite_url"]
    assert "/invite/accept" in ws_url
    assert parse_qs(urlparse(ws_url).query)["h"][0] == compute_invite_hash("wi-1")
    assert parse_qs(urlparse(ws_url).query)["ws"][0] == "Alpha"

    org_url = by_id["oi-1"]["invite_url"]
    assert "/invite/accept" in org_url
    assert parse_qs(urlparse(org_url).query)["h"][0] == compute_invite_hash("oi-1")
    assert parse_qs(urlparse(org_url).query)["org"][0] == "Acme Org"


@pytest.mark.asyncio
async def test_query_excludes_soft_deleted_expired_and_accepted_rows():
    """Pin the filter contract: both invite tables must be queried with
    accepted_at:_null, deleted_at:_null, and expires_at:_gt:now. If
    any of those filters silently disappears, revoked/expired/accepted
    invites leak into the pending listing — the retrofit checklist
    calls this exact regression out."""
    mock = _make_directus_mock(org_invites=[], workspace_invites=[])
    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/orgs/{_ORG_ID}/pending-invites")

    assert resp.status_code == 200

    def _filter_for(collection: str) -> dict:
        for c in mock.get_items.call_args_list:
            if c.args[0] == collection:
                return c.args[1].get("query", {}).get("filter", {})
        raise AssertionError(f"No get_items call for {collection}")

    for collection in ("org_invite", "workspace_invite"):
        f = _filter_for(collection)
        assert f.get("accepted_at") == {"_null": True}, (
            f"{collection} query is missing accepted_at filter — accepted "
            f"invites would leak into the pending list"
        )
        assert f.get("deleted_at") == {"_null": True}, (
            f"{collection} query is missing deleted_at filter — revoked "
            f"invites would leak (security regression)"
        )
        assert "_gt" in f.get("expires_at", {}), (
            f"{collection} query is missing expires_at:_gt filter — expired invites would leak"
        )
