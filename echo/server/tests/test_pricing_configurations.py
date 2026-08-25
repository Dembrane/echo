"""Tests for POST /v2/pricing-configurations, the pricing configurator's row.

What matters here:

- A row appears at the first answer, and each step updates the same row. So
  the write is an upsert on `config_session_id` and the reference it returns
  never changes for that session.
- Internal traffic is flagged when it is written, from the account, not
  guessed later.
- The identity boundary: the email comes from the session and never from the
  payload, so a client cannot claim to be somebody else.
- A recording that cannot be stored costs the recording and never the answers.
- A booking lands on the row that already holds the answers, and a booking
  write only ever raises the status, never lowers it.
- The outbox that tells the team about a booking sends each row once, retries
  what it could not deliver, and stays quiet when it is not configured.

`async_directus` is mocked throughout; no live Directus.
"""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import requests
from fastapi import HTTPException
from starlette.requests import Request

from dembrane.tasks import (
    task_forward_pricing_bookings,
    build_pricing_booking_forward_payload,
)
from dembrane.api.dependency_auth import DirectusSession
from dembrane.api.v2.pricing_configurations import (
    _clean,
    _read_body,
    _merge_audio,
    _flat_mirrors,
    _new_reference,
    build_answers_summary,
    upsert_pricing_configuration,
)

MODULE = "dembrane.api.v2.pricing_configurations"


def _auth(user_id: str = "user-1") -> DirectusSession:
    return DirectusSession(user_id=user_id, is_admin=False)


def _payload(**overrides: Any) -> dict[str, Any]:
    body = {
        "config_session_id": "session-1",
        "question_set_version": "20-aug-26",
        "config_shape_version": 1,
        "mount": "app",
        "locale": "nl-NL",
        "wall_key": "transcription_cap",
        "workspace_id": "ws-1",
        "answers_raw": {"use_case": ["event_workshop"]},
        "config": {"v": 1, "set": "20-aug-26", "answered": 1, "furthest_step": 1},
        "status": "in_progress",
    }
    body.update(overrides)
    return body


async def _call(
    body: dict[str, Any],
    *,
    directus: AsyncMock,
    email: str = "someone@example.org",
    user_id: str = "user-1",
    attachments: list | None = None,
) -> Any:
    """Run the handler with the body already parsed, so these tests are about
    the write and not about multipart parsing (which `_read_body` owns)."""
    with (
        patch(f"{MODULE}.async_directus", directus),
        patch(f"{MODULE}._read_body", AsyncMock(return_value=(body, attachments or []))),
        patch(f"{MODULE}._rate_limiter") as limiter,
        patch(
            f"{MODULE}.get_directus_user_profile",
            AsyncMock(return_value={"email": email} if email else None),
        ),
    ):
        limiter.check = AsyncMock(return_value=None)
        return await upsert_pricing_configuration(request=None, auth=_auth(user_id))  # type: ignore[arg-type]


def _directus(existing: dict[str, Any] | None = None) -> AsyncMock:
    directus = AsyncMock()
    directus.get_items = AsyncMock(return_value=[existing] if existing else [])
    directus.create_item = AsyncMock(
        side_effect=lambda _collection, data: {"data": {**data}}
    )
    directus.update_item = AsyncMock(
        side_effect=lambda _collection, item_id, data: {
            "data": {**(existing or {}), **data, "id": item_id}
        }
    )
    return directus


# ── the row appears at the first answer ──


@pytest.mark.asyncio
async def test_first_answer_creates_one_row_with_a_reference():
    directus = _directus()

    result = await _call(_payload(), directus=directus)

    assert result.reference.startswith("DEM-")
    directus.create_item.assert_awaited_once()
    collection, row = directus.create_item.await_args.args
    assert collection == "pricing_configuration"
    assert row["config_session_id"] == "session-1"
    assert row["status"] == "in_progress"
    assert row["answers_raw"] == {"use_case": ["event_workshop"]}
    assert row["question_set_version"] == "20-aug-26"
    assert row["locale"] == "nl-NL"
    assert row["workspace_id"] == "ws-1"
    directus.update_item.assert_not_awaited()


