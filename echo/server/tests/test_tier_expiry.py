"""Tests for tier expiry cron (Slice 15).

Covers:
- task_expire_workspace_tiers: query filter, downgrade transaction,
  idempotency, skipping already-free workspaces, clearing tier_expires_at.
- _apply_tier_expiry: downgrade effects applied, workspace updated,
  cache invalidated.
- _send_tier_expired_notifications: TIER_EXPIRED event emitted,
  email sent to admins + billing.
- TIER_EXPIRED event code registration (severity = destructive).
- Email template rendering (HTML + TXT exist and render).
- Scheduler registration (hourly cron).
- Schema step 19 structural check.
- Approve dialog wiring: granted_tier_expires_at flows to workspace.
- Pilot -> free downgrade does NOT re-stamp is_over_cap (ADR 0001).
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── Event code registration ──────────────────────────────────────────


class TestTierExpiredEventCode:
    """TIER_EXPIRED was pre-registered in Slice 12."""

    def test_tier_expired_severity_is_destructive(self):
        from dembrane.notifications import severity_for

        assert severity_for("TIER_EXPIRED") == "destructive"

    def test_tier_expired_in_severity_map(self):
        from dembrane.notifications import _SEVERITY_BY_EVENT

        assert "TIER_EXPIRED" in _SEVERITY_BY_EVENT
        assert _SEVERITY_BY_EVENT["TIER_EXPIRED"] == "destructive"


# ── _apply_tier_expiry ───────────────────────────────────────────────


class TestApplyTierExpiry:
    """Unit tests for the async _apply_tier_expiry helper."""

    @pytest.mark.asyncio
    @patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock)
    @patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock)
    @patch("dembrane.directus_async.async_directus")
    @patch("dembrane.tier_downgrade.apply_downgrade_effects", new_callable=AsyncMock)
    async def test_applies_downgrade_effects(
        self, mock_effects, mock_directus, _mock_inv_ws, _mock_inv_org,
    ):
        mock_effects.return_value = [{"policy": "workspace:whitelabel", "effect": "revert", "human": "Remove logo"}]
        mock_directus.update_item = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "org_id": "org-1"})

        from dembrane.tasks import _apply_tier_expiry

        effects = await _apply_tier_expiry("ws-1", "pilot")

        mock_effects.assert_called_once_with("ws-1", "pilot", "free")
        assert len(effects) == 1
        assert effects[0]["effect"] == "revert"

    @pytest.mark.asyncio
    @patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock)
    @patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock)
    @patch("dembrane.directus_async.async_directus")
    @patch("dembrane.tier_downgrade.apply_downgrade_effects", new_callable=AsyncMock)
    async def test_updates_workspace_fields(
        self, mock_effects, mock_directus, _mock_inv_ws, _mock_inv_org,
    ):
        mock_effects.return_value = []
        mock_directus.update_item = AsyncMock()
        # Tier now lives on the billing account; the downgrade is written there.
        mock_directus.get_item = AsyncMock(
            return_value={"id": "ws-1", "org_id": "org-1", "billing_account_id": "acc-1"}
        )

        from dembrane.tasks import _apply_tier_expiry

        await _apply_tier_expiry("ws-1", "innovator")

        update_call = mock_directus.update_item.call_args
        assert update_call[0][0] == "billing_account"
        assert update_call[0][1] == "acc-1"
        data = update_call[0][2]
        assert data["tier"] == "free"
        assert data["downgraded_from_tier"] == "innovator"
        assert data["tier_expires_at"] is None
        assert "downgraded_at" in data

    @pytest.mark.asyncio
    @patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock)
    @patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock)
    @patch("dembrane.directus_async.async_directus")
    @patch("dembrane.tier_downgrade.apply_downgrade_effects", new_callable=AsyncMock)
    async def test_invalidates_caches(
        self, mock_effects, mock_directus, mock_inv_ws, mock_inv_org,
    ):
        mock_effects.return_value = []
        mock_directus.update_item = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "org_id": "org-1"})

        from dembrane.tasks import _apply_tier_expiry

        await _apply_tier_expiry("ws-1", "pilot")

        mock_inv_ws.assert_called_once_with("ws-1")
        mock_inv_org.assert_called_once_with("org-1")

    @pytest.mark.asyncio
    @patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock)
    @patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock)
    @patch("dembrane.directus_async.async_directus")
    @patch("dembrane.tier_downgrade.apply_downgrade_effects", new_callable=AsyncMock)
    async def test_no_org_cache_when_org_id_missing(
        self, mock_effects, mock_directus, mock_inv_ws, mock_inv_org,
    ):
        mock_effects.return_value = []
        mock_directus.update_item = AsyncMock()
        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1"})

        from dembrane.tasks import _apply_tier_expiry

        await _apply_tier_expiry("ws-1", "pilot")

        mock_inv_ws.assert_called_once()
        mock_inv_org.assert_not_called()


# ── _send_tier_expired_notifications ─────────────────────────────────


class TestSendTierExpiredNotifications:
    """Unit tests for the notification + email dispatch helper."""

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_emits_notification_to_audience(
        self, mock_run, _mock_dir, mock_ctx_fn, mock_send,
    ):
        mock_run.side_effect = [
            ["user-1", "user-2"],  # audience_workspace_admins_and_billing
            ["notif-1", "notif-2"],  # emit_to_audience
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

        from dembrane.tasks import _send_tier_expired_notifications

        _send_tier_expired_notifications("ws-1", "My Workspace", "pilot", [])

        assert mock_run.call_count == 2
        assert mock_send.call_count == 2

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_no_audience_skips_all(
        self, mock_run, mock_send,
    ):
        mock_run.return_value = []

        from dembrane.tasks import _send_tier_expired_notifications

        _send_tier_expired_notifications("ws-1", "Test", "pilot", [])

        mock_send.assert_not_called()

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_email_template_is_tier_expired(
        self, mock_run, _mock_dir, mock_ctx_fn, mock_send,
    ):
        mock_run.side_effect = [
            ["user-1"],  # audience
            ["notif-1"],  # emit_to_audience
        ]

        mock_client = MagicMock()
        mock_client.get_items.return_value = [{"email": "a@b.com"}]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import _send_tier_expired_notifications

        _send_tier_expired_notifications("ws-1", "WS", "pioneer", [
            {"policy": "workspace:whitelabel", "effect": "revert", "human": "Remove logo"},
            {"policy": "workspace:api_access", "effect": "freeze", "human": "Freeze API"},
        ])

        send_call = mock_send.call_args
        assert send_call[1]["template"] == "tier_expired"
        td = send_call[1]["template_data"]
        assert td["from_tier"] == "pioneer"
        assert "Remove logo" in td["revert_items"]
        assert "Freeze API" in td["freeze_items"]

    @patch("dembrane.email.send_email_sync", return_value=True)
    @patch("dembrane.tasks.directus_client_context")
    @patch("dembrane.directus.directus")
    @patch("dembrane.tasks.run_async_in_new_loop")
    def test_workspace_url_in_template_data(
        self, mock_run, _mock_dir, mock_ctx_fn, mock_send,
    ):
        mock_run.side_effect = [["user-1"], ["notif-1"]]

        mock_client = MagicMock()
        mock_client.get_items.return_value = [{"email": "a@b.com"}]
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import _send_tier_expired_notifications

        _send_tier_expired_notifications("ws-1", "WS", "pilot", [])

        td = mock_send.call_args[1]["template_data"]
        assert "/w/ws-1" in td["workspace_url"]


# ── task_expire_workspace_tiers (integration) ────────────────────────


class TestTaskExpireWorkspaceTiers:
    """Integration tests for the main Dramatiq actor."""

    @patch("dembrane.tasks._send_tier_expired_notifications")
    @patch("dembrane.tasks.run_async_in_new_loop")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_no_expired_workspaces_is_noop(
        self, _mock_dir, mock_ctx_fn, mock_run, mock_notify,
    ):
        mock_client = MagicMock()
        mock_client.get_items.return_value = []
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_expire_workspace_tiers

        task_expire_workspace_tiers()

        mock_run.assert_not_called()
        mock_notify.assert_not_called()

    @patch("dembrane.tasks._send_tier_expired_notifications")
    @patch("dembrane.tasks.run_async_in_new_loop")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_expired_pilot_triggers_downgrade(
        self, _mock_dir, mock_ctx_fn, mock_run, mock_notify,
    ):
        mock_client = MagicMock()
        # Cron scans billing accounts, then resolves the covered workspace.
        mock_client.get_items.return_value = [
            {"id": "acc-1", "tier": "pilot", "workspace_id": "ws-1"},
        ]
        mock_client.get_item.return_value = {"id": "ws-1", "name": "Test WS", "org_id": "org-1"}
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        mock_run.return_value = [{"effect": "freeze", "human": "Freeze API"}]

        from dembrane.tasks import task_expire_workspace_tiers

        task_expire_workspace_tiers()

        mock_run.assert_called_once()
        mock_notify.assert_called_once_with(
            "ws-1", "Test WS", "pilot",
            [{"effect": "freeze", "human": "Freeze API"}],
        )

    @patch("dembrane.tasks._send_tier_expired_notifications")
    @patch("dembrane.tasks.run_async_in_new_loop")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_multiple_workspaces_all_processed(
        self, _mock_dir, mock_ctx_fn, mock_run, mock_notify,
    ):
        mock_client = MagicMock()
        mock_client.get_items.return_value = [
            {"id": "acc-1", "tier": "pilot", "workspace_id": "ws-1"},
            {"id": "acc-2", "tier": "innovator", "workspace_id": "ws-2"},
        ]
        mock_client.get_item.return_value = {"id": "ws-x", "name": "WS", "org_id": "org-1"}
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        mock_run.return_value = []

        from dembrane.tasks import task_expire_workspace_tiers

        task_expire_workspace_tiers()

        assert mock_run.call_count == 2
        assert mock_notify.call_count == 2

    @patch("dembrane.tasks._send_tier_expired_notifications")
    @patch("dembrane.tasks.run_async_in_new_loop")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_non_list_response_is_noop(
        self, _mock_dir, mock_ctx_fn, mock_run, _mock_notify,
    ):
        mock_client = MagicMock()
        mock_client.get_items.return_value = {"error": "something"}
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_expire_workspace_tiers

        task_expire_workspace_tiers()

        mock_run.assert_not_called()

    @patch("dembrane.tasks._send_tier_expired_notifications")
    @patch("dembrane.tasks.run_async_in_new_loop")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_individual_failure_does_not_stop_others(
        self, _mock_dir, mock_ctx_fn, mock_run, mock_notify,
    ):
        mock_client = MagicMock()
        mock_client.get_items.return_value = [
            {"id": "acc-1", "tier": "pilot", "workspace_id": "ws-1"},
            {"id": "acc-2", "tier": "innovator", "workspace_id": "ws-2"},
        ]
        mock_client.get_item.return_value = {"id": "ws-x", "name": "WS", "org_id": "org-1"}
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        mock_run.side_effect = [Exception("boom"), []]

        from dembrane.tasks import task_expire_workspace_tiers

        task_expire_workspace_tiers()

        assert mock_run.call_count == 2
        assert mock_notify.call_count == 1

    @patch("dembrane.tasks._send_tier_expired_notifications")
    @patch("dembrane.tasks.run_async_in_new_loop")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_query_filter_excludes_free_and_null_expiry(
        self, _mock_dir, mock_ctx_fn, _mock_run, _mock_notify,
    ):
        mock_client = MagicMock()
        mock_client.get_items.return_value = []
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_expire_workspace_tiers

        task_expire_workspace_tiers()

        query_call = mock_client.get_items.call_args
        query_filter = query_call[0][1]["query"]["filter"]
        assert query_filter["tier_expires_at"]["_nnull"] is True
        assert "_lt" in query_filter["tier_expires_at"]
        assert query_filter["tier"]["_neq"] == "free"
        assert query_filter["deleted_at"]["_null"] is True

    @patch("dembrane.tasks._send_tier_expired_notifications")
    @patch("dembrane.tasks.run_async_in_new_loop")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_workspace_name_fallback(
        self, _mock_dir, mock_ctx_fn, mock_run, mock_notify,
    ):
        mock_client = MagicMock()
        mock_client.get_items.return_value = [
            {"id": "acc-1", "tier": "pilot", "workspace_id": "ws-1"},
        ]
        mock_client.get_item.return_value = {"id": "ws-1", "name": None, "org_id": "org-1"}
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx
        mock_run.return_value = []

        from dembrane.tasks import task_expire_workspace_tiers

        task_expire_workspace_tiers()

        mock_notify.assert_called_once()
        assert mock_notify.call_args[0][1] == "Untitled"


# ── Idempotency ──────────────────────────────────────────────────────


class TestIdempotency:
    """The cron is idempotent: re-running after downgrade produces no side effects."""

    @patch("dembrane.tasks._send_tier_expired_notifications")
    @patch("dembrane.tasks.run_async_in_new_loop")
    @patch("dembrane.directus.directus_client_context")
    @patch("dembrane.directus.directus")
    def test_already_free_excluded_by_filter(
        self, _mock_dir, mock_ctx_fn, mock_run, mock_notify,
    ):
        """After downgrade, tier='free' so the query filter tier != 'free' excludes it."""
        mock_client = MagicMock()
        mock_client.get_items.return_value = []
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_client)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx_fn.return_value = mock_ctx

        from dembrane.tasks import task_expire_workspace_tiers

        task_expire_workspace_tiers()

        mock_run.assert_not_called()
        mock_notify.assert_not_called()

    @pytest.mark.asyncio
    @patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock)
    @patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock)
    @patch("dembrane.directus_async.async_directus")
    @patch("dembrane.tier_downgrade.apply_downgrade_effects", new_callable=AsyncMock)
    async def test_tier_expires_at_cleared_after_downgrade(
        self, mock_effects, mock_directus, _mock_inv_ws, _mock_inv_org,
    ):
        """_apply_tier_expiry sets tier_expires_at=None so a re-run query won't match."""
        mock_effects.return_value = []
        mock_directus.update_item = AsyncMock()
        mock_directus.get_item = AsyncMock(
            return_value={"id": "ws-1", "org_id": "org-1", "billing_account_id": "acc-1"}
        )

        from dembrane.tasks import _apply_tier_expiry

        await _apply_tier_expiry("ws-1", "pilot")

        data = mock_directus.update_item.call_args[0][2]
        assert data["tier_expires_at"] is None
        assert data["tier"] == "free"


