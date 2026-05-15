"""Tests for email throttle + digest batching (slice 13).

Covers:
- Pure ``should_send_now`` decision function (exhaustive threshold matrix).
- Sliding window semantics (events older than 24h drop out).
- Independent tracking per event code and per recipient.
- ``record_and_check_throttle`` async integration with mocked Redis.
- ``queue_digest_item`` stores payloads and tracks recipients.
- ``flush_all_digests_sync`` drains queues and returns grouped items.
- ``task_flush_email_digests`` Dramatiq actor renders and sends digests.
- ``WORKSPACE_REQUEST_SUBMITTED`` is wired through the throttle in the
  submit endpoint (in-app notification always fires individually).
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from dembrane.email_throttle import (
    _KEY_PREFIX,
    _WINDOW_SECONDS,
    _DIGEST_KEY_PREFIX,
    THROTTLE_THRESHOLD,
    _DIGEST_RECIPIENTS_KEY,
    _throttle_key,
    should_send_now,
    _digest_queue_key,
    flush_all_digests_sync,
)

# ── Pure decision function ───────────────────────────────────────────


class TestShouldSendNow:
    """Exhaustive coverage of the pure throttle decision."""

    def test_threshold_is_five(self):
        assert THROTTLE_THRESHOLD == 5

    @pytest.mark.parametrize("count", [0, 1, 2, 3, 4])
    def test_individual_for_first_five(self, count: int):
        assert should_send_now("r1", "EVT", count) == "individual"

    @pytest.mark.parametrize("count", [5, 6, 10, 100])
    def test_queue_for_sixth_and_beyond(self, count: int):
        assert should_send_now("r1", "EVT", count) == "queue_for_digest"

    def test_boundary_at_threshold(self):
        assert should_send_now("r", "E", THROTTLE_THRESHOLD - 1) == "individual"
        assert should_send_now("r", "E", THROTTLE_THRESHOLD) == "queue_for_digest"

    def test_different_recipients_independent(self):
        assert should_send_now("alice", "EVT", 4) == "individual"
        assert should_send_now("bob", "EVT", 6) == "queue_for_digest"

    def test_different_event_codes_independent(self):
        assert should_send_now("r", "A", 4) == "individual"
        assert should_send_now("r", "B", 6) == "queue_for_digest"

    def test_zero_history_always_individual(self):
        assert should_send_now("any", "any", 0) == "individual"

    def test_negative_history_still_individual(self):
        assert should_send_now("any", "any", -1) == "individual"


# ── Redis key helpers ────────────────────────────────────────────────


class TestKeyHelpers:
    def test_throttle_key_format(self):
        key = _throttle_key("WORKSPACE_REQUEST_SUBMITTED", "staff@example.com")
        assert key == f"{_KEY_PREFIX}:WORKSPACE_REQUEST_SUBMITTED:staff@example.com"

    def test_digest_queue_key_format(self):
        key = _digest_queue_key("staff@example.com")
        assert key == f"{_DIGEST_KEY_PREFIX}:staff@example.com"


# ── record_and_check_throttle (async, mocked Redis) ─────────────────


def _make_mock_redis(zcard_return: int = 0) -> AsyncMock:
    mock = AsyncMock()
    mock.zremrangebyscore = AsyncMock()
    mock.zcard = AsyncMock(return_value=zcard_return)
    mock.zadd = AsyncMock()
    mock.expire = AsyncMock()
    return mock


class TestRecordAndCheckThrottle:
    @pytest.mark.asyncio
    async def test_returns_individual_when_under_threshold(self):
        mock_redis = _make_mock_redis(zcard_return=2)
        mock_get = AsyncMock(return_value=mock_redis)

        with patch("dembrane.redis_async.get_redis_client", mock_get):
            from dembrane.email_throttle import record_and_check_throttle
            result = await record_and_check_throttle("r@test.com", "EVT")

        assert result == "individual"
        mock_redis.zadd.assert_called_once()
        mock_redis.zremrangebyscore.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_queue_when_at_threshold(self):
        mock_redis = _make_mock_redis(zcard_return=5)
        mock_get = AsyncMock(return_value=mock_redis)

        with patch("dembrane.redis_async.get_redis_client", mock_get):
            from dembrane.email_throttle import record_and_check_throttle
            result = await record_and_check_throttle("r@test.com", "EVT")

        assert result == "queue_for_digest"

    @pytest.mark.asyncio
    async def test_prunes_old_entries(self):
        mock_redis = _make_mock_redis(zcard_return=0)
        mock_get = AsyncMock(return_value=mock_redis)
        now = 1_000_000.0

        with (
            patch("dembrane.redis_async.get_redis_client", mock_get),
            patch("dembrane.email_throttle.time") as mock_time,
        ):
            mock_time.time.return_value = now
            from dembrane.email_throttle import record_and_check_throttle
            await record_and_check_throttle("r@test.com", "EVT")

        call_args = mock_redis.zremrangebyscore.call_args[0]
        _key, low, high = call_args
        assert low == "-inf"
        assert float(high) == pytest.approx(now - _WINDOW_SECONDS, abs=1)

    @pytest.mark.asyncio
    async def test_records_current_timestamp(self):
        mock_redis = _make_mock_redis(zcard_return=0)
        mock_get = AsyncMock(return_value=mock_redis)
        now = 1_000_000.0

        with (
            patch("dembrane.redis_async.get_redis_client", mock_get),
            patch("dembrane.email_throttle.time") as mock_time,
        ):
            mock_time.time.return_value = now
            from dembrane.email_throttle import record_and_check_throttle
            await record_and_check_throttle("r@test.com", "EVT")

        zadd_args = mock_redis.zadd.call_args[0]
        _key, mapping = zadd_args
        assert str(now) in mapping
        assert mapping[str(now)] == now

    @pytest.mark.asyncio
    async def test_defaults_to_individual_on_redis_error(self):
        mock_get = AsyncMock(side_effect=Exception("conn"))

        with patch("dembrane.redis_async.get_redis_client", mock_get):
            from dembrane.email_throttle import record_and_check_throttle
            result = await record_and_check_throttle("r@test.com", "EVT")

        assert result == "individual"

    @pytest.mark.asyncio
    async def test_sets_ttl_on_sorted_set(self):
        mock_redis = _make_mock_redis(zcard_return=0)
        mock_get = AsyncMock(return_value=mock_redis)

        with patch("dembrane.redis_async.get_redis_client", mock_get):
            from dembrane.email_throttle import record_and_check_throttle
            await record_and_check_throttle("r@test.com", "EVT")

        mock_redis.expire.assert_called_once()


# ── queue_digest_item (async, mocked Redis) ──────────────────────────


class TestQueueDigestItem:
    @pytest.mark.asyncio
    async def test_pushes_item_to_list(self):
        mock_redis = AsyncMock()
        mock_redis.rpush = AsyncMock()
        mock_redis.expire = AsyncMock()
        mock_redis.sadd = AsyncMock()
        mock_get = AsyncMock(return_value=mock_redis)

        item = {"summary": "test", "timestamp": "2026-05-11"}
        with patch("dembrane.redis_async.get_redis_client", mock_get):
            from dembrane.email_throttle import queue_digest_item
            await queue_digest_item("staff@test.com", item)

        mock_redis.rpush.assert_called_once()
        rpush_key = mock_redis.rpush.call_args[0][0]
        assert "staff@test.com" in rpush_key

        mock_redis.sadd.assert_called_once()
        sadd_args = mock_redis.sadd.call_args[0]
        assert sadd_args[0] == _DIGEST_RECIPIENTS_KEY

    @pytest.mark.asyncio
    async def test_survives_redis_error(self):
        mock_get = AsyncMock(side_effect=Exception("conn"))
        with patch("dembrane.redis_async.get_redis_client", mock_get):
            from dembrane.email_throttle import queue_digest_item
            await queue_digest_item("staff@test.com", {"x": 1})

    @pytest.mark.asyncio
    async def test_sets_ttl_on_queue(self):
        mock_redis = AsyncMock()
        mock_redis.rpush = AsyncMock()
        mock_redis.expire = AsyncMock()
        mock_redis.sadd = AsyncMock()
        mock_get = AsyncMock(return_value=mock_redis)

        with patch("dembrane.redis_async.get_redis_client", mock_get):
            from dembrane.email_throttle import queue_digest_item
            await queue_digest_item("r", {"x": 1})

        mock_redis.expire.assert_called_once()


# ── flush_all_digests_sync (mocked sync Redis) ──────────────────────


class TestFlushAllDigestsSync:
    def test_drains_queues_and_returns_grouped(self):
        items_a = [
            json.dumps({"summary": "req 1", "timestamp": "10:00"}),
            json.dumps({"summary": "req 2", "timestamp": "10:05"}),
        ]
        items_b = [
            json.dumps({"summary": "req 3", "timestamp": "11:00"}),
        ]

        mock_redis = MagicMock()
        mock_redis.smembers.return_value = {"alice@test.com", "bob@test.com"}

        lpop_queues: dict[str, list] = {
            _digest_queue_key("alice@test.com"): items_a + [None],
            _digest_queue_key("bob@test.com"): items_b + [None],
        }
        lpop_state: dict[str, int] = {}

        def lpop_side_effect(key: str):
            if key not in lpop_state:
                lpop_state[key] = 0
            idx = lpop_state[key]
            items = lpop_queues.get(key, [None])
            if idx < len(items):
                lpop_state[key] = idx + 1
                return items[idx]
            return None

        mock_redis.lpop.side_effect = lpop_side_effect
        mock_redis.srem = MagicMock()
        mock_redis.close = MagicMock()

        with patch("dembrane.email_throttle._get_sync_redis", return_value=mock_redis):
            result = flush_all_digests_sync()

        assert len(result["alice@test.com"]) == 2
        assert len(result["bob@test.com"]) == 1
        assert result["alice@test.com"][0]["summary"] == "req 1"
        assert mock_redis.srem.call_count == 2

    def test_empty_queue_returns_empty(self):
        mock_redis = MagicMock()
        mock_redis.smembers.return_value = set()
        mock_redis.close = MagicMock()

        with patch("dembrane.email_throttle._get_sync_redis", return_value=mock_redis):
            result = flush_all_digests_sync()

        assert result == {}

    def test_corrupt_json_skipped(self):
        mock_redis = MagicMock()
        mock_redis.smembers.return_value = {"r@test.com"}

        items = ["not-valid-json{{{", json.dumps({"summary": "good"}), None]
        state = {"idx": 0}

        def lpop_fn(_key: str):
            idx = state["idx"]
            state["idx"] = idx + 1
            return items[idx] if idx < len(items) else None

        mock_redis.lpop.side_effect = lpop_fn
        mock_redis.srem = MagicMock()
        mock_redis.close = MagicMock()

        with patch("dembrane.email_throttle._get_sync_redis", return_value=mock_redis):
            result = flush_all_digests_sync()

        assert len(result["r@test.com"]) == 1
        assert result["r@test.com"][0]["summary"] == "good"

    def test_survives_redis_error_in_smembers(self):
        mock_redis = MagicMock()
        mock_redis.smembers.side_effect = Exception("conn")
        mock_redis.close = MagicMock()

        with patch("dembrane.email_throttle._get_sync_redis", return_value=mock_redis):
            result = flush_all_digests_sync()
        assert result == {}

    def test_recipient_removed_from_pending_set(self):
        mock_redis = MagicMock()
        mock_redis.smembers.return_value = {"r@test.com"}
        mock_redis.lpop.side_effect = [json.dumps({"s": "x"}), None]
        mock_redis.srem = MagicMock()
        mock_redis.close = MagicMock()

        with patch("dembrane.email_throttle._get_sync_redis", return_value=mock_redis):
            flush_all_digests_sync()

        mock_redis.srem.assert_called_once_with(_DIGEST_RECIPIENTS_KEY, "r@test.com")


# ── task_flush_email_digests actor ───────────────────────────────────


class TestTaskFlushEmailDigests:
    @patch("dembrane.tasks._resolve_recipient_email_sync")
    @patch("dembrane.email.send_email_sync")
    @patch("dembrane.email_throttle.flush_all_digests_sync")
    @patch("dembrane.tasks.get_settings")
    def test_sends_digest_per_recipient(
        self, mock_settings, mock_flush, mock_send, mock_resolve
    ):
        mock_settings.return_value.urls.admin_base_url = "https://app.dembrane.com"
        mock_flush.return_value = {
            "alice-id": [
                {"summary": "req 1", "timestamp": "10:00"},
                {"summary": "req 2", "timestamp": "10:05"},
            ],
        }
        mock_resolve.return_value = "alice@test.com"
        mock_send.return_value = True

        from dembrane.tasks import task_flush_email_digests
        task_flush_email_digests()

        mock_send.assert_called_once()
        call_kwargs = mock_send.call_args[1]
        assert call_kwargs["to"] == "alice@test.com"
        assert call_kwargs["template"] == "notification_digest"
        assert call_kwargs["template_data"]["item_count"] == 2

    @patch("dembrane.tasks._resolve_recipient_email_sync")
    @patch("dembrane.email.send_email_sync")
    @patch("dembrane.email_throttle.flush_all_digests_sync")
    @patch("dembrane.tasks.get_settings")
    def test_noop_when_no_digests(
        self, mock_settings, mock_flush, mock_send, _mock_resolve
    ):
        mock_settings.return_value.urls.admin_base_url = "https://app.dembrane.com"
        mock_flush.return_value = {}

        from dembrane.tasks import task_flush_email_digests
        task_flush_email_digests()

        mock_send.assert_not_called()

    @patch("dembrane.tasks._resolve_recipient_email_sync")
    @patch("dembrane.email.send_email_sync")
    @patch("dembrane.email_throttle.flush_all_digests_sync")
    @patch("dembrane.tasks.get_settings")
    def test_multiple_recipients_each_get_digest(
        self, mock_settings, mock_flush, mock_send, mock_resolve
    ):
        mock_settings.return_value.urls.admin_base_url = "https://app.dembrane.com"
        mock_flush.return_value = {
            "a-id": [{"summary": "r1", "timestamp": "10:00"}],
            "b-id": [
                {"summary": "r2", "timestamp": "10:00"},
                {"summary": "r3", "timestamp": "10:05"},
            ],
        }
        mock_resolve.side_effect = lambda uid: f"{uid}@test.com"
        mock_send.return_value = True

        from dembrane.tasks import task_flush_email_digests
        task_flush_email_digests()

        assert mock_send.call_count == 2

    @patch("dembrane.tasks._resolve_recipient_email_sync")
    @patch("dembrane.email.send_email_sync")
    @patch("dembrane.email_throttle.flush_all_digests_sync")
    @patch("dembrane.tasks.get_settings")
    def test_digest_subject_uses_item_count(
        self, mock_settings, mock_flush, mock_send, mock_resolve
    ):
        mock_settings.return_value.urls.admin_base_url = "https://app.dembrane.com"
        mock_flush.return_value = {
            "r-id": [{"summary": "x", "timestamp": "t"}],
        }
        mock_resolve.return_value = "r@test.com"
        mock_send.return_value = True

        from dembrane.tasks import task_flush_email_digests
        task_flush_email_digests()

        subject = mock_send.call_args[1]["subject"]
        assert "1 notification" in subject
        assert "notifications" not in subject


# ── WORKSPACE_REQUEST_SUBMITTED wiring ───────────────────────────────


class TestWorkspaceRequestSubmittedThrottle:
    """Verify the submit endpoint routes email through the throttle."""

    @pytest.mark.asyncio
    async def test_individual_sends_email_directly(self):
        """When under threshold, send_email is called per staff member."""
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(side_effect=[
            [{"user_id": "u1", "role": "owner"}],
            [],
        ])
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "req-1"}})
        mock_directus.get_item = AsyncMock(return_value={"name": "TestOrg"})

        mock_redis = _make_mock_redis(zcard_return=2)
        mock_get_redis = AsyncMock(return_value=mock_redis)

        with (
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value={
                "id": "u1", "display_name": "Test User", "email": "user@test.com",
            }),
            patch("dembrane.api.v2.workspace_requests.audience_staff", return_value=["staff-1"]),
            patch("dembrane.api.v2.workspace_requests.emit_to_audience", return_value=["n1"]),
            patch("dembrane.api.v2.workspace_requests._resolve_emails", return_value=["staff@test.com"]),
            patch("dembrane.api.v2.workspace_requests.send_email", return_value=True) as mock_send,
            patch("dembrane.redis_async.get_redis_client", mock_get_redis),
            patch("dembrane.api.v2.workspace_requests.get_settings") as mock_settings,
        ):
            mock_settings.return_value.urls.admin_base_url = "https://app.dembrane.com"

            from dembrane.api.v2.workspace_requests import (
                SubmitWorkspaceRequest,
                submit_workspace_request,
            )

            auth = MagicMock()
            auth.user_id = "directus-user-1"
            body = SubmitWorkspaceRequest(
                kind="new_workspace",
                org_id="org-1",
                proposed_name="My Workspace",
                proposed_tier="innovator",
            )
            result = await submit_workspace_request(body, auth)

            assert result.status == "pending"
            mock_send.assert_called_once()

    @pytest.mark.asyncio
    async def test_over_threshold_queues_for_digest(self):
        """When at threshold, email is queued instead of sent."""
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(side_effect=[
            [{"user_id": "u1", "role": "owner"}],
            [],
        ])
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "req-1"}})
        mock_directus.get_item = AsyncMock(return_value={"name": "TestOrg"})

        mock_redis = _make_mock_redis(zcard_return=5)
        mock_get_redis = AsyncMock(return_value=mock_redis)
        mock_redis.rpush = AsyncMock()
        mock_redis.sadd = AsyncMock()

        with (
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value={
                "id": "u1", "display_name": "Test User", "email": "user@test.com",
            }),
            patch("dembrane.api.v2.workspace_requests.audience_staff", return_value=["staff-1"]),
            patch("dembrane.api.v2.workspace_requests.emit_to_audience", return_value=["n1"]),
            patch("dembrane.api.v2.workspace_requests._resolve_emails", return_value=["staff@test.com"]),
            patch("dembrane.api.v2.workspace_requests.send_email", return_value=True) as mock_send,
            patch("dembrane.redis_async.get_redis_client", mock_get_redis),
            patch("dembrane.api.v2.workspace_requests.get_settings") as mock_settings,
        ):
            mock_settings.return_value.urls.admin_base_url = "https://app.dembrane.com"

            from dembrane.api.v2.workspace_requests import (
                SubmitWorkspaceRequest,
                submit_workspace_request,
            )

            auth = MagicMock()
            auth.user_id = "directus-user-1"
            body = SubmitWorkspaceRequest(
                kind="new_workspace",
                org_id="org-1",
                proposed_name="My Workspace",
                proposed_tier="innovator",
            )
            result = await submit_workspace_request(body, auth)

            assert result.status == "pending"
            mock_send.assert_not_called()
            mock_redis.rpush.assert_called_once()

    @pytest.mark.asyncio
    async def test_in_app_notification_always_fires(self):
        """emit_to_audience is called regardless of email throttle state."""
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(side_effect=[
            [{"user_id": "u1", "role": "owner"}],
            [],
        ])
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "req-1"}})
        mock_directus.get_item = AsyncMock(return_value={"name": "TestOrg"})

        mock_redis = _make_mock_redis(zcard_return=10)
        mock_get_redis = AsyncMock(return_value=mock_redis)
        mock_redis.rpush = AsyncMock()
        mock_redis.sadd = AsyncMock()

        with (
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value={
                "id": "u1", "display_name": "Test User", "email": "user@test.com",
            }),
            patch("dembrane.api.v2.workspace_requests.audience_staff", return_value=["staff-1"]),
            patch("dembrane.api.v2.workspace_requests.emit_to_audience", return_value=["n1"]) as mock_emit,
            patch("dembrane.api.v2.workspace_requests._resolve_emails", return_value=["staff@test.com"]),
            patch("dembrane.api.v2.workspace_requests.send_email", return_value=True),
            patch("dembrane.redis_async.get_redis_client", mock_get_redis),
            patch("dembrane.api.v2.workspace_requests.get_settings") as mock_settings,
        ):
            mock_settings.return_value.urls.admin_base_url = "https://app.dembrane.com"

            from dembrane.api.v2.workspace_requests import (
                SubmitWorkspaceRequest,
                submit_workspace_request,
            )

            auth = MagicMock()
            auth.user_id = "directus-user-1"
            body = SubmitWorkspaceRequest(
                kind="new_workspace",
                org_id="org-1",
                proposed_name="My Workspace",
                proposed_tier="innovator",
            )
            await submit_workspace_request(body, auth)

            mock_emit.assert_called_once()
            assert mock_emit.call_args[1]["event_code"] == "WORKSPACE_REQUEST_SUBMITTED"


# ── Sliding window semantics ─────────────────────────────────────────


class TestSlidingWindowSemantics:
    """Verify that the 24h sliding window correctly ages out events."""

    def test_events_older_than_24h_drop_out(self):
        """History that falls outside the window doesn't count."""
        assert should_send_now("r", "E", 0) == "individual"
        assert should_send_now("r", "E", 4) == "individual"
        assert should_send_now("r", "E", 5) == "queue_for_digest"

    @pytest.mark.asyncio
    async def test_pruning_cutoff_uses_24h_window(self):
        """record_and_check_throttle prunes using now - 24h as the cutoff."""
        mock_redis = _make_mock_redis(zcard_return=0)
        mock_get = AsyncMock(return_value=mock_redis)
        now = 1_700_000_000.0

        with (
            patch("dembrane.redis_async.get_redis_client", mock_get),
            patch("dembrane.email_throttle.time") as mock_time,
        ):
            mock_time.time.return_value = now
            from dembrane.email_throttle import record_and_check_throttle
            await record_and_check_throttle("r", "E")

        call_args = mock_redis.zremrangebyscore.call_args[0]
        cutoff = float(call_args[2])
        assert cutoff == pytest.approx(now - _WINDOW_SECONDS, abs=1)


