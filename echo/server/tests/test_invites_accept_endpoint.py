"""Tests for POST /v2/me/invites/accept-by-hash with org-only support
and multi-pending consume (ADR 0004).

Covers:
    - Org-only invite acceptance creates org_membership and returns type='org'.
    - Workspace invite acceptance still works (regression).
    - Multi-pending consume: accepting one invite marks every other pending
      invite for (email, org_id) accepted in the same request.
    - Hash mismatch → 404.
"""

from __future__ import annotations

import hmac
import hashlib
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.me import router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "du-bob"
_APP_USER_ID = "au-bob"
_EMAIL = "bob@example.com"
_APP_USER = {"id": _APP_USER_ID, "email": _EMAIL, "display_name": "Bob"}
_ORG_ID = "org-001"
_ORG_ROW = {"id": _ORG_ID, "name": "Acme", "deleted_at": None}
_WS_ID = "ws-001"
_WS_ROW = {
    "id": _WS_ID,
    "name": "Engineering",
    "org_id": _ORG_ID,
    "tier": "pioneer",
    "deleted_at": None,
}


def _invite_hash(invite_id: str) -> str:
    """Mirror server-side compute_invite_hash for test setup. Settings
    fixture ensures the same secret is used at lookup time."""
    from dembrane.settings import get_settings

    secret = get_settings().directus.secret.encode()
    return hmac.new(secret, invite_id.encode(), hashlib.sha256).hexdigest()[:32]


def _build_app(auth_user_id: str = _USER_ID) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=auth_user_id, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/me")
    return app


def _noop_rate_limiter() -> AsyncMock:
    rl = AsyncMock()
    rl.check = AsyncMock(return_value=None)
    return rl


@pytest.fixture(autouse=True)
def _patch_rate_limiter():
    with patch("dembrane.api.v2.me._accept_rate_limiter", _noop_rate_limiter()):
        yield


@pytest.fixture(autouse=True)
def _patch_side_effects():
    """The workspace-invite acceptance path fires notifications, seat-cap
    checks, and cache invalidation as side effects. Tests that don't
    explicitly set their own behaviour for these need them no-op'd, or
    else a real notification emit / cap query escapes the test
    (AttributeError on the AsyncMock, or a 402 from a real cap query).
    Individual tests can still override (`assert_can_add_seat` cap test
    sets a side_effect on its own patch context, which stacks on top).
    """
    with (
        patch("dembrane.api.v2.me.assert_can_add_seat", new_callable=AsyncMock),
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
        patch(
            "dembrane.cache_utils.invalidate_workspace_and_org_usage",
            new_callable=AsyncMock,
        ),
    ):
        yield


