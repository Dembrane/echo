"""Tests for workspace request notifications + emails (slice 12).

Covers:
- Event codes registered with correct severity.
- audience_staff() resolves Directus admin users → app_user IDs.
- Submit endpoint emits WORKSPACE_REQUEST_SUBMITTED to staff (in-app + email).
- Approve action emits WORKSPACE_REQUEST_APPROVED to requester with deep link.
- Deny action emits WORKSPACE_REQUEST_DENIED to requester including denial_reason.
- Email templates exist and render without errors.
- TIER_EXPIRED event code registered (placeholder, no emission).
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import BackgroundTasks

from dembrane.notifications import (
    _SEVERITY_BY_EVENT,
    severity_for,
    audience_staff,
)

# ── Event code registration ─────────────────────────────────────────


class TestEventCodeRegistration:
    """Verify the four new event codes are registered with correct severity."""

    def test_workspace_request_submitted_is_action_required(self):
        assert severity_for("WORKSPACE_REQUEST_SUBMITTED") == "action_required"
        assert _SEVERITY_BY_EVENT["WORKSPACE_REQUEST_SUBMITTED"] == "action_required"

    def test_workspace_request_approved_defaults_info(self):
        assert severity_for("WORKSPACE_REQUEST_APPROVED") == "info"
        assert "WORKSPACE_REQUEST_APPROVED" not in _SEVERITY_BY_EVENT

    def test_workspace_request_denied_defaults_info(self):
        assert severity_for("WORKSPACE_REQUEST_DENIED") == "info"
        assert "WORKSPACE_REQUEST_DENIED" not in _SEVERITY_BY_EVENT

    def test_tier_expired_is_destructive(self):
        assert severity_for("TIER_EXPIRED") == "destructive"
        assert _SEVERITY_BY_EVENT["TIER_EXPIRED"] == "destructive"


# ── audience_staff() ─────────────────────────────────────────────────


class TestAudienceStaff:
    """audience_staff() queries Directus admin users and maps to app_user IDs."""

    @pytest.mark.asyncio
    async def test_returns_app_user_ids_for_admin_users(self):
        mock_directus = AsyncMock()
        mock_directus.get_users = AsyncMock(
            return_value=[
                {"id": "d-user-1", "admin_access": True},
                {"id": "d-user-2", "admin_access": True},
            ]
        )
        mock_directus.get_items.return_value = [
            {"id": "app-user-1"},
            {"id": "app-user-2"},
        ]

        with patch("dembrane.notifications.async_directus", mock_directus):
            result = await audience_staff()

        assert set(result) == {"app-user-1", "app-user-2"}
        mock_directus.get_users.assert_called_once()
        gu_call = mock_directus.get_users.call_args
        assert "admin_access" in str(gu_call)
        mock_directus.get_items.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_empty_on_no_admin_users(self):
        mock_directus = AsyncMock()
        mock_directus.get_users = AsyncMock(return_value=[])

        with patch("dembrane.notifications.async_directus", mock_directus):
            result = await audience_staff()

        assert result == []

    @pytest.mark.asyncio
    async def test_returns_empty_on_error(self):
        mock_directus = AsyncMock()
        mock_directus.get_users = AsyncMock(side_effect=Exception("connection failed"))

        with patch("dembrane.notifications.async_directus", mock_directus):
            result = await audience_staff()

        assert result == []

    @pytest.mark.asyncio
    async def test_returns_empty_on_non_list_response(self):
        mock_directus = AsyncMock()
        mock_directus.get_users = AsyncMock(return_value="not a list")

        with patch("dembrane.notifications.async_directus", mock_directus):
            result = await audience_staff()

        assert result == []

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_app_user_mapping(self):
        mock_directus = AsyncMock()
        mock_directus.get_users = AsyncMock(
            return_value=[{"id": "d-user-1", "admin_access": True}]
        )
        mock_directus.get_items.return_value = []

        with patch("dembrane.notifications.async_directus", mock_directus):
            result = await audience_staff()

        assert result == []


# ── _resolve_emails ──────────────────────────────────────────────────


class TestResolveEmails:
    """_resolve_emails maps app_user IDs → email addresses."""

    @pytest.mark.asyncio
    async def test_resolves_emails(self):
        from dembrane.api.v2.workspace_requests import _resolve_emails

        mock_directus = AsyncMock()
        mock_directus.get_items.return_value = [
            {"email": "alice@example.com"},
            {"email": "bob@example.com"},
        ]

        with patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus):
            result = await _resolve_emails(["u1", "u2"])

        assert result == ["alice@example.com", "bob@example.com"]

    @pytest.mark.asyncio
    async def test_empty_input(self):
        from dembrane.api.v2.workspace_requests import _resolve_emails

        result = await _resolve_emails([])
        assert result == []

    @pytest.mark.asyncio
    async def test_deduplicates(self):
        from dembrane.api.v2.workspace_requests import _resolve_emails

        mock_directus = AsyncMock()
        mock_directus.get_items.return_value = [
            {"email": "same@example.com"},
            {"email": "same@example.com"},
        ]

        with patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus):
            result = await _resolve_emails(["u1", "u2"])

        assert result == ["same@example.com"]

    @pytest.mark.asyncio
    async def test_skips_empty_emails(self):
        from dembrane.api.v2.workspace_requests import _resolve_emails

        mock_directus = AsyncMock()
        mock_directus.get_items.return_value = [
            {"email": ""},
            {"email": None},
            {"email": "valid@example.com"},
        ]

        with patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus):
            result = await _resolve_emails(["u1", "u2", "u3"])

        assert result == ["valid@example.com"]

    @pytest.mark.asyncio
    async def test_returns_empty_on_error(self):
        from dembrane.api.v2.workspace_requests import _resolve_emails

        mock_directus = AsyncMock()
        mock_directus.get_items.side_effect = Exception("db down")

        with patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus):
            result = await _resolve_emails(["u1"])

        assert result == []


# ── Submit wiring ────────────────────────────────────────────────────


class TestSubmitNotificationWiring:
    """Submit endpoint fires WORKSPACE_REQUEST_SUBMITTED to staff."""

    def _make_auth(self, user_id="directus-u1", is_admin=False):
        auth = MagicMock()
        auth.user_id = user_id
        auth.is_admin = is_admin
        auth.token = "tok"
        return auth

    @pytest.mark.asyncio
    async def test_submit_fires_notification_to_staff(self):
        from dembrane.api.v2.workspace_requests import (
            SubmitWorkspaceRequest,
            submit_workspace_request,
        )

        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="My Workspace",
            proposed_tier="innovator",
        )
        auth = self._make_auth()

        mock_directus = AsyncMock()
        mock_directus.get_items.side_effect = [
            [{"role": "owner", "user_id": "app-u1"}],  # org_membership check
            None,  # create_item (not called via get_items)
        ]
        mock_directus.create_item.return_value = {"data": {"id": "req-1"}}
        mock_directus.get_item.return_value = {"name": "Test Org"}

        mock_app_user = AsyncMock(return_value={
            "id": "app-u1",
            "display_name": "Alice",
            "email": "alice@example.com",
        })

        mock_audience_staff = AsyncMock(return_value=["staff-1", "staff-2"])
        mock_emit_to_audience = AsyncMock(return_value=["n-1", "n-2"])
        mock_send_email = AsyncMock(return_value=True)
        mock_resolve_emails = AsyncMock(return_value=["staff@example.com"])

        with (
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", mock_app_user),
            patch("dembrane.api.v2.workspace_requests.audience_staff", mock_audience_staff),
            patch("dembrane.api.v2.workspace_requests.emit_to_audience", mock_emit_to_audience),
            patch("dembrane.api.v2.workspace_requests.send_email", mock_send_email),
            patch("dembrane.api.v2.workspace_requests._resolve_emails", mock_resolve_emails),
        ):
            bg = BackgroundTasks()
            result = await submit_workspace_request(body, auth, bg)
            # Drain the queue so the mocks see the side-effect calls.
            await bg()

        assert result.status == "pending"

        mock_emit_to_audience.assert_called_once()
        emit_call_kwargs = mock_emit_to_audience.call_args
        assert emit_call_kwargs[0][0] == ["staff-1", "staff-2"]
        assert emit_call_kwargs[1]["event_code"] == "WORKSPACE_REQUEST_SUBMITTED"
        assert "Alice" in emit_call_kwargs[1]["title"]
        assert "new workspace" in emit_call_kwargs[1]["title"]

        # Emails are now sent per-recipient (for throttle tracking)
        mock_send_email.assert_called_once()
        email_kwargs = mock_send_email.call_args[1]
        assert email_kwargs["template"] == "workspace_request_submitted"
        assert email_kwargs["to"] == "staff@example.com"
        assert email_kwargs["template_data"]["requester_name"] == "Alice"
        assert email_kwargs["template_data"]["kind_label"] == "new workspace"

    @pytest.mark.asyncio
    async def test_submit_skips_email_when_no_staff_emails(self):
        from dembrane.api.v2.workspace_requests import (
            SubmitWorkspaceRequest,
            submit_workspace_request,
        )

        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="My Workspace",
        )
        auth = self._make_auth()

        mock_directus = AsyncMock()
        mock_directus.get_items.return_value = [{"role": "owner", "user_id": "app-u1"}]
        mock_directus.create_item.return_value = {"data": {"id": "req-1"}}
        mock_directus.get_item.return_value = {"name": "Test Org"}

        mock_app_user = AsyncMock(return_value={
            "id": "app-u1", "display_name": "Alice", "email": "alice@x.com",
        })
        mock_audience_staff = AsyncMock(return_value=["staff-1"])
        mock_emit = AsyncMock(return_value=["n-1"])
        mock_send_email = AsyncMock(return_value=True)
        mock_resolve_emails = AsyncMock(return_value=[])

        with (
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", mock_app_user),
            patch("dembrane.api.v2.workspace_requests.audience_staff", mock_audience_staff),
            patch("dembrane.api.v2.workspace_requests.emit_to_audience", mock_emit),
            patch("dembrane.api.v2.workspace_requests.send_email", mock_send_email),
            patch("dembrane.api.v2.workspace_requests._resolve_emails", mock_resolve_emails),
        ):
            bg = BackgroundTasks()
            result = await submit_workspace_request(body, auth, bg)
            # Drain the queue so the mocks see the side-effect calls.
            await bg()

        assert result.status == "pending"
        mock_emit.assert_called_once()
        mock_send_email.assert_not_called()

    @pytest.mark.asyncio
    async def test_submit_tier_upgrade_fires_notification(self):
        from dembrane.api.v2.workspace_requests import (
            SubmitWorkspaceRequest,
            submit_workspace_request,
        )

        body = SubmitWorkspaceRequest(
            kind="tier_upgrade",
            org_id="org-1",
            workspace_id="ws-1",
            proposed_tier="pioneer",
        )
        auth = self._make_auth()

        mock_directus = AsyncMock()
        mock_directus.get_items.side_effect = [
            [{"role": "admin", "user_id": "app-u1"}],  # ws_membership
            [],  # no existing pending request
        ]
        mock_directus.create_item.return_value = {"data": {"id": "req-1"}}
        mock_directus.get_item.return_value = {"id": "ws-1", "org_id": "org-1", "name": "Test Org"}

        mock_app_user = AsyncMock(return_value={
            "id": "app-u1", "display_name": "Bob", "email": "bob@x.com",
        })
        mock_audience_staff = AsyncMock(return_value=["staff-1"])
        mock_emit = AsyncMock(return_value=["n-1"])
        mock_send_email = AsyncMock(return_value=True)
        mock_resolve_emails = AsyncMock(return_value=["staff@x.com"])

        with (
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", mock_app_user),
            patch("dembrane.api.v2.workspace_requests.audience_staff", mock_audience_staff),
            patch("dembrane.api.v2.workspace_requests.emit_to_audience", mock_emit),
            patch("dembrane.api.v2.workspace_requests.send_email", mock_send_email),
            patch("dembrane.api.v2.workspace_requests._resolve_emails", mock_resolve_emails),
        ):
            bg = BackgroundTasks()
            result = await submit_workspace_request(body, auth, bg)
            # Drain the queue so the mocks see the side-effect calls.
            await bg()

        assert result.status == "pending"
        emit_kwargs = mock_emit.call_args[1]
        assert emit_kwargs["event_code"] == "WORKSPACE_REQUEST_SUBMITTED"
        assert "tier upgrade" in emit_kwargs["title"]


# ── Approve wiring ───────────────────────────────────────────────────


class TestApproveNotificationWiring:
    """Approve action fires WORKSPACE_REQUEST_APPROVED to requester."""

    @pytest.mark.asyncio
    async def test_approve_fires_notification_and_email(self):
        from dembrane.api.v2.admin import _notify_requester_approved

        mock_directus = AsyncMock()
        # Only the requester lookup now — workspace name comes from the caller.
        mock_directus.get_item.return_value = {
            "display_name": "Alice", "email": "alice@example.com",
        }

        mock_emit = AsyncMock(return_value="n-1")
        mock_send_email = AsyncMock(return_value=True)

        req = {
            "id": "req-1",
            "kind": "new_workspace",
            "requested_by": "app-u1",
            "proposed_name": "My Workspace",
            "org_id": "org-1",
        }

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.api.v2.admin.emit", mock_emit),
            patch("dembrane.api.v2.admin.send_email", mock_send_email),
        ):
            await _notify_requester_approved(req, "innovator", "ws-1")

        mock_emit.assert_called_once()
        emit_kwargs = mock_emit.call_args[1]
        assert emit_kwargs["audience_user_id"] == "app-u1"
        assert emit_kwargs["event_code"] == "WORKSPACE_REQUEST_APPROVED"
        assert "approved" in emit_kwargs["title"]
        assert emit_kwargs["action"] == "NAVIGATE_WS"
        assert emit_kwargs["ref_workspace_id"] == "ws-1"

        mock_send_email.assert_called_once()
        email_kwargs = mock_send_email.call_args[1]
        assert email_kwargs["to"] == "alice@example.com"
        assert email_kwargs["template"] == "workspace_request_approved"
        assert email_kwargs["template_data"]["granted_tier"] == "innovator"
        assert "/w/ws-1" in email_kwargs["template_data"]["workspace_url"]

    @pytest.mark.asyncio
    async def test_approve_skips_email_when_no_requester_email(self):
        from dembrane.api.v2.admin import _notify_requester_approved

        mock_directus = AsyncMock()
        mock_directus.get_item.return_value = {"display_name": "Alice", "email": ""}

        mock_emit = AsyncMock(return_value="n-1")
        mock_send_email = AsyncMock(return_value=True)

        req = {"id": "r1", "kind": "new_workspace", "requested_by": "u1", "org_id": "o1"}

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.api.v2.admin.emit", mock_emit),
            patch("dembrane.api.v2.admin.send_email", mock_send_email),
        ):
            await _notify_requester_approved(req, "pioneer", "ws-1")

        mock_emit.assert_called_once()
        mock_send_email.assert_not_called()

    @pytest.mark.asyncio
    async def test_approve_noop_when_no_requester(self):
        from dembrane.api.v2.admin import _notify_requester_approved

        mock_emit = AsyncMock()
        mock_send_email = AsyncMock()

        req = {"id": "r1", "kind": "new_workspace", "requested_by": None, "org_id": "o1"}

        with (
            patch("dembrane.api.v2.admin.emit", mock_emit),
            patch("dembrane.api.v2.admin.send_email", mock_send_email),
        ):
            await _notify_requester_approved(req, "pioneer", "ws-1")

        mock_emit.assert_not_called()
        mock_send_email.assert_not_called()

    @pytest.mark.asyncio
    async def test_approve_tier_upgrade_message(self):
        from dembrane.api.v2.admin import _notify_requester_approved

        mock_directus = AsyncMock()
        mock_directus.get_item.return_value = {"display_name": "Bob", "email": "bob@x.com"}

        mock_emit = AsyncMock(return_value="n-1")
        mock_send_email = AsyncMock(return_value=True)

        req = {
            "id": "r2",
            "kind": "tier_upgrade",
            "requested_by": "u2",
            "workspace_id": "ws-2",
            "org_id": "o1",
        }

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.api.v2.admin.emit", mock_emit),
            patch("dembrane.api.v2.admin.send_email", mock_send_email),
        ):
            await _notify_requester_approved(req, "changemaker", "ws-2", workspace_name="Upgraded WS")

        assert "tier upgrade" in mock_emit.call_args[1]["title"]
        assert "Upgraded WS" in mock_emit.call_args[1]["message"]


# ── Deny wiring ──────────────────────────────────────────────────────


class TestDenyNotificationWiring:
    """Deny action fires WORKSPACE_REQUEST_DENIED to requester."""

    @pytest.mark.asyncio
    async def test_deny_fires_notification_and_email(self):
        from dembrane.api.v2.admin import _notify_requester_denied

        mock_directus = AsyncMock()
        mock_directus.get_item.return_value = {
            "display_name": "Alice",
            "email": "alice@example.com",
        }

        mock_emit = AsyncMock(return_value="n-1")
        mock_send_email = AsyncMock(return_value=True)

        req = {
            "id": "req-1",
            "kind": "new_workspace",
            "requested_by": "app-u1",
            "org_id": "org-1",
            "workspace_id": None,
        }

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.api.v2.admin.emit", mock_emit),
            patch("dembrane.api.v2.admin.send_email", mock_send_email),
        ):
            await _notify_requester_denied(req, "Not enough seats available")

        mock_emit.assert_called_once()
        emit_kwargs = mock_emit.call_args[1]
        assert emit_kwargs["audience_user_id"] == "app-u1"
        assert emit_kwargs["event_code"] == "WORKSPACE_REQUEST_DENIED"
        assert "not approved" in emit_kwargs["title"]
        assert "Not enough seats" in emit_kwargs["message"]

        mock_send_email.assert_called_once()
        email_kwargs = mock_send_email.call_args[1]
        assert email_kwargs["to"] == "alice@example.com"
        assert email_kwargs["template"] == "workspace_request_denied"
        assert email_kwargs["template_data"]["denial_reason"] == "Not enough seats available"
        assert email_kwargs["template_data"]["kind_label"] == "new workspace"

    @pytest.mark.asyncio
    async def test_deny_truncates_long_reason_in_notification(self):
        from dembrane.api.v2.admin import _notify_requester_denied

        mock_directus = AsyncMock()
        mock_directus.get_item.return_value = {
            "display_name": "Alice", "email": "alice@example.com",
        }

        mock_emit = AsyncMock(return_value="n-1")
        mock_send_email = AsyncMock(return_value=True)

        req = {"id": "r1", "kind": "tier_upgrade", "requested_by": "u1", "org_id": "o1"}
        long_reason = "x" * 500

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.api.v2.admin.emit", mock_emit),
            patch("dembrane.api.v2.admin.send_email", mock_send_email),
        ):
            await _notify_requester_denied(req, long_reason)

        assert len(mock_emit.call_args[1]["message"]) == 200

    @pytest.mark.asyncio
    async def test_deny_skips_email_when_no_email(self):
        from dembrane.api.v2.admin import _notify_requester_denied

        mock_directus = AsyncMock()
        mock_directus.get_item.return_value = {"display_name": "Alice", "email": ""}

        mock_emit = AsyncMock(return_value="n-1")
        mock_send_email = AsyncMock(return_value=True)

        req = {"id": "r1", "kind": "new_workspace", "requested_by": "u1", "org_id": "o1"}

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.api.v2.admin.emit", mock_emit),
            patch("dembrane.api.v2.admin.send_email", mock_send_email),
        ):
            await _notify_requester_denied(req, "Not eligible")

        mock_emit.assert_called_once()
        mock_send_email.assert_not_called()

    @pytest.mark.asyncio
    async def test_deny_noop_when_no_requester(self):
        from dembrane.api.v2.admin import _notify_requester_denied

        mock_emit = AsyncMock()
        mock_send_email = AsyncMock()

        req = {"id": "r1", "kind": "new_workspace", "requested_by": None, "org_id": "o1"}

        with (
            patch("dembrane.api.v2.admin.emit", mock_emit),
            patch("dembrane.api.v2.admin.send_email", mock_send_email),
        ):
            await _notify_requester_denied(req, "reason")

        mock_emit.assert_not_called()
        mock_send_email.assert_not_called()


# ── Email template rendering ────────────────────────────────────────


class TestEmailTemplates:
    """Email templates exist and render without errors."""

    def test_submitted_html_renders(self):
        from dembrane.email import _render_template

        html = _render_template("workspace_request_submitted", {
            "requester_name": "Alice",
            "requester_email": "alice@x.com",
            "kind_label": "new workspace",
            "org_name": "Test Org",
            "proposed_tier": "innovator",
            "proposed_name": "My WS",
            "requester_message": "Please approve",
            "admin_url": "https://echo.dembrane.com/admin/upgrades",
        })
        assert "Alice" in html
        assert "new workspace" in html
        assert "innovator" in html
        assert "My WS" in html
        assert "Please approve" in html
        assert "admin/upgrades" in html

    def test_submitted_txt_renders(self):
        from dembrane.email import _render_plain_text_template

        txt = _render_plain_text_template("workspace_request_submitted", {
            "requester_name": "Alice",
            "requester_email": "alice@x.com",
            "kind_label": "new workspace",
            "org_name": "Test Org",
            "proposed_tier": "innovator",
            "proposed_name": "My WS",
            "requester_message": "Please approve",
            "admin_url": "https://echo.dembrane.com/admin/upgrades",
        })
        assert txt is not None
        assert "Alice" in txt
        assert "innovator" in txt

    def test_approved_html_renders(self):
        from dembrane.email import _render_template

        html = _render_template("workspace_request_approved", {
            "kind_label": "new workspace",
            "workspace_name": "My WS",
            "granted_tier": "innovator",
            "workspace_url": "https://echo.dembrane.com/w/ws-1",
        })
        assert "approved" in html.lower()
        assert "My WS" in html
        assert "innovator" in html
        assert "/w/ws-1" in html

    def test_approved_txt_renders(self):
        from dembrane.email import _render_plain_text_template

        txt = _render_plain_text_template("workspace_request_approved", {
            "kind_label": "new workspace",
            "workspace_name": "My WS",
            "granted_tier": "innovator",
            "workspace_url": "https://echo.dembrane.com/w/ws-1",
        })
        assert txt is not None
        assert "My WS" in txt
        assert "innovator" in txt

    def test_denied_html_renders(self):
        from dembrane.email import _render_template

        html = _render_template("workspace_request_denied", {
            "kind_label": "tier upgrade",
            "denial_reason": "Budget constraints",
        })
        assert "not approved" in html.lower()
        assert "Budget constraints" in html

    def test_denied_txt_renders(self):
        from dembrane.email import _render_plain_text_template

        txt = _render_plain_text_template("workspace_request_denied", {
            "kind_label": "tier upgrade",
            "denial_reason": "Budget constraints",
        })
        assert txt is not None
        assert "Budget constraints" in txt

    def test_denied_html_renders_without_reason(self):
        from dembrane.email import _render_template

        html = _render_template("workspace_request_denied", {
            "kind_label": "new workspace",
            "denial_reason": None,
        })
        assert "not approved" in html.lower()

    def test_submitted_html_renders_without_optional_fields(self):
        from dembrane.email import _render_template

        html = _render_template("workspace_request_submitted", {
            "requester_name": "Bob",
            "requester_email": "",
            "kind_label": "tier upgrade",
            "org_name": "Org",
            "proposed_tier": "pioneer",
            "proposed_name": None,
            "requester_message": None,
            "admin_url": "http://localhost:3000/admin/upgrades",
        })
        assert "Bob" in html
        assert "tier upgrade" in html


# ── Integration: decide endpoint calls notification helpers ──────────


class TestDecideEndpointIntegration:
    """The decide_workspace_request endpoint calls notification helpers."""

    def _make_auth(self, user_id="directus-admin", is_admin=True):
        auth = MagicMock()
        auth.user_id = user_id
        auth.is_admin = is_admin
        auth.token = "tok"
        return auth

    @pytest.mark.asyncio
    async def test_approve_calls_notify_approved(self):
        from dembrane.api.v2.admin import (
            DecideWorkspaceRequestBody,
            decide_workspace_request,
        )

        auth = self._make_auth()
        body = DecideWorkspaceRequestBody(action="approve")

        req_data = {
            "id": "req-1",
            "kind": "new_workspace",
            "status": "pending",
            "requested_by": "app-u1",
            "org_id": "org-1",
            "proposed_tier": "innovator",
            "proposed_name": "WS",
            "proposed_visibility": "open_to_organisation",
        }

        mock_directus = AsyncMock()
        mock_directus.get_item = AsyncMock(
            side_effect=[
                req_data,
                {
                    **req_data,
                    "status": "approved",
                    "decided_by": "staff-1",
                    "decided_at": "2026-01-01T00:00:00+00:00",
                },
            ]
        )
        mock_directus.create_item.return_value = {"data": {"id": "ws-new"}}
        mock_directus.update_item.return_value = {}

        mock_app_user = AsyncMock(return_value={"id": "staff-1", "display_name": "Staff"})
        mock_create_ws = AsyncMock(return_value="ws-new")
        mock_notify_approved = AsyncMock()

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.app_user.get_app_user_or_raise", mock_app_user),
            patch("dembrane.api.v2.admin._create_workspace_for_request", mock_create_ws),
            patch("dembrane.api.v2.admin._notify_requester_approved", mock_notify_approved),
        ):
            bg = BackgroundTasks()
            result = await decide_workspace_request("req-1", body, auth, bg)
            await bg()

        assert result.status == "approved"
        mock_notify_approved.assert_called_once()
        notify_args = mock_notify_approved.call_args
        assert notify_args.args == (req_data, "innovator", "ws-new")
        # workspace_name is threaded from req["proposed_name"] to skip a re-fetch.
        assert notify_args.kwargs.get("workspace_name") == "WS"

    @pytest.mark.asyncio
    async def test_deny_calls_notify_denied(self):
        from dembrane.api.v2.admin import (
            DecideWorkspaceRequestBody,
            decide_workspace_request,
        )

        auth = self._make_auth()
        body = DecideWorkspaceRequestBody(
            action="deny",
            denial_reason="Not eligible for this tier",
        )

        req_data = {
            "id": "req-1",
            "kind": "new_workspace",
            "status": "pending",
            "requested_by": "app-u1",
            "org_id": "org-1",
        }

        mock_directus = AsyncMock()
        mock_directus.get_item = AsyncMock(
            side_effect=[
                req_data,
                {
                    **req_data,
                    "status": "denied",
                    "decided_by": "staff-1",
                    "decided_at": "2026-01-01T00:00:00+00:00",
                    "denial_reason": "Not eligible for this tier",
                },
            ]
        )
        mock_directus.update_item.return_value = {}

        mock_app_user = AsyncMock(return_value={"id": "staff-1", "display_name": "Staff"})
        mock_notify_denied = AsyncMock()

        with (
            patch("dembrane.api.v2.admin.async_directus", mock_directus),
            patch("dembrane.app_user.get_app_user_or_raise", mock_app_user),
            patch("dembrane.api.v2.admin._notify_requester_denied", mock_notify_denied),
        ):
            bg = BackgroundTasks()
            result = await decide_workspace_request("req-1", body, auth, bg)
            await bg()

        assert result.status == "denied"
        mock_notify_denied.assert_called_once_with(
            req_data,
            "Not eligible for this tier",
        )
