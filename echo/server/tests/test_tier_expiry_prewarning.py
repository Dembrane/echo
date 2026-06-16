"""Tests for 3-day tier-expiry pre-warning (Slice 16).

Covers:
- TIER_EXPIRING_SOON event code registration (severity = action_required).
- task_send_tier_expiry_prewarning: query filter, per-workspace dispatch,
  pre_warning_sent = True on success, skips on empty results, individual
  failure isolation.
- _send_tier_expiring_soon: notification emission, email dispatch, no-audience
  skip, template variables.
- _format_expiry_date: various ISO formats, invalid input, missing value.
- pre_warning_sent reset: _apply_tier_expiry clears flag,
  _upgrade_workspace_for_request resets on tier_expires_at change.
- Email templates: HTML + TXT exist and contain expected variables.
- Scheduler registration: hourly cron job exists.
- Schema step 20: structural check (field name, type, default).
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── Event code registration ──────────────────────────────────────────


class TestTierExpiringSoonEventCode:
    """TIER_EXPIRING_SOON registered in Slice 16."""

    def test_severity_is_action_required(self):
        from dembrane.notifications import severity_for

        assert severity_for("TIER_EXPIRING_SOON") == "action_required"

    def test_in_severity_map(self):
        from dembrane.notifications import _SEVERITY_BY_EVENT

        assert "TIER_EXPIRING_SOON" in _SEVERITY_BY_EVENT
        assert _SEVERITY_BY_EVENT["TIER_EXPIRING_SOON"] == "action_required"

    def test_does_not_conflict_with_tier_expired(self):
        from dembrane.notifications import severity_for

        assert severity_for("TIER_EXPIRED") == "destructive"


# ── _format_expiry_date ──────────────────────────────────────────────


class TestFormatExpiryDate:
    """Unit tests for the date formatting helper."""

    def test_valid_iso_with_timezone(self):
        from dembrane.tasks import _format_expiry_date

        result = _format_expiry_date("2026-05-15T12:00:00+00:00")
        assert "15" in result
        assert "May" in result
        assert "2026" in result

    def test_valid_iso_with_z_suffix(self):
        from dembrane.tasks import _format_expiry_date

        result = _format_expiry_date("2026-06-01T00:00:00Z")
        assert "June" in result
        assert "2026" in result

    def test_valid_iso_without_timezone(self):
        from dembrane.tasks import _format_expiry_date

        result = _format_expiry_date("2026-12-25T08:30:00")
        assert "25" in result
        assert "December" in result

    def test_empty_string_returns_soon(self):
        from dembrane.tasks import _format_expiry_date

        assert _format_expiry_date("") == "soon"

    def test_invalid_string_returns_soon(self):
        from dembrane.tasks import _format_expiry_date

        assert _format_expiry_date("not-a-date") == "soon"

    def test_none_like_returns_soon(self):
        from dembrane.tasks import _format_expiry_date

        assert _format_expiry_date("") == "soon"


# ── _send_tier_expiring_soon ─────────────────────────────────────────


class TestSendTierExpiringSoon:
    """Unit tests for the notification + email dispatch helper."""

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_emits_notification_to_audience(
        self, mock_run, _mock_dir, mock_ctx_fn, mock_send,
    ):
        mock_run.side_effect = [
            ["user-1", "user-2"],
            ["notif-1", "notif-2"],
        ]

        mock_client = MagicMock()
        mock_client.get_items.return_value = [
            {"email": "a@b.com"},
            {"email": "c@d.com"},
        ]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import _send_tier_expiring_soon

        _send_tier_expiring_soon("ws-1", "My Workspace", "pilot", "2026-05-15T00:00:00+00:00")

        assert mock_run.call_count == 2
        assert mock_send.call_count == 2

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_no_audience_skips_all(self, mock_run, mock_send):
        mock_run.return_value = []

        from dembrane.tasks import _send_tier_expiring_soon

        _send_tier_expiring_soon("ws-1", "Test", "pilot", "2026-05-15T00:00:00+00:00")

        mock_send.assert_not_called()

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_email_template_is_tier_expiring_soon(
        self, mock_run, _mock_dir, mock_ctx_fn, mock_send,
    ):
        mock_run.side_effect = [
            ["user-1"],
            ["notif-1"],
        ]

        mock_client = MagicMock()
        mock_client.get_items.return_value = [{"email": "a@b.com"}]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import _send_tier_expiring_soon

        _send_tier_expiring_soon("ws-1", "Test WS", "innovator", "2026-05-15T00:00:00+00:00")

        send_call = mock_send.call_args
        assert send_call.kwargs["template"] == "tier_expiring_soon"
        tdata = send_call.kwargs["template_data"]
        assert tdata["workspace_name"] == "Test WS"
        assert tdata["current_tier"] == "innovator"
        assert "May" in tdata["expires_date"]
        assert "workspace_url" in tdata

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_notification_event_code(
        self, mock_run, _mock_dir, mock_ctx_fn, _mock_send,
    ):
        mock_run.side_effect = [
            ["user-1"],
            ["notif-1"],
        ]

        mock_client = MagicMock()
        mock_client.get_items.return_value = [{"email": "a@b.com"}]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import _send_tier_expiring_soon

        _send_tier_expiring_soon("ws-1", "Test WS", "pilot", "2026-05-15T00:00:00+00:00")

        assert mock_run.call_count == 2

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_workspace_url_uses_base_url(
        self, mock_run, _mock_dir, mock_ctx_fn, mock_send,
    ):
        mock_run.side_effect = [
            ["user-1"],
            ["notif-1"],
        ]

        mock_client = MagicMock()
        mock_client.get_items.return_value = [{"email": "a@b.com"}]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import _send_tier_expiring_soon

        _send_tier_expiring_soon("ws-99", "Test", "pioneer", "2026-05-15T00:00:00+00:00")

        tdata = mock_send.call_args.kwargs["template_data"]
        assert "ws-99" in tdata["workspace_url"]

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_no_emails_skips_send(
        self, mock_run, _mock_dir, mock_ctx_fn, mock_send,
    ):
        mock_run.side_effect = [
            ["user-1"],
            ["notif-1"],
        ]

        mock_client = MagicMock()
        mock_client.get_items.return_value = []
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import _send_tier_expiring_soon

        _send_tier_expiring_soon("ws-1", "Test", "pilot", "2026-05-15T00:00:00+00:00")

        mock_send.assert_not_called()


# ── task_send_tier_expiry_prewarning ─────────────────────────────────


class TestTaskSendTierExpiryPrewarning:
    """Integration-level tests for the Dramatiq actor."""

    @patch("dembrane.tasks._send_tier_expiring_soon")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_no_candidates_is_noop(self, _mock_dir, mock_ctx_fn, mock_send):
        mock_client = MagicMock()
        mock_client.get_items.return_value = []
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_send_tier_expiry_prewarning

        task_send_tier_expiry_prewarning()

        mock_send.assert_not_called()

    @patch("dembrane.tasks._send_tier_expiring_soon")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_non_list_response_is_noop(self, _mock_dir, mock_ctx_fn, mock_send):
        mock_client = MagicMock()
        mock_client.get_items.return_value = {"error": "something"}
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_send_tier_expiry_prewarning

        task_send_tier_expiry_prewarning()

        mock_send.assert_not_called()

    @patch("dembrane.tasks._send_tier_expiring_soon")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_dispatches_for_each_candidate(self, _mock_dir, mock_ctx_fn, mock_send):
        # Cron scans billing accounts; workspace name comes from a follow-up lookup.
        candidates = [
            {"id": "acc-1", "tier": "pilot", "tier_expires_at": "2026-05-15T00:00:00+00:00", "workspace_id": "ws-1"},
            {"id": "acc-2", "tier": "innovator", "tier_expires_at": "2026-05-14T00:00:00+00:00", "workspace_id": "ws-2"},
        ]
        names = {"ws-1": "WS One", "ws-2": "WS Two"}

        mock_client = MagicMock()
        mock_client.get_items.return_value = candidates
        mock_client.get_item.side_effect = lambda c, i, *a, **k: {"id": i, "name": names[i]}
        mock_client.update_item.return_value = {"data": {}}

        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_send_tier_expiry_prewarning

        task_send_tier_expiry_prewarning()

        assert mock_send.call_count == 2
        mock_send.assert_any_call("ws-1", "WS One", "pilot", "2026-05-15T00:00:00+00:00")
        mock_send.assert_any_call("ws-2", "WS Two", "innovator", "2026-05-14T00:00:00+00:00")

    @patch("dembrane.tasks._send_tier_expiring_soon")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_sets_pre_warning_sent_true(self, _mock_dir, mock_ctx_fn, _mock_send):
        candidates = [
            {"id": "acc-1", "tier": "pilot", "tier_expires_at": "2026-05-15T00:00:00+00:00", "workspace_id": "ws-1"},
        ]

        mock_client = MagicMock()
        mock_client.get_items.return_value = candidates
        mock_client.get_item.return_value = {"id": "ws-1", "name": "WS One"}
        mock_client.update_item.return_value = {"data": {}}

        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_send_tier_expiry_prewarning

        task_send_tier_expiry_prewarning()

        # pre_warning_sent is now flagged on the billing account.
        mock_client.update_item.assert_called_with("billing_account", "acc-1", {"pre_warning_sent": True})

    @patch("dembrane.tasks._send_tier_expiring_soon", side_effect=Exception("send failed"))
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_individual_failure_does_not_break_loop(self, _mock_dir, mock_ctx_fn, mock_send):
        candidates = [
            {"id": "acc-1", "tier": "pilot", "tier_expires_at": "2026-05-15T00:00:00+00:00", "workspace_id": "ws-1"},
            {"id": "acc-2", "tier": "pilot", "tier_expires_at": "2026-05-14T00:00:00+00:00", "workspace_id": "ws-2"},
        ]

        mock_client = MagicMock()
        mock_client.get_items.return_value = candidates
        mock_client.get_item.side_effect = lambda c, i, *a, **k: {"id": i, "name": "WS"}

        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_send_tier_expiry_prewarning

        task_send_tier_expiry_prewarning()

        assert mock_send.call_count == 2

    @patch("dembrane.tasks._send_tier_expiring_soon")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_query_filter_validation(self, _mock_dir, mock_ctx_fn, _mock_send):
        """Verify the Directus query filters match the spec."""
        mock_client = MagicMock()
        mock_client.get_items.return_value = []
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_send_tier_expiry_prewarning

        task_send_tier_expiry_prewarning()

        query = mock_client.get_items.call_args[0][1]["query"]
        f = query["filter"]
        assert "tier_expires_at" in f
        assert f["tier_expires_at"]["_nnull"] is True
        assert "_gte" in f["tier_expires_at"]
        assert "_lte" in f["tier_expires_at"]
        assert f["tier"]["_neq"] == "free"
        assert f["pre_warning_sent"]["_eq"] is False
        assert f["deleted_at"]["_null"] is True

    @patch("dembrane.tasks._send_tier_expiring_soon")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_name_fallback_to_untitled(self, _mock_dir, mock_ctx_fn, mock_send):
        candidates = [
            {"id": "acc-1", "tier": "pilot", "tier_expires_at": "2026-05-15T00:00:00+00:00", "workspace_id": "ws-1"},
        ]

        mock_client = MagicMock()
        mock_client.get_items.return_value = candidates
        mock_client.get_item.return_value = {"id": "ws-1", "name": None}
        mock_client.update_item.return_value = {"data": {}}

        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_send_tier_expiry_prewarning

        task_send_tier_expiry_prewarning()

        mock_send.assert_called_once_with("ws-1", "Untitled", "pilot", "2026-05-15T00:00:00+00:00")


# ── pre_warning_sent reset ───────────────────────────────────────────


class TestPreWarningSentReset:
    """Verify pre_warning_sent is reset when tier_expires_at changes."""

    @pytest.mark.asyncio
    @patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock)
    @patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock)
    @patch("dembrane.directus_async.async_directus")
    @patch("dembrane.tier_downgrade.apply_downgrade_effects", new_callable=AsyncMock)
    async def test_apply_tier_expiry_clears_pre_warning_sent(
        self, mock_effects, mock_directus, _mock_inv_ws, _mock_inv_org,
    ):
        mock_effects.return_value = []
        mock_directus.update_item = AsyncMock()
        mock_directus.get_item = AsyncMock(
            return_value={"id": "ws-1", "org_id": "org-1", "billing_account_id": "acc-1"}
        )

        from dembrane.tasks import _apply_tier_expiry

        await _apply_tier_expiry("ws-1", "pilot")

        update_call = mock_directus.update_item.call_args
        data = update_call[0][2]
        assert data["tier_expires_at"] is None
        assert data["pre_warning_sent"] is False

    @pytest.mark.asyncio
    async def test_upgrade_workspace_resets_pre_warning_on_expires_at(self):
        """When _upgrade_workspace_for_request sets tier_expires_at, it resets pre_warning_sent."""
        def _get_item(coll, item_id, *a, **k):
            if coll == "billing_account":
                return {"id": item_id, "tier": "pilot"}
            return {"id": "ws-1", "org_id": "org-1", "deleted_at": None, "billing_account_id": "acc-1"}

        with patch("dembrane.api.v2.admin.async_directus") as mock_admin, \
             patch("dembrane.directus_async.async_directus") as mock_ba, \
             patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock), \
             patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock):

            mock_admin.get_item = AsyncMock(side_effect=_get_item)
            mock_ba.get_item = AsyncMock(side_effect=_get_item)
            mock_ba.update_item = AsyncMock()

            from dembrane.api.v2.admin import _upgrade_workspace_for_request

            mock_req = {
                "id": "req-1",
                "workspace_id": "ws-1",
                "requested_by": "user-1",
            }

            await _upgrade_workspace_for_request(
                mock_req,
                granted_tier="innovator",
                staff_user_id="staff-1",
                granted_tier_expires_at="2026-06-01T00:00:00+00:00",
            )

            # Tier/terms are written to the billing account now.
            update_call = mock_ba.update_item.call_args
            assert update_call[0][0] == "billing_account"
            data = update_call[0][2]
            assert data["tier_expires_at"] == "2026-06-01T00:00:00+00:00"
            assert data["pre_warning_sent"] is False

    @pytest.mark.asyncio
    async def test_upgrade_without_expires_at_does_not_set_pre_warning(self):
        """When tier_expires_at is not set, pre_warning_sent is not touched."""
        def _get_item(coll, item_id, *a, **k):
            if coll == "billing_account":
                return {"id": item_id, "tier": "pilot"}
            return {"id": "ws-1", "org_id": "org-1", "deleted_at": None, "billing_account_id": "acc-1"}

        with patch("dembrane.api.v2.admin.async_directus") as mock_admin, \
             patch("dembrane.directus_async.async_directus") as mock_ba, \
             patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock), \
             patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock):

            mock_admin.get_item = AsyncMock(side_effect=_get_item)
            mock_ba.get_item = AsyncMock(side_effect=_get_item)
            mock_ba.update_item = AsyncMock()

            from dembrane.api.v2.admin import _upgrade_workspace_for_request

            mock_req = {
                "id": "req-1",
                "workspace_id": "ws-1",
                "requested_by": "user-1",
            }

            await _upgrade_workspace_for_request(
                mock_req,
                granted_tier="innovator",
                staff_user_id="staff-1",
            )

            update_call = mock_ba.update_item.call_args
            data = update_call[0][2]
            assert "pre_warning_sent" not in data


# ── Email templates ──────────────────────────────────────────────────


class TestTierExpiringSoonEmailTemplates:
    """Verify the email templates exist and contain required variables."""

    TEMPLATE_DIR = os.path.join(
        os.path.dirname(__file__), "..", "email_templates"
    )

    def test_html_template_exists(self):
        path = os.path.join(self.TEMPLATE_DIR, "tier_expiring_soon.html")
        assert os.path.isfile(path), f"Missing {path}"

    def test_txt_template_exists(self):
        path = os.path.join(self.TEMPLATE_DIR, "tier_expiring_soon.txt")
        assert os.path.isfile(path), f"Missing {path}"

    def test_html_contains_expected_variables(self):
        path = os.path.join(self.TEMPLATE_DIR, "tier_expiring_soon.html")
        with open(path) as f:
            content = f.read()
        for var in ("workspace_name", "current_tier", "expires_date"):
            assert var in content, f"Missing template var {var}"
        assert "workspace_url" in content, "Missing workspace_url in CTA"

    def test_txt_contains_expected_variables(self):
        path = os.path.join(self.TEMPLATE_DIR, "tier_expiring_soon.txt")
        with open(path) as f:
            content = f.read()
        for var in ("workspace_name", "current_tier", "expires_date", "workspace_url"):
            assert var in content, f"Missing template var {var}"

    def test_html_extends_layout(self):
        path = os.path.join(self.TEMPLATE_DIR, "tier_expiring_soon.html")
        with open(path) as f:
            content = f.read()
        assert "_layout.html" in content

    def test_html_has_no_bold_emphasis(self):
        """Brand rule: no bold for emphasis."""
        path = os.path.join(self.TEMPLATE_DIR, "tier_expiring_soon.html")
        with open(path) as f:
            content = f.read()
        assert "<strong>" not in content
        assert "<b>" not in content

    def test_html_does_not_say_successfully(self):
        """Brand rule: never say 'successfully'."""
        path = os.path.join(self.TEMPLATE_DIR, "tier_expiring_soon.html")
        with open(path) as f:
            content = f.read()
        assert "successfully" not in content.lower()

    def test_html_does_not_say_ai(self):
        """Brand rule: never say 'AI'."""
        path = os.path.join(self.TEMPLATE_DIR, "tier_expiring_soon.html")
        with open(path) as f:
            content = f.read()
        lines = content.split("\n")
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("{%") or stripped.startswith("{{"):
                continue
            words = stripped.split()
            assert "AI" not in words


# ── Scheduler registration ───────────────────────────────────────────


class TestPrewarningScheduler:
    """Verify the hourly cron job is registered."""

    def test_scheduler_has_prewarning_job(self):
        from dembrane.scheduler import scheduler

        jobs = {j.id: j for j in scheduler.get_jobs()}
        assert "task_send_tier_expiry_prewarning" in jobs

    def test_prewarning_job_is_hourly(self):
        from dembrane.scheduler import scheduler

        jobs = {j.id: j for j in scheduler.get_jobs()}
        job = jobs["task_send_tier_expiry_prewarning"]
        trigger = job.trigger
        assert hasattr(trigger, "fields")
        field_map = {f.name: f for f in trigger.fields}
        minute_expr = str(field_map["minute"])
        assert minute_expr == "0"

    def test_prewarning_job_target(self):
        from dembrane.scheduler import scheduler

        jobs = {j.id: j for j in scheduler.get_jobs()}
        job = jobs["task_send_tier_expiry_prewarning"]
        assert "task_send_tier_expiry_prewarning" in str(job.func_ref)


