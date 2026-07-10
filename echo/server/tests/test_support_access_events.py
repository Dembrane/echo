"""Tests for dembrane/support_access.py: the audit + notification choke point.

record_support_access_event() must (a) append the audit row, (b) fan out the
right in-app notification and email per event code, and (c) never raise: a
broken audit write or notification must not fail the parent action.
"""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest

from dembrane import support_access as sa

_WS_ID = "ws-1"
_WS = {"id": _WS_ID, "name": "Client Alpha", "org_id": "org-1"}


@contextmanager
def _patched(ws: dict | None = _WS, admins: list[str] | None = None):
    directus = AsyncMock()
    directus.get_item = AsyncMock(return_value=ws)
    directus.get_items = AsyncMock(
        return_value=[{"email": "admin@client.test"}]  # _emails_for_app_users
    )
    directus.create_item = AsyncMock(return_value={"data": {}})
    mocks = {
        "directus": directus,
        "emit": AsyncMock(return_value="n-1"),
        "emit_to_audience": AsyncMock(return_value=["n-1"]),
        "audience": AsyncMock(return_value=admins if admins is not None else ["au-admin"]),
        "send_email": AsyncMock(return_value=True),
    }
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.support_access.async_directus", directus))
        stack.enter_context(patch("dembrane.notifications.emit", mocks["emit"]))
        stack.enter_context(
            patch("dembrane.notifications.emit_to_audience", mocks["emit_to_audience"])
        )
        stack.enter_context(
            patch(
                "dembrane.notifications.audience_workspace_admins", mocks["audience"]
            )
        )
        stack.enter_context(patch("dembrane.email.send_email", mocks["send_email"]))
        yield mocks


@pytest.mark.asyncio
async def test_writes_audit_row():
    with _patched() as m:
        event_id = await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_STAFF_JOINED,
            staff_user_id="au-staff",
        )
    assert event_id is not None
    collection, payload = m["directus"].create_item.call_args.args
    assert collection == sa.EVENT_COLLECTION
    assert payload["workspace_id"] == _WS_ID
    assert payload["event_code"] == sa.EVENT_STAFF_JOINED
    assert payload["staff_user_id"] == "au-staff"
    assert payload["created_at"]


@pytest.mark.asyncio
async def test_audit_write_failure_never_raises_and_still_notifies():
    with _patched() as m:
        m["directus"].create_item.side_effect = RuntimeError("directus down")
        event_id = await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_STAFF_JOINED,
            staff_user_id="au-staff",
        )
    assert event_id is None
    assert m["emit_to_audience"].await_count == 1


@pytest.mark.asyncio
async def test_request_created_notifies_admins_in_app_and_email():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_REQUEST_CREATED,
            actor_user_id="au-staff",
            staff_user_id="au-staff",
            params={"request_id": "req-1", "message": "billing bug"},
        )
    kwargs = m["emit_to_audience"].call_args.kwargs
    assert kwargs["event_code"] == "SUPPORT_ACCESS_REQUESTED"
    assert kwargs["action"] == "NAVIGATE_WORKSPACE_SETTINGS"
    assert "Client Alpha" in kwargs["title"]
    email_kwargs = m["send_email"].call_args.kwargs
    assert email_kwargs["template"] == "support_access_request"
    assert email_kwargs["to"] == ["admin@client.test"]


@pytest.mark.asyncio
async def test_staff_extended_is_in_app_only():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_STAFF_EXTENDED,
            staff_user_id="au-staff",
        )
    assert m["emit_to_audience"].await_count == 1
    assert m["send_email"].await_count == 0


@pytest.mark.asyncio
async def test_toggle_auto_disabled_sends_combined_ended_notice():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID, event_code=sa.EVENT_TOGGLE_AUTO_DISABLED
        )
    kwargs = m["emit_to_audience"].call_args.kwargs
    assert kwargs["event_code"] == "SUPPORT_ACCESS_ENDED"
    assert m["send_email"].call_args.kwargs["template"] == "support_access_ended"


@pytest.mark.asyncio
async def test_request_approved_notifies_the_staff_member():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_REQUEST_APPROVED,
            actor_user_id="au-admin",
            staff_user_id="au-staff",
            params={"request_id": "req-1"},
        )
    kwargs = m["emit"].call_args.kwargs
    assert kwargs["audience_user_id"] == "au-staff"
    assert kwargs["event_code"] == "SUPPORT_REQUEST_APPROVED"
    assert m["send_email"].call_args.kwargs["template"] == "support_access_request_resolved"


@pytest.mark.asyncio
async def test_toggle_enabled_records_but_does_not_notify():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_TOGGLE_ENABLED,
            actor_user_id="au-admin",
        )
    assert m["directus"].create_item.await_count == 1
    assert m["emit"].await_count == 0
    assert m["emit_to_audience"].await_count == 0
    assert m["send_email"].await_count == 0


@pytest.mark.asyncio
async def test_notify_false_skips_fan_out():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_STAFF_LEFT,
            staff_user_id="au-staff",
            notify=False,
        )
    assert m["directus"].create_item.await_count == 1
    assert m["emit_to_audience"].await_count == 0


@pytest.mark.asyncio
async def test_reminder_severity_is_action_required():
    from dembrane.notifications import severity_for

    assert severity_for("SUPPORT_ACCESS_REQUESTED") == "action_required"
    assert severity_for("SUPPORT_ACCESS_REMINDER") == "action_required"
    assert severity_for("SUPPORT_STAFF_JOINED") == "info"
