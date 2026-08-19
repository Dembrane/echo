"""Project-level legal override tests for PATCH /v2/bff/projects/{id},
including two shipped regressions: stale rows blocking PATCHes, echo 403s."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.bff.tags import project_router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "test-user-123"


def _build_app() -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=_USER_ID, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(project_router, prefix="/v2/bff/projects")
    return app


def _fake_access(project: dict, role: str = "admin") -> MagicMock:
    access = MagicMock()
    access.project = project
    access.role = role
    access.require = MagicMock()
    return access


async def _patch_project(
    project: dict,
    payload: dict,
    dembrane_email: bool = False,
    role: str = "admin",
):
    with (
        patch(
            "dembrane.api.v2.bff.tags.resolve_project_access",
            new=AsyncMock(return_value=_fake_access(project, role)),
        ),
        patch("dembrane.api.v2.bff.tags.async_directus") as mock_directus,
        patch(
            "dembrane.legal_basis.async_directus.get_users",
            new=AsyncMock(
                return_value=[
                    {"email": "who@dembrane.com" if dembrane_email else "who@example.com"}
                ]
            ),
        ),
    ):
        mock_directus.update_item = AsyncMock(return_value={"data": {"id": "p1"}})
        app = _build_app()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            response = await ac.patch("/v2/bff/projects/p1", json=payload)
        return response, mock_directus


@pytest.mark.asyncio
async def test_legacy_consent_row_does_not_block_unrelated_patch():
    project = {"id": "p1", "legal_basis": "consent", "privacy_policy_url": None}
    response, mock_directus = await _patch_project(project, {"name": "Renamed"})
    assert response.status_code == 200
    sent = mock_directus.update_item.call_args.args[2]
    assert sent == {"name": "Renamed"}


@pytest.mark.asyncio
async def test_consent_override_without_url_rejected():
    project = {"id": "p1", "legal_basis": None, "privacy_policy_url": None}
    response, mock_directus = await _patch_project(project, {"legal_basis": "consent"})
    assert response.status_code == 400
    mock_directus.update_item.assert_not_called()


@pytest.mark.asyncio
async def test_consent_override_with_url_saved():
    project = {"id": "p1", "legal_basis": None, "privacy_policy_url": None}
    response, mock_directus = await _patch_project(
        project,
        {"legal_basis": "consent", "privacy_policy_url": "https://a.example/privacy"},
    )
    assert response.status_code == 200
    sent = mock_directus.update_item.call_args.args[2]
    assert sent["legal_basis"] == "consent"
    assert sent["privacy_policy_url"] == "https://a.example/privacy"


@pytest.mark.asyncio
async def test_clearing_override_with_null():
    project = {"id": "p1", "legal_basis": "consent", "privacy_policy_url": "https://a.example"}
    response, mock_directus = await _patch_project(project, {"legal_basis": None})
    assert response.status_code == 200
    sent = mock_directus.update_item.call_args.args[2]
    assert sent == {"legal_basis": None, "privacy_policy_url": None}


@pytest.mark.asyncio
async def test_unchanged_dembrane_events_echo_does_not_403():
    project = {"id": "p1", "legal_basis": "dembrane-events", "privacy_policy_url": None}
    response, _ = await _patch_project(project, {"legal_basis": "dembrane-events"})
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_legal_override_requires_admin_role():
    project = {"id": "p1", "legal_basis": None, "privacy_policy_url": None}
    response, mock_directus = await _patch_project(
        project,
        {"legal_basis": "consent", "privacy_policy_url": "https://a.example/p"},
        role="external",
    )
    assert response.status_code == 403
    mock_directus.update_item.assert_not_called()

    # Non-legal edits stay open to any project editor.
    response, _ = await _patch_project(project, {"name": "Renamed"}, role="external")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_new_dembrane_events_requires_dembrane_email():
    project = {"id": "p1", "legal_basis": None, "privacy_policy_url": None}
    response, _ = await _patch_project(project, {"legal_basis": "dembrane-events"})
    assert response.status_code == 403

    response, _ = await _patch_project(
        project, {"legal_basis": "dembrane-events"}, dembrane_email=True
    )
    assert response.status_code == 200
