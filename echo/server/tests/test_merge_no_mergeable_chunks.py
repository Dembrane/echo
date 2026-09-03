"""
When every chunk of a conversation fails to probe (production case: one truncated mp3
upload), the merge cannot succeed on retry. The failure must name the chunks and the
merge task must stop instead of retrying through Dramatiq. Transport failures are
different: those must keep retrying.
"""

from __future__ import annotations

import io
import asyncio
import subprocess
from types import SimpleNamespace

import pytest

import dembrane.tasks as tasks
import dembrane.audio_utils as audio_utils
import dembrane.api.conversation as conversation_api
from dembrane.service import conversation_service
from dembrane.api.exceptions import NoMergeableChunksException

FFPROBE_STDERR = b"[mp3 @ 0x7f] Failed to find two consecutive MPEG audio frames."


def _failing_ffprobe(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every ffprobe invocation fail the way it does on a truncated upload."""

    def _run(*_a, **_k):
        return SimpleNamespace(returncode=1, stdout=b"", stderr=FFPROBE_STDERR)

    monkeypatch.setattr(subprocess, "run", _run)


def test_probe_from_bytes_raises_ffmpeg_error_on_corrupt_audio(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _failing_ffprobe(monkeypatch)
    with pytest.raises(audio_utils.FFmpegError, match="MPEG audio frames"):
        audio_utils.probe_from_bytes(b"not really mp3 bytes", "mp3")


def test_corrupt_upload_through_real_probe_is_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    """End to end through probe_from_s3 -> probe_from_bytes, no exception type stubbed."""
    _failing_ffprobe(monkeypatch)
    monkeypatch.setattr(audio_utils, "get_stream_from_s3", lambda _n: io.BytesIO(b"garbage"))

    with pytest.raises(audio_utils.NoMergeableChunksError) as excinfo:
        audio_utils.merge_multiple_audio_files_and_save_to_s3(
            ["https://s3/chunks/Nieuwe opname 227.mp3"], "out.mp3", "mp3"
        )
    assert "MPEG audio frames" in str(excinfo.value)


def test_all_probes_failing_raises_no_mergeable_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    def _probe(name: str, _fmt: str) -> dict:
        raise audio_utils.FFmpegError(
            "ffprobe error: Failed to find two consecutive MPEG audio frames"
        )

    monkeypatch.setattr(audio_utils, "probe_from_s3", _probe)

    with pytest.raises(audio_utils.NoMergeableChunksError) as excinfo:
        audio_utils.merge_multiple_audio_files_and_save_to_s3(
            ["https://s3/chunks/a.mp3", "https://s3/chunks/b.mp3"], "out.mp3", "mp3"
        )

    message = str(excinfo.value)
    assert "a.mp3" in message and "b.mp3" in message
    assert "MPEG audio frames" in message


@pytest.mark.parametrize(
    "error_type", [audio_utils.FileTooLargeError, audio_utils.FileTooSmallError]
)
def test_size_rejections_during_conversion_are_terminal(
    monkeypatch: pytest.MonkeyPatch, error_type: type[Exception]
) -> None:
    """Conversion runs inside the probe loop for non-mp3 chunks and rejects on size.
    The bytes will not change on retry, so this is as terminal as a failed probe."""
    monkeypatch.setattr(
        audio_utils, "probe_from_s3", lambda _n, _f: {"format": {"format_name": "webm"}}
    )

    def _convert(*_a, **_k):
        raise error_type("size out of range")

    monkeypatch.setattr(audio_utils, "convert_and_save_to_s3", _convert)

    with pytest.raises(audio_utils.NoMergeableChunksError):
        audio_utils.merge_multiple_audio_files_and_save_to_s3(
            ["https://s3/chunks/a.webm"], "out.mp3", "mp3"
        )


def test_partial_skips_are_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """One bad chunk among good ones is skipped silently today; the merge should say so."""
    _failing_ffprobe(monkeypatch)
    monkeypatch.setattr(audio_utils, "get_stream_from_s3", lambda _n: io.BytesIO(b"garbage"))

    good = {"format": {"format_name": "mp3"}}
    real_probe = audio_utils.probe_from_s3
    monkeypatch.setattr(
        audio_utils,
        "probe_from_s3",
        lambda name, fmt: good if name.endswith("good.mp3") else real_probe(name, fmt),
    )
    # Stop before ffmpeg runs; we only care about the skip report.
    monkeypatch.setattr(
        audio_utils.tempfile,
        "TemporaryDirectory",
        lambda: (_ for _ in ()).throw(RuntimeError("stop")),
    )

    with (
        caplog.at_level("WARNING", logger="audio_utils"),
        pytest.raises(RuntimeError, match="stop"),
    ):
        audio_utils.merge_multiple_audio_files_and_save_to_s3(
            ["https://s3/chunks/good.mp3", "https://s3/chunks/bad.mp3"], "out.mp3", "mp3"
        )

    skipped = [r for r in caplog.records if "Skipped 1 of 2" in r.getMessage()]
    assert skipped and "bad.mp3" in skipped[0].getMessage()


def test_transport_failure_is_not_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    """An S3 outage empties the stream list too, but a retry can fix that."""

    def _probe(name: str, _fmt: str) -> dict:
        raise ConnectionError("Could not connect to the endpoint URL")

    monkeypatch.setattr(audio_utils, "probe_from_s3", _probe)

    with pytest.raises(Exception) as excinfo:
        audio_utils.merge_multiple_audio_files_and_save_to_s3(
            ["https://s3/chunks/a.mp3"], "out.mp3", "mp3"
        )
    assert not isinstance(excinfo.value, audio_utils.NoMergeableChunksError)


def test_no_mergeable_chunks_message_is_bounded() -> None:
    """ffprobe stderr can be huge and this text is logged, stored as a processing status
    message, and returned as a 400 body. Cap it per chunk."""
    exc = audio_utils.NoMergeableChunksError(["a.mp3", "b.mp3"], ["x" * 5000, "y" * 5000])
    text = str(exc)
    assert len(text) < 700
    assert "a.mp3" in text and "b.mp3" in text
    assert "x" * 200 in text and "x" * 201 not in text


def test_http_wrapper_keeps_400_for_the_download_route() -> None:
    exc = NoMergeableChunksException("No processed data streams (1 chunk(s) failed): a.mp3")
    assert exc.status_code == 400
    assert "a.mp3" in exc.detail


def test_merge_task_stops_without_retry_when_nothing_is_mergeable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    outcomes: list[str] = []

    class _Status:
        def __init__(self, **_kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, exc_type, *_a):
            outcomes.append("failed" if exc_type else "completed")
            return False

    monkeypatch.setattr(tasks, "ProcessingStatusContext", _Status)
    monkeypatch.setattr(
        conversation_service,
        "get_chunk_counts",
        lambda _cid: {"total": 1, "ok": 0, "error": 1, "processed": 1, "pending": 0},
    )
    monkeypatch.setattr(conversation_service, "get_by_id_or_raise", lambda _cid: {"id": "c1"})

    async def _content(*_a, **_k):
        raise NoMergeableChunksException("No processed data streams (1 chunk(s) failed): x.mp3")

    monkeypatch.setattr(conversation_api, "get_conversation_content", _content)
    monkeypatch.setattr(tasks, "run_async_in_new_loop", lambda factory: asyncio.run(factory()))

    # Must return, not raise: a raise here is what makes Dramatiq retry.
    assert tasks.task_merge_conversation_chunks.fn("c1") is None
    # The processing timeline must not claim a merge completed.
    assert outcomes == ["failed"]
