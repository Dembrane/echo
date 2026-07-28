"""Toggle PATCH side effects: flipping allow_support_access on schedules the
7-day reminder, records the event, and supersedes pending requests; flipping
it off cancels reminders and records. Same-value writes do nothing."""

from __future__ import annotations

from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.middleware import get_workspace_context
from dembrane.api.v2.workspace_settings import router as settings_router

_WS_ID = "ws-1"


class _FakeCtx:
    def __init__(self, toggle_on: bool):
        self.workspace_id = _WS_ID
        self.workspace = {
            "id": _WS_ID,
            "org_id": "org-1",
            "allow_support_access": toggle_on,
            "visibility": "open_to_organisation",
            "logo_url": None,
        }
        self.app_user_id = "au-admin"

    def require_policy(self, policy: str) -> None:
        return None

    def has_policy(self, policy: str) -> bool:
        return True


def _build_app(toggle_on: bool) -> FastAPI:
    app = FastAPI()
    app.dependency_overrides[get_workspace_context] = lambda: _FakeCtx(toggle_on)
    app.include_router(settings_router, prefix="/v2/workspaces")
    return app


@contextmanager
def _patched():
    directus = AsyncMock()
    directus.update_item = AsyncMock(return_value={"data": {}})
    mocks = SimpleNamespace(
        directus=directus,
        record_event=AsyncMock(return_value="ev-1"),
        schedule=AsyncMock(return_value="task-1"),
        cancel=AsyncMock(return_value=1),
        supersede=AsyncMock(return_value=0),
    )
    with ExitStack() as stack:
        stack.enter_context(
            patch("dembrane.api.v2.workspace_settings.async_directus", directus)
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
        stack.enter_context(
            patch(
                "dembrane.support_access.cancel_pending_requests_for_toggle_on",
                mocks.supersede,
            )
        )
        yield mocks


async def _patch_settings(app: FastAPI, body: dict):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.patch(f"/v2/workspaces/{_WS_ID}/settings", json=body)


@pytest.mark.asyncio
async def test_enable_schedules_reminder_and_supersedes_pending():
    with _patched() as mocks:
        res = await _patch_settings(_build_app(toggle_on=False), {"allow_support_access": True})
    assert res.status_code == 200
    assert mocks.schedule.call_args.kwargs["task_type"] == "support_toggle_reminder"
    assert mocks.schedule.call_args.kwargs["payload"] == {"workspace_id": _WS_ID}
    assert mocks.record_event.call_args.kwargs["event_code"] == "toggle_enabled"
    assert mocks.supersede.await_count == 1


@pytest.mark.asyncio
async def test_disable_cancels_reminder_and_records():
    with _patched() as mocks:
        res = await _patch_settings(_build_app(toggle_on=True), {"allow_support_access": False})
    assert res.status_code == 200
    assert mocks.cancel.call_args.kwargs["task_type"] == "support_toggle_reminder"
    assert mocks.record_event.call_args.kwargs["event_code"] == "toggle_disabled"
    assert mocks.supersede.await_count == 0


@pytest.mark.asyncio
async def test_same_value_is_a_no_op():
    with _patched() as mocks:
        res = await _patch_settings(_build_app(toggle_on=True), {"allow_support_access": True})
    assert res.status_code == 200
    assert mocks.schedule.await_count == 0
    assert mocks.record_event.await_count == 0


@pytest.mark.asyncio
async def test_unrelated_update_is_untouched():
    with _patched() as mocks:
        res = await _patch_settings(_build_app(toggle_on=True), {"name": "New Name"})
    assert res.status_code == 200
    assert mocks.record_event.await_count == 0
