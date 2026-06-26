"""Tests for staff training endpoints (ISSUE-020, admin_training router).

Covers:
    - Non-staff hitting any staff training endpoint → 403.
    - Staff create a training for an org (catalog defaults applied).
    - Staff complete a training → writes a training_license per user with
      expires_at = completed_at + 365d and granted_by = the staff user.
    - Staff revoke a license.
"""

from __future__ import annotations

from typing import Any
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_STAFF_DU = "du-staff"
_STAFF_APP_USER = {"id": "au-staff", "email": "staff@dembrane.com", "display_name": "Staff"}


def _build_app(is_admin: bool) -> FastAPI:
    from dembrane.api.v2.admin_training import router

    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id=_STAFF_DU, is_admin=is_admin)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(router, prefix="/v2/admin")
    return app


@pytest.mark.asyncio
async def test_non_staff_create_training_403():
    app = _build_app(is_admin=False)
    with patch(
        "dembrane.api.v2.admin_training.get_app_user_or_raise",
        AsyncMock(return_value=_STAFF_APP_USER),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/v2/admin/trainings", json={"org_id": "org-1", "type": "online"}
            )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_non_staff_list_trainings_403():
    app = _build_app(is_admin=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v2/admin/trainings")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_non_staff_complete_training_403():
    app = _build_app(is_admin=False)
    with patch(
        "dembrane.api.v2.admin_training.get_app_user_or_raise",
        AsyncMock(return_value=_STAFF_APP_USER),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/v2/admin/trainings/tr-1/complete",
                json={"app_user_ids": ["u-1"]},
            )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_non_staff_revoke_license_403():
    app = _build_app(is_admin=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/v2/admin/licenses/l-1/revoke")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_list_trainings_resolves_requester_name_and_email():
    app = _build_app(is_admin=True)

    training_rows = [
        {
            "id": "tr-1", "org_id": "org-1", "type": "online", "status": "requested",
            "included_participants": 10, "extra_participants": 3,
            "requested_by": "au-req", "created_at": "2026-06-20T10:00:00+00:00",
        },
        {
            "id": "tr-2", "org_id": "org-1", "type": "in_person", "status": "scheduled",
            "requested_by": None, "created_at": "2026-06-19T10:00:00+00:00",
        },
    ]

    async def _get_items(collection: str, query: dict):
        if collection == "training":
            return training_rows
        if collection == "org":
            return [{"id": "org-1", "name": "Org One"}]
        if collection == "training_license":
            return []
        if collection == "app_user":
            return [{"id": "au-req", "display_name": "Ada Lovelace", "email": "ada@org.com"}]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_get_items)

    with patch("dembrane.api.v2.admin_training.async_directus", mock):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/v2/admin/trainings")

    assert resp.status_code == 200, resp.text
    by_id = {row["id"]: row for row in resp.json()}
    assert by_id["tr-1"]["requested_by_name"] == "Ada Lovelace"
    assert by_id["tr-1"]["requested_by_email"] == "ada@org.com"
    # Staff-created row (no requester) resolves to null, never errors.
    assert by_id["tr-2"]["requested_by_name"] is None
    assert by_id["tr-2"]["requested_by_email"] is None


@pytest.mark.asyncio
async def test_list_trainings_includes_org_member_count():
    app = _build_app(is_admin=True)

    async def _get_items(collection: str, query: dict):
        if collection == "training":
            return [{"id": "tr-1", "org_id": "org-1", "type": "online", "status": "completed"}]
        if collection == "org":
            return [{"id": "org-1", "name": "Org One"}]
        if collection == "org_membership":
            return [{"org_id": "org-1"}, {"org_id": "org-1"}, {"org_id": "org-1"}]
        if collection == "training_license":
            return []
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_get_items)

    with patch("dembrane.api.v2.admin_training.async_directus", mock):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/v2/admin/trainings")

    assert resp.status_code == 200, resp.text
    assert resp.json()[0]["org_member_count"] == 3


@pytest.mark.asyncio
async def test_list_trainings_license_count_excludes_revoked():
    app = _build_app(is_admin=True)

    async def _get_items(collection: str, query: dict):
        if collection == "training":
            return [{"id": "tr-1", "org_id": "org-1", "type": "online", "status": "completed"}]
        if collection == "org":
            return [{"id": "org-1", "name": "Org One"}]
        if collection == "training_license":
            return [
                {"training_id": "tr-1", "status": "active"},
                {"training_id": "tr-1", "status": "active"},
                {"training_id": "tr-1", "status": "revoked"},
            ]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_get_items)

    with patch("dembrane.api.v2.admin_training.async_directus", mock):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/v2/admin/trainings")

    assert resp.status_code == 200, resp.text
    # 2 active + 1 revoked → count is the 2 active only.
    assert resp.json()[0]["license_count"] == 2