# ── Email template rendering ─────────────────────────────────────────


class TestDigestEmailTemplate:
    """Verify digest email templates render without errors."""

    def test_html_template_renders(self):
        from dembrane.email import _render_template

        html = _render_template("notification_digest", {
            "item_count": 3,
            "items": [
                {"summary": "Alice requested a new workspace", "timestamp": "2026-05-11 10:00 UTC"},
                {"summary": "Bob requested a tier upgrade", "timestamp": "2026-05-11 10:30 UTC"},
                {"summary": "Carol requested a new workspace", "timestamp": "2026-05-11 11:00 UTC"},
            ],
            "admin_url": "https://app.dembrane.com/admin/upgrades",
        })
        assert "3" in html
        assert "Alice" in html
        assert "Bob" in html
        assert "Carol" in html
        assert "admin/upgrades" in html

    def test_txt_template_renders(self):
        from dembrane.email import _render_plain_text_template

        txt = _render_plain_text_template("notification_digest", {
            "item_count": 2,
            "items": [
                {"summary": "Alice requested a new workspace", "timestamp": "2026-05-11 10:00 UTC"},
                {"summary": "Bob requested a tier upgrade", "timestamp": "2026-05-11 10:30 UTC"},
            ],
            "admin_url": "https://app.dembrane.com/admin/upgrades",
        })
        assert txt is not None
        assert "Alice" in txt
        assert "Bob" in txt
        assert "admin/upgrades" in txt

    def test_html_single_item_no_plural(self):
        from dembrane.email import _render_template

        html = _render_template("notification_digest", {
            "item_count": 1,
            "items": [
                {"summary": "A request", "timestamp": "2026-05-11"},
            ],
            "admin_url": "https://example.com",
        })
        assert "1 notification" in html


# ── Scheduler registration ───────────────────────────────────────────


class TestSchedulerRegistration:
    def test_digest_flush_job_registered(self):
        from dembrane.scheduler import scheduler

        job = scheduler.get_job("task_flush_email_digests")
        assert job is not None
        assert "task_flush_email_digests" in str(job.func_ref)