@pytest.mark.asyncio
async def test_second_write_updates_the_same_row_and_keeps_the_reference():
    directus = _directus(
        {"id": "row-1", "reference": "DEM-4F2A", "status": "in_progress", "user_id": "user-1"}
    )

    result = await _call(
        _payload(
            status="submitted",
            answers_raw={"use_case": ["event_workshop"], "volume": "10_to_50"},
        ),
        directus=directus,
    )

    assert result.reference == "DEM-4F2A"
    directus.create_item.assert_not_awaited()
    directus.update_item.assert_awaited_once()
    _collection, item_id, row = directus.update_item.await_args.args
    assert item_id == "row-1"
    assert row["status"] == "submitted"
    assert row["answers_raw"]["volume"] == "10_to_50"
    # The reference is minted once and never re-minted.
    assert "reference" not in row


@pytest.mark.asyncio
async def test_submitted_never_falls_back_to_in_progress():
    directus = _directus(
        {"id": "row-1", "reference": "DEM-4F2A", "status": "submitted", "user_id": "user-1"}
    )

    await _call(_payload(status="in_progress"), directus=directus)

    _collection, _id, row = directus.update_item.await_args.args
    assert row["status"] == "submitted"


# ── the booking lands on the row that holds the answers ──


def _booking_payload(**overrides: Any) -> dict[str, Any]:
    body = _payload(
        status="submitted",
        booking_uid="cal-bk-9f3",
        # Cal.com's own casing. The row stores the word, lowercased.
        booking_status="ACCEPTED",
        booking_start="2026-09-01T09:00:00.000Z",
    )
    body.update(overrides)
    return body


def _booked_row(**overrides: Any) -> dict[str, Any]:
    row = {
        "id": "row-1",
        "reference": "DEM-4F2A",
        "status": "submitted",
        "user_id": "user-1",
        "booking_uid": "cal-bk-9f3",
        "config": {
            "v": 1,
            "booking": {
                "uid": "cal-bk-9f3",
                "status": "accepted",
                "start": "2026-09-01T09:00:00.000Z",
            },
        },
    }
    row.update(overrides)
    return row


@pytest.mark.asyncio
async def test_a_booking_writes_the_uid_the_status_and_the_start():
    directus = _directus(
        {"id": "row-1", "reference": "DEM-4F2A", "status": "submitted", "user_id": "user-1"}
    )

    await _call(_booking_payload(), directus=directus)

    directus.update_item.assert_awaited_once()
    _collection, item_id, row = directus.update_item.await_args.args
    assert item_id == "row-1"
    assert row["booking_uid"] == "cal-bk-9f3"
    assert row["booking_status"] == "accepted"
    # No column for the start time, so it rides in the JSON beside the two
    # values that do have columns.
    assert row["config"]["booking"] == {
        "uid": "cal-bk-9f3",
        "status": "accepted",
        "start": "2026-09-01T09:00:00.000Z",
    }


@pytest.mark.asyncio
async def test_a_booking_raises_a_lagging_status_and_never_lowers_one():
    # The client fell behind and still says in_progress. Nobody books a call on
    # an attempt that was never sent, so the row goes forward, not back.
    directus = _directus(
        {"id": "row-1", "reference": "DEM-4F2A", "status": "in_progress", "user_id": "user-1"}
    )

    await _call(_booking_payload(status="in_progress"), directus=directus)

    _collection, _id, row = directus.update_item.await_args.args
    assert row["status"] == "submitted"


