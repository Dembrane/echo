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

`async_directus` is mocked throughout; no live Directus.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from dembrane.api.dependency_auth import DirectusSession
from dembrane.api.v2.pricing_configurations import (
    _clean,
    _read_body,
    _merge_audio,
    _flat_mirrors,
    _new_reference,
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
