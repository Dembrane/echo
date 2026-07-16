"""Tests for the server_chunk_upload_rejected and server_chunk_missing_in_s3
captures in confirm_chunk_upload."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from dembrane.api.participant import ConfirmUploadRequest, confirm_chunk_upload


def _body(**overrides: object) -> ConfirmUploadRequest:
    fields = {
        "chunk_id": "chunk-1",
        "file_url": "https://s3.example/dbr/audio.webm",
        "source": "PORTAL_AUDIO",
        "timestamp": "2026-07-16T00:00:00Z",
    }
    fields.update(overrides)
    return ConfirmUploadRequest(**fields)


@pytest.mark.asyncio
async def test_confirm_upload_captures_bad_chunk_when_too_small() -> None:
    with (
        patch("dembrane.api.participant.get_file_size_bytes_from_s3", return_value=512),
        patch(
            "dembrane.api.participant.run_in_thread_pool",
            new=AsyncMock(side_effect=lambda fn, *a, **k: fn(*a, **k)),
        ),
        patch(
            "dembrane.api.participant.conversation_service.create_chunk",
            return_value={"id": "row-1"},
        ),
        patch(
            "dembrane.api.participant.conversation_service.update_chunk",
            return_value=None,
        ),
        patch("dembrane.api.participant.capture_event", new=AsyncMock()) as capture,
    ):
        await confirm_chunk_upload("conv-1", _body())

    capture.assert_any_await(
        "conv-1",
        "server_chunk_upload_rejected",
        {"chunk_id": "chunk-1", "file_size": 512},
    )


@pytest.mark.asyncio
async def test_confirm_upload_captures_s3_not_found_after_retries() -> None:
    with (
        patch(
            "dembrane.api.participant.get_file_size_bytes_from_s3",
            side_effect=Exception("not found"),
        ),
        patch(
            "dembrane.api.participant.run_in_thread_pool",
            new=AsyncMock(side_effect=lambda fn, *a, **k: fn(*a, **k)),
        ),
        patch("dembrane.api.participant.asyncio.sleep", new=AsyncMock()),
        patch("dembrane.api.participant.capture_event", new=AsyncMock()) as capture,
    ):
        with pytest.raises(HTTPException) as exc_info:
            await confirm_chunk_upload("conv-1", _body())

    assert exc_info.value.status_code == 400
    capture.assert_any_await(
        "conv-1",
        "server_chunk_missing_in_s3",
        {"chunk_id": "chunk-1"},
    )