@pytest.mark.asyncio
async def test_a_later_step_write_cannot_blank_the_booking():
    directus = _directus(_booked_row())

    await _call(_payload(status="in_progress"), directus=directus)

    _collection, _id, row = directus.update_item.await_args.args
    # The booking columns are not in the patch at all, so Directus leaves them
    # exactly as they were.
    assert "booking_uid" not in row
    assert "booking_status" not in row
    # The client owns `config` and knows nothing about this key, so it is
    # carried forward rather than dropped.
    assert row["config"]["booking"]["uid"] == "cal-bk-9f3"
    assert row["config"]["booking"]["start"] == "2026-09-01T09:00:00.000Z"


@pytest.mark.asyncio
async def test_the_same_uid_updates_and_keeps_the_start_it_already_had():
    directus = _directus(_booked_row())

    await _call(
        _booking_payload(booking_status="cancelled", booking_start=None),
        directus=directus,
    )

    _collection, _id, row = directus.update_item.await_args.args
    assert row["booking_uid"] == "cal-bk-9f3"
    assert row["booking_status"] == "cancelled"
    assert row["config"]["booking"]["start"] == "2026-09-01T09:00:00.000Z"
    # Same booking, so nothing is re-sent.
    assert "booking_notified_at" not in row


@pytest.mark.asyncio
async def test_a_different_uid_is_logged_and_the_newest_wins(caplog):
    directus = _directus(_booked_row())

    with caplog.at_level(logging.WARNING, logger="api.v2.pricing_configurations"):
        await _call(
            _booking_payload(
                booking_uid="cal-bk-later",
                booking_start="2026-09-08T09:00:00.000Z",
            ),
            directus=directus,
        )

    assert "already carried booking" in caplog.text
    assert "cal-bk-9f3" in caplog.text and "cal-bk-later" in caplog.text

    _collection, _id, row = directus.update_item.await_args.args
    assert row["booking_uid"] == "cal-bk-later"
    assert row["config"]["booking"] == {
        "uid": "cal-bk-later",
        "status": "accepted",
        "start": "2026-09-08T09:00:00.000Z",
    }
    # A booking the team has not heard about yet, so the outbox gets it back.
    assert row["booking_notified_at"] is None


@pytest.mark.asyncio
async def test_a_status_without_a_uid_writes_no_booking():
    directus = _directus(
        {"id": "row-1", "reference": "DEM-4F2A", "status": "submitted", "user_id": "user-1"}
    )

    await _call(
        _payload(status="submitted", booking_status="accepted", booking_start="2026-09-01"),
        directus=directus,
    )

    _collection, _id, row = directus.update_item.await_args.args
    assert "booking_uid" not in row
    assert "booking_status" not in row
    assert "booking" not in row["config"]


# ── identity comes from the session, never from the payload ──


@pytest.mark.asyncio
async def test_email_and_internal_flag_come_from_the_session():
    directus = _directus()

    await _call(
        _payload(email="attacker@dembrane.com", is_internal=True, user_id="somebody-else"),
        directus=directus,
        email="Real.Person@Example.org",
        user_id="user-1",
    )

    _collection, row = directus.create_item.await_args.args
    assert row["email"] == "real.person@example.org"
    assert row["is_internal"] is False
    assert row["user_id"] == "user-1"


@pytest.mark.asyncio
async def test_a_dembrane_address_is_flagged_internal():
    directus = _directus()

    await _call(_payload(), directus=directus, email="staff@dembrane.com")

    _collection, row = directus.create_item.await_args.args
    assert row["is_internal"] is True


@pytest.mark.asyncio
async def test_another_users_session_id_is_refused():
    directus = _directus(
        {"id": "row-1", "reference": "DEM-4F2A", "status": "in_progress", "user_id": "someone-else"}
    )

    with pytest.raises(HTTPException) as caught:
        await _call(_payload(), directus=directus, user_id="user-1")

    assert caught.value.status_code == 403
    directus.update_item.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_malformed_payload_is_a_422_not_a_500():
    directus = _directus()

    with pytest.raises(HTTPException) as caught:
        await _call(_payload(config_session_id=""), directus=directus)

    assert caught.value.status_code == 422


# ── the recording degrades, the answers do not ──