@pytest.mark.asyncio
async def test_list_training_licenses_resolves_attendee_names():
    app = _build_app(is_admin=True)

    license_rows = [
        {
            "id": "l-1", "app_user_id": "au-1", "training_id": "tr-1",
            "status": "active", "completed_at": "2026-03-01T00:00:00+00:00",
            "expires_at": "2027-03-01T00:00:00+00:00",
        },
        {
            "id": "l-2", "app_user_id": "au-2", "training_id": "tr-1",
            "status": "revoked", "completed_at": None, "expires_at": None,
        },
    ]

    async def _get_items(collection: str, query: dict):
        if collection == "training_license":
            return license_rows
        if collection == "app_user":
            return [{"id": "au-1", "display_name": "Ada Lovelace", "email": "ada@x.com"}]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=_get_items)

    with patch("dembrane.api.v2.admin_training.async_directus", mock):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/v2/admin/trainings/tr-1/licenses")

    assert resp.status_code == 200, resp.text
    by_id = {r["id"]: r for r in resp.json()}
    assert by_id["l-1"]["app_user_name"] == "Ada Lovelace"
    assert by_id["l-1"]["app_user_email"] == "ada@x.com"
    assert by_id["l-1"]["status"] == "active"
    # A license whose user isn't resolvable still returns, with null name.
    assert by_id["l-2"]["app_user_name"] is None
    assert by_id["l-2"]["status"] == "revoked"


@pytest.mark.asyncio
async def test_staff_create_training_applies_catalog_defaults():
    app = _build_app(is_admin=True)

    captured: dict[str, Any] = {}

    async def _create(collection: str, payload: dict) -> dict:
        captured["collection"] = collection
        captured["payload"] = payload
        return {"data": {"id": "tr-created"}}

    mock = AsyncMock()
    mock.get_item = AsyncMock(return_value={"id": "org-1", "name": "Org One"})
    mock.create_item = AsyncMock(side_effect=_create)

    with (
        patch("dembrane.api.v2.admin_training.async_directus", mock),
        patch(
            "dembrane.api.v2.admin_training.get_app_user_or_raise",
            AsyncMock(return_value=_STAFF_APP_USER),
        ),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/v2/admin/trainings",
                json={"org_id": "org-1", "type": "in_person", "extra_participants": 2},
            )

    assert resp.status_code == 200, resp.text
    payload = captured["payload"]
    assert payload["type"] == "in_person"
    assert payload["base_price_eur"] == 2500
    assert payload["included_participants"] == 10
    assert payload["extra_price_eur"] == 195
    assert payload["grants_license"] is True
    assert payload["status"] == "requested"  # no scheduled_at