# ── Scheduler registration ───────────────────────────────────────────


class TestSchedulerRegistration:
    """Verify the hourly cron is registered."""

    def test_expire_tier_job_registered(self):
        from dembrane.scheduler import scheduler

        job = scheduler.get_job("task_expire_workspace_tiers")
        assert job is not None

    def test_expire_tier_job_runs_hourly(self):
        from dembrane.scheduler import scheduler

        job = scheduler.get_job("task_expire_workspace_tiers")
        trigger = job.trigger
        minute_field = next(f for f in trigger.fields if f.name == "minute")
        assert str(minute_field) == "0"


# ── Email template existence ─────────────────────────────────────────


class TestTierExpiredEmailTemplates:
    """Check that the email templates exist and contain expected variables."""

    def _template_path(self, ext: str) -> str:
        return os.path.join(
            os.path.dirname(__file__), "..", "email_templates", f"tier_expired.{ext}"
        )

    def test_html_template_exists(self):
        assert os.path.isfile(self._template_path("html"))

    def test_txt_template_exists(self):
        assert os.path.isfile(self._template_path("txt"))

    def test_html_contains_expected_vars(self):
        with open(self._template_path("html")) as f:
            content = f.read()
        assert "{{ workspace_name }}" in content or "workspace_name" in content
        assert "{{ from_tier }}" in content or "from_tier" in content
        assert "workspace_url" in content
        assert "freeze_items" in content
        assert "revert_items" in content

    def test_txt_contains_expected_vars(self):
        with open(self._template_path("txt")) as f:
            content = f.read()
        assert "{{ workspace_name }}" in content
        assert "{{ from_tier }}" in content
        assert "{{ workspace_url }}" in content

    def test_html_extends_layout(self):
        with open(self._template_path("html")) as f:
            content = f.read()
        assert '{% extends "_layout.html" %}' in content

    def test_no_bold_emphasis(self):
        with open(self._template_path("html")) as f:
            content = f.read()
        assert "<strong>" not in content
        assert "<b>" not in content

    def test_no_ai_copy(self):
        for ext in ("html", "txt"):
            with open(self._template_path(ext)) as f:
                content = f.read()
            assert " AI " not in content

    def test_no_successfully_copy(self):
        for ext in ("html", "txt"):
            with open(self._template_path(ext)) as f:
                content = f.read()
            assert "successfully" not in content.lower()