@pytest.mark.asyncio
async def test_a_recording_that_cannot_be_stored_keeps_the_answers():
    directus = _directus()
    attachment = type(
        "Fake", (), {"question_key": "context", "duration_ms": 18000, "content": b"x"}
    )()

    with patch(
        f"{MODULE}._upload_to_directus", AsyncMock(side_effect=RuntimeError("storage down"))
    ):
        result = await _call(_payload(), directus=directus, attachments=[attachment])

    assert result.reference.startswith("DEM-")
    assert result.warnings and "could not be stored" in result.warnings[0]
    # The answers were written first, and the attempt is recorded on the row.
    directus.create_item.assert_awaited_once()
    _collection, _id, audio_row = directus.update_item.await_args.args
    entry = audio_row["voice_audio"][0]
    assert entry["question_key"] == "context"
    assert entry["stored"] is False
    assert "storage down" in entry["error"]


# ── the small pure parts ──


def test_flat_mirrors_derive_from_config():
    mirrors = _flat_mirrors(
        {
            "volume": "10_to_50",
            "concurrency": "more_than_40",
            "concurrency_exact": 120,
            "answered": 5,
            "furthest_step": 6,
        }
    )
    assert mirrors == {
        "volume_bucket": "10_to_50",
        "concurrency_bucket": "more_than_40",
        "concurrency_exact": 120,
        "answered_count": 5,
        "furthest_step": 6,
    }


def test_flat_mirrors_ignore_a_wrong_type():
    # A missing key means unanswered, and nothing here may throw on a bad one.
    mirrors = _flat_mirrors({"volume": 12, "concurrency_exact": True, "answered": "five"})
    assert mirrors["volume_bucket"] is None
    assert mirrors["concurrency_exact"] is None
    assert mirrors["answered_count"] is None


def test_reference_avoids_ambiguous_glyphs():
    for _ in range(200):
        reference = _new_reference()
        assert reference.startswith("DEM-")
        assert len(reference) == 8
        assert not set(reference[4:]) & set("01ILO")


def test_blank_strings_become_null():
    assert _clean("  ") is None
    assert _clean(None) is None
    assert _clean(" nl-NL ") == "nl-NL"


def test_merge_audio_keeps_one_entry_per_question():
    merged = _merge_audio(
        [{"question_key": "context", "stored": False}],
        [{"question_key": "context", "stored": True}, {"question_key": "timing", "stored": True}],
    )
    by_key = {entry["question_key"]: entry for entry in merged}
    assert len(merged) == 2
    assert by_key["context"]["stored"] is True


# ── the body shapes the client actually sends ──


def _request(body: bytes, content_type: str) -> Request:
    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/v2/pricing-configurations",
        "headers": [(b"content-type", content_type.encode())],
    }
    return Request(scope, receive)


@pytest.mark.asyncio
async def test_json_body_reads_with_no_attachments():
    body, attachments = await _read_body(
        _request(json.dumps(_payload()).encode(), "application/json")
    )
    assert body["config_session_id"] == "session-1"
    assert attachments == []


@pytest.mark.asyncio
async def test_multipart_body_reads_the_payload_part_and_the_recordings():
    boundary = "----pricingtest"
    payload = json.dumps(_payload())
    parts = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="payload"\r\n\r\n'
        f"{payload}\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="audio_context"; filename="context.webm"\r\n'
        "Content-Type: audio/webm\r\n\r\n"
        "AUDIOBYTES\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="audio_context_duration_ms"\r\n\r\n'
        "18000\r\n"
        f"--{boundary}--\r\n"
    ).encode()

    body, attachments = await _read_body(
        _request(parts, f"multipart/form-data; boundary={boundary}")
    )

    assert body["config_session_id"] == "session-1"
    assert len(attachments) == 1
    assert attachments[0].question_key == "context"
    assert attachments[0].duration_ms == 18000
    assert attachments[0].content == b"AUDIOBYTES"
    assert attachments[0].filename == "context.webm"