@pytest.mark.asyncio
async def test_staff_complete_training_writes_licenses_with_expiry_and_granted_by():
    app = _build_app(is_admin=True)
    completed = datetime(2026, 3, 1, tzinfo=timezone.utc)

    created_licenses: list[dict] = []
    updated: dict[str, Any] = {}

    async def _create(collection: str, payload: dict) -> dict:
        if collection == "training_license":
            created_licenses.append(payload)
        return {"data": payload}

    async def _update(collection: str, item_id: str, payload: dict) -> dict:
        updated[collection] = (item_id, payload)
        return {"data": {}}

    mock = AsyncMock()
    mock.get_item = AsyncMock(
        return_value={"id": "tr-1", "org_id": "org-1", "grants_license": True}
    )
    mock.create_item = AsyncMock(side_effect=_create)
    mock.update_item = AsyncMock(side_effect=_update)

    with (
        patch("dembrane.api.v2.admin_training.async_directus", mock),
        patch("dembrane.training_service.async_directus", mock),
        patch(
            "dembrane.api.v2.admin_training.get_app_user_or_raise",
            AsyncMock(return_value=_STAFF_APP_USER),
        ),
        patch("dembrane.notifications.emit", AsyncMock(return_value="n1")),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/v2/admin/trainings/tr-1/complete",
                json={
                    "app_user_ids": ["u-a", "u-b"],
                    "completed_at": completed.isoformat(),
                },
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["licenses_created"] == 2
    assert len(created_licenses) == 2
    for lic in created_licenses:
        assert lic["org_id"] == "org-1"
        assert lic["training_id"] == "tr-1"
        assert lic["granted_by"] == "au-staff"
        assert lic["status"] == "active"
        assert lic["expires_at"] == (completed + timedelta(days=365)).isoformat()
    # Training flips to completed.
    assert updated["training"][0] == "tr-1"
    assert updated["training"][1]["status"] == "completed"


@pytest.mark.asyncio
async def test_staff_complete_non_license_training_400():
    app = _build_app(is_admin=True)
    mock = AsyncMock()
    mock.get_item = AsyncMock(
        return_value={"id": "tr-1", "org_id": "org-1", "grants_license": False}
    )
    with (
        patch("dembrane.api.v2.admin_training.async_directus", mock),
        patch(
            "dembrane.api.v2.admin_training.get_app_user_or_raise",
            AsyncMock(return_value=_STAFF_APP_USER),
        ),
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/v2/admin/trainings/tr-1/complete", json={"app_user_ids": ["u-a"]}
            )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_staff_revoke_license():
    app = _build_app(is_admin=True)
    updated: dict[str, Any] = {}

    async def _update(collection: str, item_id: str, payload: dict) -> dict:
        updated[collection] = (item_id, payload)
        return {"data": {}}

    mock = AsyncMock()
    mock.get_item = AsyncMock(return_value={"id": "l-1", "status": "active"})
    mock.update_item = AsyncMock(side_effect=_update)

    with patch("dembrane.api.v2.admin_training.async_directus", mock):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/v2/admin/licenses/l-1/revoke")

    assert resp.status_code == 200
    assert updated["training_license"][1]["status"] == "revoked"


@pytest.mark.asyncio
async def test_revoke_last_license_reverts_completed_training_to_scheduled():
    app = _build_app(is_admin=True)
    updates: list[Any] = []

    async def _get_item(collection: str, item_id: str):
        if collection == "training_license":
            return {"id": "l-1", "training_id": "tr-1", "status": "active"}
        if collection == "training":
            return {
                "id": "tr-1",
                "status": "completed",
                "scheduled_at": "2026-05-01T00:00:00+00:00",
            }
        return None

    async def _get_items(collection: str, query: dict):
        return []  # no active licenses remain

    async def _update_item(collection: str, item_id: str, payload: dict):
        updates.append((collection, item_id, payload))
        return {"data": {}}

    mock = AsyncMock()
    mock.get_item = AsyncMock(side_effect=_get_item)
    mock.get_items = AsyncMock(side_effect=_get_items)
    mock.update_item = AsyncMock(side_effect=_update_item)

    with patch("dembrane.api.v2.admin_training.async_directus", mock):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/v2/admin/licenses/l-1/revoke")

    assert resp.status_code == 200, resp.text
    assert ("training_license", "l-1", {"status": "revoked"}) in updates
    training_updates = [u for u in updates if u[0] == "training"]
    assert len(training_updates) == 1
    assert training_updates[0][2]["status"] == "scheduled"


@pytest.mark.asyncio
async def test_revoke_license_keeps_completed_when_active_remain():
    app = _build_app(is_admin=True)
    updates: list[Any] = []

    async def _get_item(collection: str, item_id: str):
        if collection == "training_license":
            return {"id": "l-1", "training_id": "tr-1", "status": "active"}
        if collection == "training":
            return {"id": "tr-1", "status": "completed", "scheduled_at": None}
        return None

    async def _get_items(collection: str, query: dict):
        return [{"id": "l-2"}]  # another active license remains

    async def _update_item(collection: str, item_id: str, payload: dict):
        updates.append((collection, item_id, payload))
        return {"data": {}}

    mock = AsyncMock()
    mock.get_item = AsyncMock(side_effect=_get_item)
    mock.get_items = AsyncMock(side_effect=_get_items)
    mock.update_item = AsyncMock(side_effect=_update_item)

    with patch("dembrane.api.v2.admin_training.async_directus", mock):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/v2/admin/licenses/l-1/revoke")

    assert resp.status_code == 200, resp.text
    assert ("training_license", "l-1", {"status": "revoked"}) in updates
    # Training keeps its completed status — other active licenses remain.
    assert [u for u in updates if u[0] == "training"] == []


@pytest.mark.asyncio
async def test_staff_update_license_recomputes_expiry():
    app = _build_app(is_admin=True)
    new_completed = datetime(2026, 6, 1, tzinfo=timezone.utc)
    updated: dict[str, Any] = {}

    async def _update(collection: str, item_id: str, payload: dict) -> dict:
        updated[collection] = (item_id, payload)
        return {"data": {}}

    mock = AsyncMock()
    mock.get_item = AsyncMock(
        return_value={
            "id": "l-1",
            "org_id": "org-1",
            "app_user_id": "u-a",
            "status": "active",
        }
    )
    mock.update_item = AsyncMock(side_effect=_update)

    with patch("dembrane.api.v2.admin_training.async_directus", mock):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(
                "/v2/admin/licenses/l-1",
                json={"completed_at": new_completed.isoformat()},
            )

    assert resp.status_code == 200, resp.text
    payload = updated["training_license"][1]
    assert payload["completed_at"] == new_completed.isoformat()
    assert payload["expires_at"] == (new_completed + timedelta(days=365)).isoformat()
