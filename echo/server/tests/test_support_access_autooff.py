"""Auto-off: when the last active staff_support membership ends, the toggle
flips off, reminder timers are cancelled, and the customer gets ONE combined
"session ended, access turned off" notice. Another active session, or a
toggle that is already off, must leave everything alone."""

from __future__ import annotations

from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest

from dembrane import support_access as sa

_WS_ID = "ws-1"


@contextmanager
def _patched(ws: dict, active_rows: list[dict]):
    directus = AsyncMock()
    directus.get_item = AsyncMock(return_value=ws)
    directus.get_items = AsyncMock(return_value=active_rows)
    directus.update_item = AsyncMock(return_value={"data": {}})
    mocks = SimpleNamespace(
        directus=directus,
        record_event=AsyncMock(return_value="ev-1"),
        cancel=AsyncMock(return_value=1),
    )
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.support_access.async_directus", directus))
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


@pytest.mark.asyncio
async def test_last_staff_out_flips_toggle_and_records():
    ws = {"id": _WS_ID, "allow_support_access": True}
    with _patched(ws, active_rows=[]) as mocks:
        flipped = await sa.maybe_auto_disable_support_access(workspace_id=_WS_ID)
    assert flipped is True
    args = mocks.directus.update_item.call_args.args
    assert args[0] == "workspace"
    assert args[2] == {"allow_support_access": False}
    assert mocks.cancel.call_args.kwargs["task_type"] == "support_toggle_reminder"
    assert mocks.record_event.call_args.kwargs["event_code"] == "toggle_auto_disabled"


@pytest.mark.asyncio
async def test_other_active_session_prevents_auto_off():
    ws = {"id": _WS_ID, "allow_support_access": True}
    active = [{"id": "m-2", "expires_at": "2099-01-01T00:00:00+00:00"}]
    with _patched(ws, active_rows=active) as mocks:
        flipped = await sa.maybe_auto_disable_support_access(workspace_id=_WS_ID)
    assert flipped is False
    assert mocks.directus.update_item.await_count == 0


@pytest.mark.asyncio
async def test_toggle_already_off_is_a_no_op():
    ws = {"id": _WS_ID, "allow_support_access": False}
    with _patched(ws, active_rows=[]) as mocks:
        flipped = await sa.maybe_auto_disable_support_access(workspace_id=_WS_ID)
    assert flipped is False
    assert mocks.directus.update_item.await_count == 0
    assert mocks.record_event.await_count == 0


@pytest.mark.asyncio
async def test_elapsed_expiry_rows_do_not_count_as_active():
    ws = {"id": _WS_ID, "allow_support_access": True}
    stale = [{"id": "m-3", "expires_at": "2020-01-01T00:00:00+00:00"}]
    with _patched(ws, active_rows=stale):
        flipped = await sa.maybe_auto_disable_support_access(workspace_id=_WS_ID)
    assert flipped is True
