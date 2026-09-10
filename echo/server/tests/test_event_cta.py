"""The dembrane event invitation on the portal's thank you page: on by
default, off per project on a paid plan, never off on the free tier."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.free_tier import is_event_cta_enabled
from dembrane.legal_basis import CascadeRows
from dembrane.api.participant import ParticipantRouter, resolve_event_cta
from dembrane.api.v2.bff.tags import project_router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

# ── The rule ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("stored", "tier", "expected"),
    [
        (None, None, True),  # unset reads as on
        (True, None, True),
        (False, None, False),  # legacy workspace, no billing account: not gated
        (None, "free", True),
        (True, "free", True),
        (False, "free", True),  # the free tier cannot hide it
        (False, "changemaker", False),  # a paid plan can
        (True, "changemaker", True),
    ],
)
def test_is_event_cta_enabled(stored, tier, expected):
    assert is_event_cta_enabled(stored, tier) is expected


# ── The participant resolver ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolver_reads_no_billing_while_the_card_is_on():
    with patch("dembrane.api.participant.resolve_workspace_billing", new=AsyncMock()) as billing:
        assert await resolve_event_cta({"workspace_id": "w1"}, None) is True
        assert (
            await resolve_event_cta(
                {"workspace_id": "w1", "is_dembrane_event_cta_enabled": True}, None
            )
            is True
        )
        billing.assert_not_called()


@pytest.mark.asyncio
async def test_resolver_free_tier_forces_the_card_on():
    workspace = {"billing_account_id": "b1"}
    with patch(
        "dembrane.api.participant.resolve_workspace_billing",
        new=AsyncMock(return_value={"tier": "free"}),
    ) as billing:
        project = {"id": "p1", "workspace_id": "w1", "is_dembrane_event_cta_enabled": False}
        assert await resolve_event_cta(project, workspace) is True
        # the pre-fetched cascade row is handed over, so no second workspace read
        billing.assert_awaited_once_with("w1", workspace=workspace)


@pytest.mark.asyncio
async def test_resolver_paid_tier_honours_off():
    with patch(
        "dembrane.api.participant.resolve_workspace_billing",
        new=AsyncMock(return_value={"tier": "changemaker"}),
    ):
        project = {"id": "p1", "workspace_id": "w1", "is_dembrane_event_cta_enabled": False}
        assert await resolve_event_cta(project, None) is False


@pytest.mark.asyncio
async def test_resolver_billing_hiccup_keeps_the_stored_value():
    with patch(
        "dembrane.api.participant.resolve_workspace_billing",
        new=AsyncMock(side_effect=RuntimeError("directus down")),
    ):
        project = {"id": "p1", "workspace_id": "w1", "is_dembrane_event_cta_enabled": False}
        assert await resolve_event_cta(project, None) is False


@pytest.mark.asyncio
async def test_resolver_project_without_workspace_is_not_gated():
    with patch("dembrane.api.participant.resolve_workspace_billing", new=AsyncMock()) as billing:
        project = {"id": "p1", "workspace_id": None, "is_dembrane_event_cta_enabled": False}
        assert await resolve_event_cta(project, None) is False
        billing.assert_not_called()


# ── The public project endpoint ──────────────────────────────────────────


def _public_project(**overrides: object) -> dict:
    project = {
        "id": "p1",
        "language": "en",
        "workspace_id": "w1",
        "is_conversation_allowed": True,
        "is_get_reply_enabled": False,
        "is_verify_enabled": False,
        "is_project_notification_subscription_allowed": False,
    }
    project.update(overrides)
    return project


async def _get_public_project(project: dict, tier: str | None):
    service = MagicMock()
    service.get_by_id_or_raise = MagicMock(return_value=project)
    with (
        patch("dembrane.api.participant.project_service", service),
        patch(
            "dembrane.api.participant.fetch_cascade_rows",
            new=AsyncMock(
                return_value=CascadeRows(
                    workspace={"billing_account_id": "b1"}, org=None, owner=None
                )
            ),
        ),
        patch(
            "dembrane.api.participant.resolve_workspace_billing",
            new=AsyncMock(return_value={"tier": tier}),
        ),
    ):
        app = FastAPI()
        app.include_router(ParticipantRouter, prefix="/participant")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            return await ac.get("/participant/projects/p1")


@pytest.mark.asyncio
async def test_public_project_defaults_the_card_on():
    response = await _get_public_project(_public_project(), tier="free")
    assert response.status_code == 200
    assert response.json()["is_dembrane_event_cta_enabled"] is True


@pytest.mark.asyncio
async def test_public_project_free_tier_cannot_hide_the_card():
    response = await _get_public_project(
        _public_project(is_dembrane_event_cta_enabled=False), tier="free"
    )
    assert response.status_code == 200
    assert response.json()["is_dembrane_event_cta_enabled"] is True


@pytest.mark.asyncio
async def test_public_project_paid_tier_hides_the_card():
    response = await _get_public_project(
        _public_project(is_dembrane_event_cta_enabled=False), tier="changemaker"
    )
    assert response.status_code == 200
    assert response.json()["is_dembrane_event_cta_enabled"] is False


# ── The write ────────────────────────────────────────────────────────────


def _build_app() -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id="user-1", is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(project_router, prefix="/v2/bff/projects")
    return app


async def _patch_project(payload: dict, tier: str | None):
    access = MagicMock()
    access.project = {"id": "p1", "legal_basis": None, "privacy_policy_url": None}
    access.role = "admin"
    access.workspace_id = "w1"
    access.require = MagicMock()
    with (
        patch(
            "dembrane.api.v2.bff.tags.resolve_project_access",
            new=AsyncMock(return_value=access),
        ),
        patch(
            "dembrane.api.v2.bff.tags.resolve_workspace_tier",
            new=AsyncMock(return_value=tier),
        ) as tier_lookup,
        patch("dembrane.api.v2.bff.tags.async_directus") as mock_directus,
    ):
        mock_directus.update_item = AsyncMock(return_value={"data": {"id": "p1"}})
        async with AsyncClient(
            transport=ASGITransport(app=_build_app()), base_url="http://test"
        ) as ac:
            response = await ac.patch("/v2/bff/projects/p1", json=payload)
        return response, mock_directus, tier_lookup


@pytest.mark.asyncio
async def test_patch_refuses_hiding_the_card_on_the_free_tier():
    response, mock_directus, _ = await _patch_project(
        {"is_dembrane_event_cta_enabled": False}, tier="free"
    )
    assert response.status_code == 403
    mock_directus.update_item.assert_not_called()


@pytest.mark.asyncio
async def test_patch_lets_a_paid_plan_hide_the_card():
    response, mock_directus, _ = await _patch_project(
        {"is_dembrane_event_cta_enabled": False}, tier="changemaker"
    )
    assert response.status_code == 200
    mock_directus.update_item.assert_awaited_once_with(
        "project", "p1", {"is_dembrane_event_cta_enabled": False}
    )


@pytest.mark.asyncio
async def test_patch_switching_the_card_on_needs_no_tier():
    response, mock_directus, tier_lookup = await _patch_project(
        {"is_dembrane_event_cta_enabled": True}, tier="free"
    )
    assert response.status_code == 200
    tier_lookup.assert_not_called()
    mock_directus.update_item.assert_awaited_once_with(
        "project", "p1", {"is_dembrane_event_cta_enabled": True}
    )
