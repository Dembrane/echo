"""The weekly "support access is still on" reminder. Fires only when the
toggle is on AND no staff session is active; always re-arms itself while the
toggle stays on; goes quiet the moment the toggle is off."""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.tasks import _support_toggle_reminder_async

_WS_ID = "ws-1"


@contextmanager
def _patched(ws: dict | None, memberships: list[dict]):
    directus = AsyncMock()
    directus.get_item = AsyncMock(return_value=ws)
    directus.get_items = AsyncMock(return_value=memberships)
    record = AsyncMock(return_value="ev-1")
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.directus_async.async_directus", directus))
        stack.enter_context(
            patch("dembrane.support_access.record_support_access_event", record)
        )
        yield record


@pytest.mark.asyncio
async def test_toggle_off_stops_the_loop():
    ws = {"id": _WS_ID, "allow_support_access": False}
    with _patched(ws, []) as record:
        next_at = await _support_toggle_reminder_async(_WS_ID)
    assert next_at is None
    assert record.await_count == 0


@pytest.mark.asyncio
async def test_active_staff_session_reschedules_silently():
    ws = {"id": _WS_ID, "allow_support_access": True}
    active = [{"id": "m-1", "expires_at": "2099-01-01T00:00:00+00:00"}]
    with _patched(ws, active) as record:
        next_at = await _support_toggle_reminder_async(_WS_ID)
    assert next_at is not None
    assert record.await_count == 0


@pytest.mark.asyncio
async def test_on_and_unused_sends_reminder_and_reschedules():
    ws = {"id": _WS_ID, "allow_support_access": True}
    with _patched(ws, []) as record:
        next_at = await _support_toggle_reminder_async(_WS_ID)
    assert next_at is not None
    assert record.call_args.kwargs["event_code"] == "reminder_sent"


@pytest.mark.asyncio
async def test_deleted_workspace_stops_the_loop():
    with _patched(None, []) as record:
        next_at = await _support_toggle_reminder_async(_WS_ID)
    assert next_at is None
    assert record.await_count == 0
