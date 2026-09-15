"""task_process_conversation_chunk: only errors that prove the bytes are bad
are terminal. They write chunk.error and stop, so a corrupt upload costs one
ffmpeg run, not max_retries + 1. Everything else, including a generic
FFmpegError from a killed process, propagates so dramatiq retries it with the
default backoff over the full retry budget."""

from __future__ import annotations

from contextlib import nullcontext

import pytest

import dembrane.tasks as tasks
from dembrane import audio_utils
from dembrane.service import conversation_service


def _patch(monkeypatch, updates):
    monkeypatch.setattr(tasks, "ProcessingStatusContext", lambda **_kw: nullcontext())
    monkeypatch.setattr(
        conversation_service,
        "get_chunk_by_id_or_raise",
        lambda cid: {"id": cid, "conversation_id": "conv-1"},
    )
    monkeypatch.setattr(
        conversation_service, "get_by_id_or_raise", lambda cid: {"id": cid, "is_anonymized": False}
    )
    monkeypatch.setattr(
        conversation_service, "update_chunk", lambda cid, **kw: updates.append((cid, kw))
    )


@pytest.mark.parametrize(
    "exc",
    [
        audio_utils.FileTooSmallError("5 bytes"),
        audio_utils.InvalidAudioError("Invalid or corrupted input file"),
        audio_utils.FileTooLargeError("too big"),
    ],
)
def test_unreadable_audio_marks_chunk_and_does_not_retry(monkeypatch, exc):
    updates: list = []
    _patch(monkeypatch, updates)

    def _split(*_a, **_k):
        raise exc

    monkeypatch.setattr(audio_utils, "split_audio_chunk", _split)

    assert tasks.task_process_conversation_chunk("chunk-1") is None
    assert updates == [("chunk-1", {"error": "Audio not playable"})]


@pytest.mark.parametrize(
    "exc",
    [
        ConnectionError("s3 timeout"),
        # ffmpeg killed under memory pressure is a generic FFmpegError, not bad bytes.
        audio_utils.FFmpegError("FFmpeg processing failed: Killed"),
        ValueError("unexpected directus payload"),
    ],
)
def test_other_errors_propagate_for_retry(monkeypatch, exc):
    updates: list = []
    _patch(monkeypatch, updates)

    def _split(*_a, **_k):
        raise exc

    monkeypatch.setattr(audio_utils, "split_audio_chunk", _split)

    with pytest.raises(type(exc)):
        tasks.task_process_conversation_chunk("chunk-1")
    assert updates == []


def test_failed_error_mark_propagates_so_the_retry_can_persist_it(monkeypatch):
    _patch(monkeypatch, [])

    def _split(*_a, **_k):
        raise audio_utils.InvalidAudioError("bad bytes")

    def _update(*_a, **_k):
        raise ConnectionError("directus down")

    monkeypatch.setattr(audio_utils, "split_audio_chunk", _split)
    monkeypatch.setattr(conversation_service, "update_chunk", _update)

    with pytest.raises(ConnectionError):
        tasks.task_process_conversation_chunk("chunk-1")


def test_chunk_actors_preserve_default_backoff():
    """Keep the original recovery window for temporary infrastructure outages."""
    for actor in (tasks.task_process_conversation_chunk, tasks.task_merge_conversation_chunks):
        assert "min_backoff" not in actor.options
        assert "max_backoff" not in actor.options