@pytest.mark.asyncio
async def test_a_multipart_body_with_no_payload_part_is_a_400():
    boundary = "----pricingtest"
    parts = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="something_else"\r\n\r\n'
        "nothing\r\n"
        f"--{boundary}--\r\n"
    ).encode()

    with pytest.raises(HTTPException) as caught:
        await _read_body(_request(parts, f"multipart/form-data; boundary={boundary}"))

    assert caught.value.status_code == 400


# ── the summary the team reads, built from the keys that were sent ──


ANSWERS = {
    "use_case": ["assembly", "something_else"],
    "use_case_other": "a museum tour",
    "timing": "Six weekends across seven months",
    "volume": "50_to_250",
    "concurrency": "more_than_40",
    "concurrency_exact": "120",
    "extras": ["event_help"],
    "context": "A citizens assembly on housing.",
}


def test_the_summary_reads_in_english_from_the_keys_that_were_sent():
    assert build_answers_summary(ANSWERS) == (
        "Use case: an assembly, something else: a museum tour"
        " | Timing: Six weekends across seven months"
        " | Volume: 50 to 250"
        " | At once: more than 40 (120)"
        " | Extras: event help"
        " | Notes: A citizens assembly on housing."
    )


def test_a_skipped_question_is_absent_rather_than_blank():
    assert build_answers_summary({"volume": "under_50"}) == "Volume: under 50"
    assert build_answers_summary({}) == ""
    assert build_answers_summary(None) == ""


def test_an_option_the_map_does_not_know_still_reads():
    # A question set that moved on must degrade to the key, never drop the
    # answer.
    assert build_answers_summary({"volume": "50_to_9000"}) == "Volume: 50_to_9000"


def test_free_text_stays_one_short_line():
    summary = build_answers_summary({"context": "a\nb" + ("x" * 400)})
    assert "\n" not in summary
    assert summary.endswith("...")
    assert len(summary) < 200


# ── the outbox that tells the team about a booking ──


def _forward_settings(
    url: str | None = "https://proxy.example/echo-support",
    token: str | None = "tok-123",
    admin: str = "https://dashboard.dembrane.com",
) -> SimpleNamespace:
    return SimpleNamespace(
        support=SimpleNamespace(
            forward_webhook_url=url,
            forward_webhook_token=token,
            forwarding_enabled=bool(url and token),
        ),
        urls=SimpleNamespace(admin_base_url=admin),
    )


def _ctx(client: MagicMock) -> MagicMock:
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=client)
    ctx.__exit__ = MagicMock(return_value=False)
    return ctx


def _forward_row(rid: str = "row-1", **overrides: Any) -> dict[str, Any]:
    row = {
        "id": rid,
        "reference": "DEM-4F2A",
        "booking_uid": "cal-bk-9f3",
        "booking_status": "accepted",
        "config": {
            "v": 1,
            "booking": {
                "uid": "cal-bk-9f3",
                "status": "accepted",
                "start": "2026-09-01T09:00:00.000Z",
            },
        },
        "answers_raw": ANSWERS,
        "email": "someone@example.org",
        "locale": "nl-NL",
        "workspace_id": "ws-1",
        "org_id": "org-1",
        "is_internal": False,
    }
    row.update(overrides)
    return row


def _forward_client(rows: list[dict[str, Any]]) -> MagicMock:
    client = MagicMock()
    client.get_items.return_value = rows
    return client


def _resp(status_code: int, text: str = "ok") -> SimpleNamespace:
    return SimpleNamespace(status_code=status_code, text=text)


def test_the_payload_says_what_kind_it_is():
    payload = build_pricing_booking_forward_payload(_forward_row(), "production")

    # The one field that tells the receiver this is not a support request.
    assert payload["kind"] == "pricing_booking"
    assert payload["environment"] == "production"
    assert payload["reference"] == "DEM-4F2A"
    assert payload["booking_uid"] == "cal-bk-9f3"
    assert payload["booking_status"] == "accepted"
    assert payload["booking_start"] == "2026-09-01T09:00:00.000Z"
    assert payload["email"] == "someone@example.org"
    assert payload["locale"] == "nl-NL"
    assert payload["workspace_id"] == "ws-1"
    assert payload["org_id"] == "org-1"
    assert payload["is_internal"] is False
    assert payload["summary"].startswith("Use case: an assembly")


