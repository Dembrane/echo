"""Tests for the training feature (ISSUE-020) — service + user-facing API.

Covers:
    - Catalog: online / in_person / flex(coming-soon), NO pilot.
    - provision_license: expires_at = completed_at + 365d, granted_by = staff.
    - Roster map: trained vs not-trained; expired license flips to not-trained.
    - get_user_training_status reflects an active vs expired license.
    - High-risk nudge: dormant (stand-in False); even with the selector mocked
      True the request/roster endpoints never block.
"""

from __future__ import annotations

from typing import Any
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.training_service import (
    CATALOG,
    provision_license,
    compute_expires_at,
    is_high_risk_context,
    get_user_training_status,
    get_org_roster_training_map,
    get_high_risk_pending_action,
)
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "du-staff-001"
_APP_USER = {"id": "au-staff-001", "email": "staff@dembrane.com", "display_name": "Staff"}


def _iso(dt: datetime) -> str:
    return dt.isoformat()


# ── Catalog ────────────────────────────────────────────────────────────────


def test_catalog_has_online_in_person_flex_no_pilot():
    by_type = {p.type: p for p in CATALOG}
    assert set(by_type) == {"online", "in_person", "flex"}
    assert "pilot" not in by_type

    assert by_type["online"].price_eur == 675
    assert by_type["online"].included_participants == 5
    assert by_type["online"].extra_price_eur == 60
    assert by_type["online"].grants_license is True
    assert by_type["online"].coming_soon is False

    assert by_type["in_person"].price_eur == 2500
    assert by_type["in_person"].included_participants == 10
    assert by_type["in_person"].extra_price_eur == 195
    assert by_type["in_person"].grants_license is True

    # Flex is coming soon.
    assert by_type["flex"].coming_soon is True


@pytest.mark.asyncio
async def test_catalog_endpoint_returns_products():
    from dembrane.api.v2.training import router

    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(router, prefix="/v2/training")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v2/training/catalog")

    assert resp.status_code == 200
    body = resp.json()
    types = {p["type"] for p in body}
    assert types == {"online", "in_person", "flex"}
    flex = next(p for p in body if p["type"] == "flex")
    assert flex["coming_soon"] is True
    assert "pilot" not in types


# ── provision_license ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provision_license_expiry_and_granted_by():
    completed = datetime(2026, 1, 1, tzinfo=timezone.utc)

    captured: dict[str, Any] = {}

    async def _create(collection: str, payload: dict) -> dict:
        captured["collection"] = collection
        captured["payload"] = payload
        return {"data": payload}

    mock = AsyncMock()
    mock.create_item = AsyncMock(side_effect=_create)

    with patch("dembrane.training_service.async_directus", mock):
        row = await provision_license(
            org_id="org-1",
            app_user_id="au-trainee",
            granted_by="au-staff-001",
            training_id="tr-1",
            completed_at=completed,
        )

    assert captured["collection"] == "training_license"
    payload = captured["payload"]
    assert payload["app_user_id"] == "au-trainee"
    assert payload["granted_by"] == "au-staff-001"
    assert payload["status"] == "active"
    # expires_at = completed_at + 365 days.
    assert payload["expires_at"] == _iso(completed + timedelta(days=365))
    assert payload["expires_at"] == _iso(compute_expires_at(completed))
    assert row["expires_at"] == payload["expires_at"]


# ── status + roster ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_training_status_active_license_is_trained():
    future = datetime.now(timezone.utc) + timedelta(days=200)
    mock = AsyncMock()
    mock.get_items = AsyncMock(
        return_value=[
            {"id": "l1", "status": "active", "expires_at": _iso(future), "org_id": "org-1"}
        ]
    )
    with patch("dembrane.training_service.async_directus", mock):
        status = await get_user_training_status("au-trainee")
    assert status["trained"] is True
    assert status["trained_until"] == _iso(future)


@pytest.mark.asyncio
async def test_expired_license_flips_to_not_trained():
    past = datetime.now(timezone.utc) - timedelta(days=1)
    mock = AsyncMock()
    mock.get_items = AsyncMock(
        return_value=[
            {"id": "l1", "status": "active", "expires_at": _iso(past), "org_id": "org-1"}
        ]
    )
    with patch("dembrane.training_service.async_directus", mock):
        status = await get_user_training_status("au-trainee")
    assert status["trained"] is False
    assert status["trained_until"] is None


@pytest.mark.asyncio
async def test_roster_map_trained_and_not_trained():
    future = datetime.now(timezone.utc) + timedelta(days=100)
    past = datetime.now(timezone.utc) - timedelta(days=2)
    mock = AsyncMock()
    mock.get_items = AsyncMock(
        return_value=[
            {"app_user_id": "u-active", "status": "active", "expires_at": _iso(future)},
            {"app_user_id": "u-expired", "status": "active", "expires_at": _iso(past)},
        ]
    )
    with patch("dembrane.training_service.async_directus", mock):
        result = await get_org_roster_training_map(
            "org-1", ["u-active", "u-expired", "u-none"]
        )
    assert result["u-active"]["trained"] is True
    assert result["u-expired"]["trained"] is False
    assert result["u-none"]["trained"] is False


# ── high-risk nudge ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_high_risk_selector_false_when_no_onboarding_answer():
    # No app_user row / no onboarding answer reads as not-high-risk so the
    # nudge never falsely fires.
    mock = AsyncMock()
    mock.get_items = AsyncMock(return_value=[])
    with patch("dembrane.training_service.async_directus", mock):
        assert await is_high_risk_context("any-user") is False


