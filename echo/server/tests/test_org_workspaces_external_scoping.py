"""GET /v2/orgs/:id/workspaces scopes external-only callers to their direct workspaces."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.orgs import router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "du-1"
_APP_USER = {"id": "au-1", "email": "u@example.com", "display_name": "U"}
_ORG_ID = "org-1"
_WS_MINE = {
    "id": "ws-mine",
    "name": "Mine",
    "tier": "guardian",
    "is_default": False,
    "settings": {},
}
_WS_OTHER = {
    "id": "ws-other",
    "name": "Other",
    "tier": "guardian",
    "is_default": False,
    "settings": {},
}


def _build_app() -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/orgs")
    return app


def _mock() -> AsyncMock:
    """Caller has org_membership=member (stale) and a direct membership only in ws-mine."""

    async def get_items(collection: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        query = params.get("query", {})
        filt = query.get("filter", {})
        if collection == "org_membership":
            return [{"role": "member"}]
        if collection == "workspace_membership":
            if query.get("aggregate"):
                return [{"workspace_id": "ws-mine", "count": {"id": 1}}]
            return [{"workspace_id": "ws-mine"}]
        if collection == "workspace":
            id_filter = (filt.get("id") or {}).get("_in")
            if id_filter is not None:
                return [w for w in (_WS_MINE, _WS_OTHER) if w["id"] in id_filter]
            return [_WS_MINE, _WS_OTHER]
        if collection == "project":
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=get_items)
    return mock


@pytest.mark.asyncio
async def test_external_only_caller_sees_only_direct_workspaces():
    mock = _mock()
    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", AsyncMock(return_value=_APP_USER)),
        patch("dembrane.api.v2.orgs.is_org_external_only", AsyncMock(return_value=True)),
        patch("dembrane.api.v2.orgs.get_capacity", lambda *_a, **_k: None),
        # Seat usage is computed for every workspace now (so paid tiers don't
        # show "0 seats"); stub the seat helpers so this scoping test stays
        # data-layer independent.
        patch(
            "dembrane.api.v2.orgs.compute_effective_seat_state",
            AsyncMock(return_value=(0, 0, 0)),
        ),
        patch(
            "dembrane.seat_capacity.count_pending_invites",
            AsyncMock(return_value=(0, 0)),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/workspaces")
    assert res.status_code == 200
    ids = [w["id"] for w in res.json()]
    assert ids == ["ws-mine"]


@pytest.mark.asyncio
async def test_real_member_still_sees_full_list():
    mock = _mock()
    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", AsyncMock(return_value=_APP_USER)),
        patch("dembrane.api.v2.orgs.is_org_external_only", AsyncMock(return_value=False)),
        patch("dembrane.api.v2.orgs.get_capacity", lambda *_a, **_k: None),
        patch(
            "dembrane.api.v2.orgs.compute_effective_seat_state",
            AsyncMock(return_value=(0, 0, 0)),
        ),
        patch(
            "dembrane.seat_capacity.count_pending_invites",
            AsyncMock(return_value=(0, 0)),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/workspaces")
    assert res.status_code == 200
    ids = sorted(w["id"] for w in res.json())
    assert ids == ["ws-mine", "ws-other"]


@pytest.mark.asyncio
async def test_paid_tier_reports_live_seat_count():
    """Tester bug #6: paid (uncapped) workspaces must report their real seat
    usage, not 0. Before the fix the seat block only ran for capped tiers
    (Free), so guardian/changemaker always returned seats_used=0 and the invite
    modal showed '0 seats'. seat_cap stays null on an unlimited tier."""
    mock = _mock()
    with (
        patch("dembrane.api.v2.orgs.async_directus", mock),
        patch("dembrane.api.v2.orgs.get_app_user_or_raise", AsyncMock(return_value=_APP_USER)),
        patch("dembrane.api.v2.orgs.is_org_external_only", AsyncMock(return_value=False)),
        # Real capacity lookup: guardian has included_seats=None (unlimited).
        patch(
            "dembrane.api.v2.orgs.compute_effective_seat_state",
            AsyncMock(return_value=(4, 3, 1)),
        ),
        patch(
            "dembrane.seat_capacity.count_pending_invites",
            AsyncMock(return_value=(1, 0)),
        ),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            res = await client.get(f"/v2/orgs/{_ORG_ID}/workspaces")
    assert res.status_code == 200
    rows = res.json()
    assert rows, "expected at least one workspace"
    for row in rows:
        # 4 effective seats + 1 pending = 5; NOT 0.
        assert row["seats_used_including_pending"] == 5
        # Unlimited tier -> no denominator.
        assert row["seat_cap"] is None
        assert row["seat_invite_blocked"] is False
