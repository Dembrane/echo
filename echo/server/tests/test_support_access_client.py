"""Tests for the client-facing support access endpoints: the audit log the
customer sees, and approve/deny on pending staff requests. All four routes
are gated on settings:manage via the workspace context."""

from __future__ import annotations

from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException

from dembrane.api.v2.middleware import get_workspace_context
from dembrane.api.v2.support_access import router as support_access_router

_WS_ID = "ws-1"


class _FakeCtx:
    def __init__(self, can_manage: bool = True):
        self.workspace_id = _WS_ID
        self.workspace = {"id": _WS_ID, "org_id": "org-1", "allow_support_access": False}
        self.app_user_id = "au-admin"
        self._can_manage = can_manage

    def require_policy(self, policy: str) -> None:
        if not self._can_manage:
            raise HTTPException(status_code=403, detail="Forbidden")


def _build_app(can_manage: bool = True) -> FastAPI:
    app = FastAPI()
    app.dependency_overrides[get_workspace_context] = lambda: _FakeCtx(can_manage)
    app.include_router(support_access_router, prefix="/v2/workspaces")
    return app


_PENDING = {
    "id": "req-1",
    "workspace_id": _WS_ID,
    "requested_by": "au-staff",
    "status": "pending",
    "message": "billing bug",
    "created_at": "2026-07-01T00:00:00+00:00",
    "expires_at": "2099-01-01T00:00:00+00:00",
}


@contextmanager
def _patched(request_row: dict | None = None, events: list[dict] | None = None):
    directus = AsyncMock()

    async def get_item(collection: str, item_id: str):
        if collection == "support_access_request":
            return dict(request_row) if request_row else None
        return None

    async def get_items(collection: str, params: dict | None = None):
        if collection == "support_access_event":
            return list(events or [])
        if collection == "support_access_request":
            return [dict(request_row)] if request_row else []
        if collection == "app_user":
            return [
                {"id": "au-staff", "display_name": "Sam Staff"},
                {"id": "au-admin", "display_name": "Ada Admin"},
            ]
        return []

    directus.get_item = AsyncMock(side_effect=get_item)
    directus.get_items = AsyncMock(side_effect=get_items)
    directus.update_item = AsyncMock(return_value={"data": {}})
    mocks = SimpleNamespace(
        directus=directus,
        grant=AsyncMock(return_value=("joined", "m-1", "2026-07-04T00:00:00+00:00")),
        record_event=AsyncMock(return_value="ev-1"),
        cancel=AsyncMock(return_value=1),
    )
    with ExitStack() as stack:
        stack.enter_context(
            patch("dembrane.api.v2.support_access.async_directus", directus)
        )
        stack.enter_context(
            patch("dembrane.support_access.grant_support_membership", mocks.grant)
        )
        stack.enter_context(
            patch(
                "dembrane.support_access.record_support_access_event",
                mocks.record_event,
            )
        )
        stack.enter_context(
            patch("dembrane.scheduled_tasks.cancel_pending_tasks", mocks.cancel)
        )
        yield mocks


async def _get(app: FastAPI, path: str):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.get(f"/v2/workspaces/{_WS_ID}{path}")


async def _post(app: FastAPI, path: str):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.post(f"/v2/workspaces/{_WS_ID}{path}")


@pytest.mark.asyncio
async def test_events_requires_settings_manage():
    with _patched():
        res = await _get(_build_app(can_manage=False), "/support-access/events")
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_events_lists_with_names_and_has_more():
    events = [
        {
            "id": f"ev-{i}",
            "event_code": "staff_joined",
            "created_at": "2026-07-01T00:00:00+00:00",
            "actor_user_id": "au-staff",
            "staff_user_id": "au-staff",
            "params": {},
        }
        for i in range(3)
    ]
    with _patched(events=events):
        res = await _get(_build_app(), "/support-access/events?page=1&limit=2")
    assert res.status_code == 200
    body = res.json()
    assert len(body["events"]) == 2
    assert body["has_more"] is True
    assert body["events"][0]["staff_name"] == "Sam Staff"


@pytest.mark.asyncio
async def test_pending_requests_resolve_requester_name():
    with _patched(request_row=_PENDING):
        res = await _get(_build_app(), "/support-access/requests")
    assert res.status_code == 200
    body = res.json()
    assert body["requests"][0]["requested_by_name"] == "Sam Staff"
    assert body["requests"][0]["message"] == "billing bug"


@pytest.mark.asyncio
async def test_approve_grants_membership_and_resolves_request():
    with _patched(request_row=_PENDING) as mocks:
        res = await _post(_build_app(), "/support-access/requests/req-1/approve")
    assert res.status_code == 200
    assert res.json()["status"] == "approved"
    assert mocks.grant.call_args.kwargs["app_user_id"] == "au-staff"
    update_args = mocks.directus.update_item.call_args.args
    assert update_args[0] == "support_access_request"
    assert update_args[2]["status"] == "approved"
    assert update_args[2]["membership_id"] == "m-1"
    assert mocks.cancel.call_args.kwargs["payload_match"] == {"request_id": "req-1"}
    assert mocks.record_event.call_args.kwargs["event_code"] == "request_approved"


@pytest.mark.asyncio
async def test_approve_non_pending_conflicts():
    resolved = dict(_PENDING, status="denied")
    with _patched(request_row=resolved):
        res = await _post(_build_app(), "/support-access/requests/req-1/approve")
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_approve_elapsed_request_conflicts_and_expires():
    stale = dict(_PENDING, expires_at="2020-01-01T00:00:00+00:00")
    with _patched(request_row=stale) as mocks:
        res = await _post(_build_app(), "/support-access/requests/req-1/approve")
    assert res.status_code == 409
    assert mocks.directus.update_item.call_args.args[2]["status"] == "expired"


@pytest.mark.asyncio
async def test_approve_missing_request_404():
    with _patched(request_row=None):
        res = await _post(_build_app(), "/support-access/requests/req-x/approve")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_deny_resolves_and_records():
    with _patched(request_row=_PENDING) as mocks:
        res = await _post(_build_app(), "/support-access/requests/req-1/deny")
    assert res.status_code == 200
    assert res.json()["status"] == "denied"
    assert mocks.directus.update_item.call_args.args[2]["status"] == "denied"
    assert mocks.record_event.call_args.kwargs["event_code"] == "request_denied"