@pytest.mark.asyncio
async def test_high_risk_selector_reads_onboarding_answer():
    # Wave D's onboarding_answer_json with q2 == "yes" flags high-risk.
    mock = AsyncMock()
    mock.get_items = AsyncMock(
        return_value=[
            {
                "id": "au-trainee",
                "onboarding_answer_json": {
                    "version": "17-jun-26",
                    "data": [{"q1": "alone", "q2": "yes"}],
                },
            }
        ]
    )
    with patch("dembrane.training_service.async_directus", mock):
        assert await is_high_risk_context("au-trainee") is True


@pytest.mark.asyncio
async def test_high_risk_selector_false_when_q2_no():
    mock = AsyncMock()
    mock.get_items = AsyncMock(
        return_value=[
            {"id": "au", "onboarding_answer_json": {"data": [{"q2": "no"}]}}
        ]
    )
    with patch("dembrane.training_service.async_directus", mock):
        assert await is_high_risk_context("au") is False


@pytest.mark.asyncio
async def test_high_risk_selector_defensive_on_lookup_error():
    # A Directus hiccup must never throw; it reads as not-high-risk.
    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=RuntimeError("directus down"))
    with patch("dembrane.training_service.async_directus", mock):
        assert await is_high_risk_context("au") is False


@pytest.mark.asyncio
async def test_high_risk_pending_action_none_when_not_high_risk():
    assert await get_high_risk_pending_action("any-user") is None


@pytest.mark.asyncio
async def test_high_risk_pending_action_surfaces_when_high_risk_and_untrained():
    # Force the selector True (simulating the Wave-D wiring) and no license.
    with (
        patch("dembrane.training_service.is_high_risk_context", AsyncMock(return_value=True)),
        patch("dembrane.training_service.has_active_license", AsyncMock(return_value=False)),
    ):
        action = await get_high_risk_pending_action("au-trainee")
    assert action is not None
    assert action["code"] == "training_required_high_risk"
    assert action["action"] == "BOOK_TRAINING"


@pytest.mark.asyncio
async def test_high_risk_pending_action_cleared_when_trained():
    with (
        patch("dembrane.training_service.is_high_risk_context", AsyncMock(return_value=True)),
        patch("dembrane.training_service.has_active_license", AsyncMock(return_value=True)),
    ):
        action = await get_high_risk_pending_action("au-trainee")
    assert action is None


@pytest.mark.asyncio
async def test_request_endpoint_never_blocks_even_for_high_risk_user():
    """Even with high-risk mocked True, requesting a training succeeds (warn,
    never block)."""
    from dembrane.api.v2.training import router

    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(router, prefix="/v2/training")

    mock = AsyncMock()
    # admin role so the request gate passes
    mock.get_items = AsyncMock(return_value=[{"role": "admin"}])
    mock.get_item = AsyncMock(return_value={"id": "org-1", "name": "Org One"})
    mock.create_item = AsyncMock(return_value={"data": {"id": "tr-new"}})

    with (
        patch("dembrane.api.v2.training.async_directus", mock),
        patch("dembrane.api.v2.training.get_app_user_or_raise", AsyncMock(return_value=_APP_USER)),
        patch("dembrane.training_service.is_high_risk_context", AsyncMock(return_value=True)),
        patch("dembrane.notifications.audience_staff", AsyncMock(return_value=[])),
        patch("dembrane.notifications.emit_to_audience", AsyncMock(return_value=[])),
        patch("dembrane.email.send_email", AsyncMock(return_value=True)),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/v2/training/orgs/org-1/request",
                json={"type": "online", "extra_participants": 3},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "requested"
    assert body["base_price_eur"] == 675
    # 3 extra × 60 + 675 = 855
    assert body["estimated_total_eur"] == 855.0


@pytest.mark.asyncio
async def test_request_flex_is_rejected_coming_soon():
    """Flex is coming soon; the schema only allows online/in_person, so a flex
    request fails validation (422)."""
    from dembrane.api.v2.training import router

    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(router, prefix="/v2/training")

    mock = AsyncMock()
    mock.get_items = AsyncMock(return_value=[{"role": "admin"}])

    with (
        patch("dembrane.api.v2.training.async_directus", mock),
        patch("dembrane.api.v2.training.get_app_user_or_raise", AsyncMock(return_value=_APP_USER)),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/v2/training/orgs/org-1/request", json={"type": "flex"}
            )

    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_roster_endpoint_trained_count():
    from dembrane.api.v2.training import router

    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(router, prefix="/v2/training")

    future = datetime.now(timezone.utc) + timedelta(days=100)

    async def _get_items(collection: str, params: dict) -> Any:
        if collection == "org_membership":
            f = params.get("query", {}).get("filter", {})
            # role check (caller) returns admin; full roster returns members
            if f.get("user_id"):
                return [{"role": "admin"}]
            return [
                {"user_id": "au-staff-001", "role": "admin"},
                {"user_id": "u-trained", "role": "member"},
            ]
        if collection == "app_user":
            return [
                {"id": "au-staff-001", "display_name": "Staff", "email": "staff@dembrane.com"},
                {"id": "u-trained", "display_name": "Trainee", "email": "t@x.com"},
            ]
        if collection == "training_license":
            return [
                {"app_user_id": "u-trained", "status": "active", "expires_at": _iso(future)}
            ]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_get_items)

    with (
        patch("dembrane.api.v2.training.async_directus", mock),
        patch("dembrane.training_service.async_directus", mock),
        patch("dembrane.api.v2.training.get_app_user_or_raise", AsyncMock(return_value=_APP_USER)),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/v2/training/orgs/org-1/roster")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_count"] == 2
    assert body["trained_count"] == 1
    assert body["can_manage"] is True
    trained = next(m for m in body["members"] if m["app_user_id"] == "u-trained")
    assert trained["trained"] is True
    assert trained["trained_until"] == _iso(future)
    # Admin caller sees emails.
    assert trained["email"] == "t@x.com"
