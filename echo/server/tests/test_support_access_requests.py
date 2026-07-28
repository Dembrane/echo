"""Tests for the staff-side support access request endpoints (hybrid flow).

Toggle OFF: staff may create one pending request per workspace; the customer
is notified. Toggle ON: 409, staff should join directly. Cancel is idempotent.
"""

from __future__ import annotations

from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.admin import router as admin_router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_WS_ID = "ws-1"
_ORG_ID = "org-1"


def _build_app(is_admin: bool = True) -> FastAPI:
    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id="du-staff", is_admin=is_admin)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(admin_router, prefix="/v2/admin")
    return app


@contextmanager
def _patched(ws: dict | None, requests_rows: list[dict]):
    directus = AsyncMock()

    async def get_item(collection: str, item_id: str):
        return ws if collection == "workspace" else None

    async def get_items(collection: str, params: dict | None = None):
        if collection == "support_access_request":
            return list(requests_rows)
        return []

    directus.get_item = AsyncMock(side_effect=get_item)
    directus.get_items = AsyncMock(side_effect=get_items)
    directus.create_item = AsyncMock(return_value={"data": {}})
    directus.update_item = AsyncMock(return_value={"data": {}})
    mocks = SimpleNamespace(
        directus=directus,
        record_event=AsyncMock(return_value="ev-1"),
        schedule=AsyncMock(return_value="task-1"),
        cancel=AsyncMock(return_value=1),
    )
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.api.v2.admin.async_directus", directus))
        stack.enter_context(patch("dembrane.support_access.async_directus", directus))
        stack.enter_context(
            patch(
                "dembrane.app_user.get_app_user_or_raise",
                AsyncMock(return_value={"id": "au-staff"}),
            )
        )
        stack.enter_context(
            patch(
                "dembrane.support_access.record_support_access_event",
                mocks.record_event,
            )
        )
        stack.enter_context(patch("dembrane.scheduled_tasks.schedule_task", mocks.schedule))
        stack.enter_context(
            patch("dembrane.scheduled_tasks.cancel_pending_tasks", mocks.cancel)
        )
        yield mocks


async def _call(app: FastAPI, method: str, json: dict | None = None):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.request(
            method,
            f"/v2/admin/workspaces/{_WS_ID}/support-access/request",
            json=json,
        )


_WS_OFF = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": False}
_WS_ON = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}


@pytest.mark.asyncio
async def test_non_staff_forbidden():
    with _patched(ws=_WS_OFF, requests_rows=[]):
        res = await _call(_build_app(is_admin=False), "POST", json={})
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_toggle_on_conflicts():
    with _patched(ws=_WS_ON, requests_rows=[]):
        res = await _call(_build_app(), "POST", json={})
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_create_request_schedules_expiry_and_records_event():
    with _patched(ws=_WS_OFF, requests_rows=[]) as mocks:
        res = await _call(_build_app(), "POST", json={"message": "billing bug"})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "pending"
    assert body["message"] == "billing bug"
    collection, payload = mocks.directus.create_item.call_args.args
    assert collection == "support_access_request"
    assert payload["requested_by"] == "au-staff"
    assert mocks.schedule.call_args.kwargs["task_type"] == "expire_support_access_request"
    assert mocks.record_event.call_args.kwargs["event_code"] == "request_created"
    assert mocks.record_event.call_args.kwargs["params"]["message"] == "billing bug"


@pytest.mark.asyncio
async def test_repeat_post_returns_existing_pending():
    pending = {
        "id": "req-1",
        "workspace_id": _WS_ID,
        "requested_by": "au-staff",
        "status": "pending",
        "message": None,
        "created_at": "2026-07-01T00:00:00+00:00",
        "expires_at": "2026-07-08T00:00:00+00:00",
    }
    with _patched(ws=_WS_OFF, requests_rows=[pending]) as mocks:
        res = await _call(_build_app(), "POST", json={})
    assert res.status_code == 200
    assert res.json()["id"] == "req-1"
    assert mocks.directus.create_item.await_count == 0
    assert mocks.record_event.await_count == 0


@pytest.mark.asyncio
async def test_get_reports_toggle_state_and_latest_request():
    with _patched(ws=_WS_ON, requests_rows=[]):
        res = await _call(_build_app(), "GET")
    assert res.status_code == 200
    body = res.json()
    assert body["support_access_enabled"] is True
    assert body["request"] is None


@pytest.mark.asyncio
async def test_delete_cancels_pending():
    pending = {
        "id": "req-1",
        "workspace_id": _WS_ID,
        "requested_by": "au-staff",
        "status": "pending",
        "message": None,
        "created_at": "2026-07-01T00:00:00+00:00",
        "expires_at": "2026-07-08T00:00:00+00:00",
    }
    with _patched(ws=_WS_OFF, requests_rows=[pending]) as mocks:
        res = await _call(_build_app(), "DELETE")
    assert res.status_code == 200
    args = mocks.directus.update_item.call_args.args
    assert args[0] == "support_access_request"
    assert args[1] == "req-1"
    assert args[2]["status"] == "cancelled"
    assert mocks.cancel.call_args.kwargs["payload_match"] == {"request_id": "req-1"}
    kwargs = mocks.record_event.call_args.kwargs
    assert kwargs["event_code"] == "request_cancelled"
    assert kwargs["notify"] is False


@pytest.mark.asyncio
async def test_delete_without_pending_is_idempotent():
    with _patched(ws=_WS_OFF, requests_rows=[]) as mocks:
        res = await _call(_build_app(), "DELETE")
    assert res.status_code == 200
    assert mocks.directus.update_item.await_count == 0