def test_the_payload_omits_what_the_row_does_not_have():
    row = {"id": "row-2", "booking_uid": "cal-bk-2"}
    payload = build_pricing_booking_forward_payload(row, "development")

    assert set(payload) == {"kind", "environment", "booking_uid", "is_internal"}
    assert payload["is_internal"] is False


def test_a_booking_is_posted_once_and_marked():
    client = _forward_client([_forward_row()])
    with (
        patch("dembrane.tasks.get_settings", return_value=_forward_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", return_value=_resp(200)) as post,
    ):
        task_forward_pricing_bookings()

    assert post.call_count == 1
    args, kwargs = post.call_args
    assert args[0] == "https://proxy.example/echo-support"
    assert kwargs["headers"]["X-Echo-Support-Token"] == "tok-123"
    assert kwargs["json"]["kind"] == "pricing_booking"
    assert kwargs["json"]["booking_uid"] == "cal-bk-9f3"

    client.update_item.assert_called_once()
    collection, rid, patch_body = client.update_item.call_args[0]
    assert (collection, rid) == ("pricing_configuration", "row-1")
    assert patch_body["booking_notified_at"]

    # Idempotence is the query: only rows with a booking and no stamp.
    _collection, query = client.get_items.call_args[0]
    assert query["query"]["filter"] == {
        "booking_uid": {"_nnull": True},
        "booking_notified_at": {"_null": True},
    }


def test_a_failed_post_is_retried_on_the_next_run():
    client = _forward_client([_forward_row()])
    settings = _forward_settings()

    with (
        patch("dembrane.tasks.get_settings", return_value=settings),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", return_value=_resp(503, "down")) as post,
    ):
        task_forward_pricing_bookings()

    assert post.call_count == 1
    client.update_item.assert_not_called()  # never stamped, so still selected

    with (
        patch("dembrane.tasks.get_settings", return_value=settings),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", return_value=_resp(200)) as post,
    ):
        task_forward_pricing_bookings()

    assert post.call_count == 1
    client.update_item.assert_called_once()
    assert client.update_item.call_args[0][1] == "row-1"


def test_a_network_error_stops_the_batch_without_stamping():
    client = _forward_client([_forward_row("row-a"), _forward_row("row-b")])
    with (
        patch("dembrane.tasks.get_settings", return_value=_forward_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", side_effect=requests.ConnectionError("down")),
    ):
        task_forward_pricing_bookings()

    client.update_item.assert_not_called()


def test_a_4xx_leaves_the_row_unstamped_and_keeps_going():
    client = _forward_client([_forward_row("row-a"), _forward_row("row-b")])
    with (
        patch("dembrane.tasks.get_settings", return_value=_forward_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", side_effect=[_resp(400, "bad"), _resp(200)]) as post,
    ):
        task_forward_pricing_bookings()

    assert post.call_count == 2
    client.update_item.assert_called_once()
    assert client.update_item.call_args[0][1] == "row-b"


def test_nothing_is_sent_when_the_webhook_is_not_configured():
    with (
        patch("dembrane.tasks.get_settings", return_value=_forward_settings(url=None, token=None)),
        patch("dembrane.tasks.directus_client_context") as ctx,
        patch("requests.post") as post,
    ):
        task_forward_pricing_bookings()

    ctx.assert_not_called()
    post.assert_not_called()


def test_no_bookings_is_quiet():
    client = _forward_client([])
    with (
        patch("dembrane.tasks.get_settings", return_value=_forward_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post") as post,
    ):
        task_forward_pricing_bookings()

    post.assert_not_called()
    client.update_item.assert_not_called()