@pytest.mark.asyncio
async def test_accept_org_invite_creates_org_membership():
    """Hash matches a pending org_invite → org_membership row created,
    response carries type='org'."""
    invite_id = "oi-1"
    h = _invite_hash(invite_id)

    org_invite_row = {
        "id": invite_id,
        "org_id": _ORG_ID,
        "email": _EMAIL,
        "role": "member",
        "accepted_at": None,
        "deleted_at": None,
        "expires_at": "2099-01-01T00:00:00Z",
    }

    mock = AsyncMock()

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "workspace_invite":
            return []
        if collection == "org_invite":
            return [org_invite_row]
        if collection == "org_membership":
            return []
        if collection == "workspace":
            return []
        return []

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(side_effect=lambda col, _id: _ORG_ROW if col == "org" else None)
    mock.create_item = AsyncMock(return_value={"data": {"id": "new"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": h, "claimed_role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["type"] == "org"
    assert body["org_id"] == _ORG_ID
    assert body["org_name"] == "Acme"
    assert body["status"] == "success"

    om_creates = [c.args for c in mock.create_item.call_args_list if c.args[0] == "org_membership"]
    assert len(om_creates) == 1
    assert om_creates[0][1]["org_id"] == _ORG_ID
    assert om_creates[0][1]["user_id"] == _APP_USER_ID
    assert om_creates[0][1]["role"] == "member"

    # Originating org_invite marked accepted.
    oi_updates = [u.args for u in mock.update_item.call_args_list if u.args[0] == "org_invite"]
    assert any(u[1] == invite_id for u in oi_updates)


@pytest.mark.asyncio
async def test_accept_workspace_invite_still_works():
    """Regression: workspace invite acceptance creates workspace_membership."""
    invite_id = "wi-1"
    h = _invite_hash(invite_id)

    ws_invite_row = {
        "id": invite_id,
        "email": _EMAIL,
        "workspace_id": _WS_ID,
        "role": "member",
    }

    # Existing org_membership so we skip the org-membership write.
    org_mem_row = {"id": "om-existing", "role": "member", "deleted_at": None}

    state = {"workspace_membership_calls": 0}

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "workspace_invite":
            return [ws_invite_row]
        if collection == "org_invite":
            return []
        if collection == "org_membership":
            return [org_mem_row]
        if collection == "workspace_membership":
            state["workspace_membership_calls"] += 1
            return []  # Always "not a member yet"
        if collection == "workspace":
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(side_effect=lambda col, _id: _WS_ROW if col == "workspace" else None)
    mock.create_item = AsyncMock(return_value={"data": {"id": "new"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": h, "claimed_role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["type"] == "workspace"
    assert body["workspace_id"] == _WS_ID
    assert body["status"] == "success"

    wm_creates = [
        c.args for c in mock.create_item.call_args_list if c.args[0] == "workspace_membership"
    ]
    assert len(wm_creates) == 1


@pytest.mark.asyncio
async def test_accept_org_invite_consumes_other_pending_invites_in_org():
    """Multi-pending consume: accepting an org_invite for (email, org) also
    marks every other pending invite for the same (email, org) accepted."""
    org_invite_id = "oi-main"
    h = _invite_hash(org_invite_id)

    org_invite_row = {
        "id": org_invite_id,
        "org_id": _ORG_ID,
        "email": _EMAIL,
        "role": "member",
        "accepted_at": None,
        "deleted_at": None,
        "expires_at": "2099-01-01T00:00:00Z",
    }

    # A second pending workspace_invite for the same email in the same org —
    # the consume sweep must mark this one accepted and create its
    # workspace_membership. Includes the full row shape (accepted_at /
    # deleted_at / expires_at) so the sweep code can't silently KeyError
    # or None-compare its way past a missing field.
    ws_invite_row = {
        "id": "wi-other",
        "workspace_id": _WS_ID,
        "role": "member",
        "accepted_at": None,
        "deleted_at": None,
        "expires_at": "2099-01-01T00:00:00Z",
    }

    state = {"workspace_query_count": 0}

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "workspace_invite":
            # First call (main accept) finds nothing; second call (inside
            # _consume_pending_invites_in_org) returns the other invite.
            state["workspace_query_count"] += 1
            if state["workspace_query_count"] == 1:
                return []
            return [ws_invite_row]
        if collection == "org_invite":
            return [org_invite_row]
        if collection == "org_membership":
            return []
        if collection == "workspace":
            return [{"id": _WS_ID}]
        if collection == "workspace_membership":
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)

    # The sweep fetches the workspace row via get_item to run the race-
    # protection cap check. Return _WS_ROW for "workspace" so the cap
    # gate passes and the sweep proceeds; _ORG_ROW for "org".
    async def _fake_get_item(col: str, _id: str) -> Any:
        if col == "org":
            return _ORG_ROW
        if col == "workspace":
            return _WS_ROW
        return None

    mock.get_item = AsyncMock(side_effect=_fake_get_item)
    mock.create_item = AsyncMock(return_value={"data": {"id": "new"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": h, "claimed_role": "member"},
            )

    assert resp.status_code == 200, resp.text

    # Originating org_invite marked accepted, AND the other workspace_invite
    # was marked accepted in the same request (multi-consume).
    update_collections_to_ids = [(u.args[0], u.args[1]) for u in mock.update_item.call_args_list]
    assert ("org_invite", org_invite_id) in update_collections_to_ids
    assert ("workspace_invite", "wi-other") in update_collections_to_ids

    # The other invite's workspace_membership was also created during consume.
    wm_creates = [
        c.args for c in mock.create_item.call_args_list if c.args[0] == "workspace_membership"
    ]
    assert len(wm_creates) == 1
    assert wm_creates[0][1]["workspace_id"] == _WS_ID


@pytest.mark.asyncio
async def test_accept_hash_mismatch_returns_not_found():
    """No invite matches the hash in either table → 404."""

    mock = AsyncMock()

    async def _fake_get_items(_collection: str, _params: dict) -> Any:
        return []  # Nothing pending in either table.

    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(return_value=None)
    mock.create_item = AsyncMock(return_value={"data": {"id": "x"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": "deadbeef" * 4, "claimed_role": "member"},
            )

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_accept_org_invite_idempotent_already_member():
    """Existing active org_membership → status='already_member'; no new
    org_membership row is created."""
    invite_id = "oi-dup"
    h = _invite_hash(invite_id)

    org_invite_row = {
        "id": invite_id,
        "org_id": _ORG_ID,
        "email": _EMAIL,
        "role": "member",
        "accepted_at": None,
        "deleted_at": None,
        "expires_at": "2099-01-01T00:00:00Z",
    }
    existing_active_org_mem = [{"id": "om-1", "role": "member", "deleted_at": None}]

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "workspace_invite":
            return []
        if collection == "org_invite":
            return [org_invite_row]
        if collection == "org_membership":
            return existing_active_org_mem
        if collection == "workspace":
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(side_effect=lambda col, _id: _ORG_ROW if col == "org" else None)
    mock.create_item = AsyncMock(return_value={"data": {"id": "new"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": h, "claimed_role": "member"},
            )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "already_member"
    assert body["type"] == "org"

    om_creates = [c.args for c in mock.create_item.call_args_list if c.args[0] == "org_membership"]
    assert om_creates == [], "No new org_membership should be created when already a member"


# ── deleted_at / expired / mismatch / cap regression coverage ─────────────


@pytest.mark.asyncio
async def test_accept_revoked_org_invite_returns_not_found():
    """Revoked org_invite must 404. Mock returns the revoked row unless the
    filter pins deleted_at:_null, so dropping that filter fails the test."""
    invite_id = "oi-revoked"
    h = _invite_hash(invite_id)

    revoked_row = {
        "id": invite_id,
        "org_id": _ORG_ID,
        "email": _EMAIL,
        "role": "member",
        "accepted_at": None,
        "deleted_at": "2099-01-01T00:00:00Z",
        "expires_at": "2099-01-01T00:00:00Z",
    }

    seen_filters: dict[str, dict[str, Any]] = {}

    async def _fake_get_items(collection: str, params: dict) -> Any:
        filt = (params.get("query") or {}).get("filter") or {}
        seen_filters[collection] = filt
        if collection == "org_invite":
            if filt.get("deleted_at") == {"_null": True}:
                return []
            return [revoked_row]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(return_value=None)
    mock.create_item = AsyncMock(return_value={"data": {"id": "x"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": h, "claimed_role": "member"},
            )

    assert resp.status_code == 404
    assert not any(
        c.args[0] in {"org_membership", "workspace_membership"}
        for c in mock.create_item.call_args_list
    )
    assert seen_filters.get("org_invite", {}).get("deleted_at") == {"_null": True}, (
        "accept-by-hash must filter org_invite by deleted_at:_null so revoked invites can't be accepted"
    )


@pytest.mark.asyncio
async def test_accept_expired_invite_returns_not_found():
    """Expired workspace_invite must 404. Mock returns the expired row unless
    the filter pins expires_at:_gt:now, so dropping that filter fails the test."""
    invite_id = "wi-expired"
    h = _invite_hash(invite_id)

    expired_row = {
        "id": invite_id,
        "workspace_id": _WS_ID,
        "email": _EMAIL,
        "role": "member",
        "accepted_at": None,
        "deleted_at": None,
        "expires_at": "2000-01-01T00:00:00Z",
    }

    seen_filters: dict[str, dict[str, Any]] = {}

    async def _fake_get_items(collection: str, params: dict) -> Any:
        filt = (params.get("query") or {}).get("filter") or {}
        seen_filters[collection] = filt
        if collection == "workspace_invite":
            if "_gt" in (filt.get("expires_at") or {}):
                return []
            return [expired_row]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(return_value=None)
    mock.create_item = AsyncMock(return_value={"data": {"id": "x"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": h, "claimed_role": "member"},
            )

    assert resp.status_code == 404
    assert not any(
        c.args[0] in {"org_membership", "workspace_membership"}
        for c in mock.create_item.call_args_list
    )
    assert "_gt" in (seen_filters.get("workspace_invite", {}).get("expires_at") or {}), (
        "accept-by-hash must filter workspace_invite by expires_at:_gt:now so expired invites can't be accepted"
    )


@pytest.mark.asyncio
async def test_accept_workspace_invite_consumes_parallel_org_invite():
    """Reverse direction of the multi-pending consume: accepting a
    workspace_invite must also mark a parallel pending org_invite for
    the same (email, org) accepted. ADR 0004 doesn't qualify the
    direction."""
    ws_invite_id = "wi-main"
    h = _invite_hash(ws_invite_id)

    ws_invite_row = {
        "id": ws_invite_id,
        "email": _EMAIL,
        "workspace_id": _WS_ID,
        "role": "member",
        "accepted_at": None,
        "deleted_at": None,
        "expires_at": "2099-01-01T00:00:00Z",
    }
    parallel_org_invite = {
        "id": "oi-parallel",
        "org_id": _ORG_ID,
        "email": _EMAIL,
        "role": "member",
        "accepted_at": None,
        "deleted_at": None,
        "expires_at": "2099-01-01T00:00:00Z",
    }

    state = {"ws_query_count": 0, "org_query_count": 0}

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "workspace_invite":
            state["ws_query_count"] += 1
            # First call: main accept finds this row. Sweep inside
            # _consume_pending_invites_in_org finds nothing else.
            return [ws_invite_row] if state["ws_query_count"] == 1 else []
        if collection == "org_invite":
            state["org_query_count"] += 1
            # accept-by-hash queries org_invite ONLY when the workspace_invite
            # probe fails to match the hash. Since this test matches the
            # workspace path, the org_invite query count starts at 0 and
            # the sweep (inside _consume_pending_invites_in_org) is the
            # only org_invite call — so any call (count >= 1) should return
            # the parallel row.
            return [parallel_org_invite] if state["org_query_count"] >= 1 else []
        if collection == "org_membership":
            return []
        if collection == "workspace":
            return [{"id": _WS_ID}]
        if collection == "workspace_membership":
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(side_effect=lambda col, _id: _WS_ROW if col == "workspace" else None)
    mock.create_item = AsyncMock(return_value={"data": {"id": "new"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": h, "claimed_role": "member"},
            )

    assert resp.status_code == 200, resp.text

    update_pairs = [(u.args[0], u.args[1]) for u in mock.update_item.call_args_list]
    assert ("workspace_invite", ws_invite_id) in update_pairs
    # Parallel org_invite consumed in the same request.
    assert ("org_invite", "oi-parallel") in update_pairs


@pytest.mark.asyncio
async def test_accept_workspace_invite_blocks_at_seat_cap():
    """Seat-cap exceeded → 402; no workspace_membership created. Cap
    check runs BEFORE accepted_at is set so the link is retryable."""
    from fastapi import HTTPException

    invite_id = "wi-cap"
    h = _invite_hash(invite_id)

    ws_invite_row = {
        "id": invite_id,
        "email": _EMAIL,
        "workspace_id": _WS_ID,
        "role": "member",
    }

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "workspace_invite":
            return [ws_invite_row]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(side_effect=lambda col, _id: _WS_ROW if col == "workspace" else None)
    mock.create_item = AsyncMock(return_value={"data": {"id": "x"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    cap_exception = HTTPException(status_code=402, detail="Seat cap reached")

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.me.assert_can_add_seat",
            new_callable=AsyncMock,
            side_effect=cap_exception,
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": h, "claimed_role": "member"},
            )

    assert resp.status_code == 402
    # No row should have been written — admin can free a seat and the user retries.
    assert not any(
        c.args[0] == "workspace_membership" for c in mock.create_item.call_args_list
    )
    assert not any(u.args[0] == "workspace_invite" for u in mock.update_item.call_args_list)


# ── inspect-by-hash: revoked invite must probe as not_found ─────────────


@pytest.mark.asyncio
async def test_inspect_by_hash_revoked_workspace_invite_is_not_found():
    """GET /v2/me/invites/by-hash on a revoked workspace_invite must not
    leak the existence of the cancelled invite. The query-level filter
    (`deleted_at:_null`) excludes revoked rows; this test pins that
    contract so a future change re-introducing the bug fails loudly.
    Regression site: me.py:577 in the retrofit checklist."""
    h = _invite_hash("wi-revoked")

    seen_ws_filter: dict[str, Any] = {}

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "workspace_invite":
            seen_ws_filter.update(params.get("query", {}).get("filter", {}))
        return []  # Filter excludes the revoked row → empty result for both tables.

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(return_value=None)

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/me/invites/by-hash?h={h}")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "not_found"
    # Pin the filter shape.
    assert seen_ws_filter.get("deleted_at") == {"_null": True}, (
        "inspect-by-hash must filter workspace_invite by deleted_at:_null "
        "so revoked invites don't probe as pending"
    )


@pytest.mark.asyncio
async def test_inspect_by_hash_revoked_org_invite_is_not_found():
    """Same regression as the workspace_invite case, for org_invite.
    Filter-based exclusion plus the in-function `deleted_at` guard at
    me.py:902 — the test catches either failing."""
    h = _invite_hash("oi-revoked")

    seen_org_filter: dict[str, Any] = {}

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "org_invite":
            seen_org_filter.update(params.get("query", {}).get("filter", {}))
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(return_value=None)

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(f"/v2/me/invites/by-hash?h={h}")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "not_found"
    assert seen_org_filter.get("deleted_at") == {"_null": True}, (
        "inspect-by-hash must filter org_invite by deleted_at:_null"
    )


@pytest.mark.asyncio
async def test_accept_workspace_already_member_consumes_parallel_org_invite():
    """Regression: when accept-by-hash hits the already_member fast path
    (user accepted the workspace invite but a parallel org_invite is
    still pending in the same org), the multi-pending sweep must still
    run before returning. Otherwise the org_invite is stranded — the
    ADR-0004 per-org sweep semantics break the moment one row was
    already-consumed."""
    ws_invite_id = "wi-already-member"
    h = _invite_hash(ws_invite_id)

    # Workspace_invite was already accepted on a previous request, but
    # the parallel org_invite is still pending.
    ws_invite_row = {
        "id": ws_invite_id,
        "email": _EMAIL,
        "workspace_id": _WS_ID,
        "role": "member",
        "accepted_at": "2026-05-30T00:00:00Z",
        "deleted_at": None,
        "expires_at": "2099-01-01T00:00:00Z",
    }
    parallel_org_invite = {
        "id": "oi-stranded",
        "org_id": _ORG_ID,
        "email": _EMAIL,
        "role": "member",
        "accepted_at": None,
        "deleted_at": None,
        "expires_at": "2099-01-01T00:00:00Z",
    }

    async def _fake_get_items(collection: str, params: dict) -> Any:
        if collection == "workspace_invite":
            # Distinguish pending probe (accepted_at:_null filter) from
            # the "fallback heal" probe that scans by email only. The
            # already_member branch lives inside the fallback path.
            filter_ = params.get("query", {}).get("filter", {})
            if filter_.get("accepted_at") == {"_null": True}:
                return []  # No live pending; pushes into fallback.
            return [ws_invite_row]
        if collection == "org_invite":
            # Both the pending-probe in accept-by-hash AND the sweep
            # inside _consume_pending_invites_in_org hit this collection.
            # Returning the parallel row in both cases is safe: the
            # pending probe matches by hash (which won't match this row),
            # so it just falls through to the workspace fallback. The
            # sweep is the call we actually care about.
            return [parallel_org_invite]
        if collection == "workspace_membership":
            # Already a member of the workspace.
            return [{"id": "wm-existing"}]
        if collection == "workspace":
            return [{"id": _WS_ID, "org_id": _ORG_ID, "deleted_at": None}]
        if collection == "org_membership":
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_fake_get_items)
    mock.get_item = AsyncMock(
        side_effect=lambda col, _id: _WS_ROW if col == "workspace" else None
    )
    mock.create_item = AsyncMock(return_value={"data": {"id": "new"}})
    mock.update_item = AsyncMock(return_value={"data": {}})

    with (
        patch("dembrane.api.v2.me.async_directus", mock),
        patch("dembrane.api.v2.me.get_app_user_or_raise", return_value=_APP_USER),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/me/invites/accept-by-hash",
                json={"hash": h, "claimed_role": "member"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("status") == "already_member", body

    # The parallel org_invite must have been marked accepted by the
    # sweep — without the fix, this update_item never fires.
    update_pairs = [(u.args[0], u.args[1]) for u in mock.update_item.call_args_list]
    assert ("org_invite", "oi-stranded") in update_pairs, (
        f"already_member branch failed to consume parallel org_invite. "
        f"Updates seen: {update_pairs}"
    )