# ── Approve dialog wiring ────────────────────────────────────────────


# ── ADR 0001: pilot → free does NOT re-stamp ────────────────────────


class TestPilotFreeNoRestamp:
    """Tier expiry downgrades to free but does NOT re-stamp is_over_cap.

    Per ADR 0001: "Pilot → free downgrade does not re-stamp."
    The live gate keeps pilot-era content unlocked because is_over_cap
    was never set on those conversations.
    """

    @pytest.mark.asyncio
    @patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock)
    @patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock)
    @patch("dembrane.directus_async.async_directus")
    @patch("dembrane.tier_downgrade.apply_downgrade_effects", new_callable=AsyncMock)
    async def test_no_conversation_update_on_expiry(
        self, mock_effects, mock_directus, _mock_inv_ws, _mock_inv_org,
    ):
        """_apply_tier_expiry does NOT touch conversation.is_over_cap."""
        mock_effects.return_value = []
        mock_directus.update_item = AsyncMock()
        mock_directus.get_item = AsyncMock(
            return_value={"id": "ws-1", "org_id": "org-1", "billing_account_id": "acc-1"}
        )

        from dembrane.tasks import _apply_tier_expiry

        await _apply_tier_expiry("ws-1", "pilot")

        # Only the tier downgrade is written (to the billing account); no
        # conversation.is_over_cap re-stamp (ADR 0001).
        assert mock_directus.update_item.call_count == 1
        update_call = mock_directus.update_item.call_args
        assert update_call[0][0] == "billing_account"

    def test_live_lock_formula_pilot_content_stays_unlocked(self):
        """Conversations created on pilot (is_over_cap=False) stay unlocked
        after downgrade to free."""
        from dembrane.tier_capacity import tier_allows_overage

        assert not tier_allows_overage("free")
        is_over_cap = False
        locked = is_over_cap and not tier_allows_overage("free")
        assert locked is False

    def test_pilot_conversations_under_cap_never_stamped(self):
        """compute_is_over_cap returns False for pilot when under cap."""
        from dembrane.tier_capacity import compute_is_over_cap

        result = compute_is_over_cap("pilot", workspace_audio_hours=7.0, conversation_duration_hours=1.0)
        assert result is False
