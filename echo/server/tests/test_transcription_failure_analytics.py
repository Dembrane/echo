from unittest.mock import patch

from dembrane.transcribe import _report_transcription_failure


def test_reports_recoverable_transcription_failure_with_conversation_id():
    with patch("dembrane.transcribe.capture_event_sync") as capture:
        _report_transcription_failure(
            "chunk-1", ValueError("Audio duration is too short"), "conv-1"
        )
    capture.assert_called_once_with(
        "conv-1",
        "server_chunk_transcription_failed",
        {
            "chunk_id": "chunk-1",
            "conversation_id": "conv-1",
            "recoverable": True,
            "error_reason": "audio duration is too short",
        },
    )


def test_reports_non_recoverable_transcription_failure_with_conversation_id():
    with patch("dembrane.transcribe.capture_event_sync") as capture:
        _report_transcription_failure("chunk-2", RuntimeError("connection reset"), "conv-2")
    capture.assert_called_once_with(
        "conv-2",
        "server_chunk_transcription_failed",
        {
            "chunk_id": "chunk-2",
            "conversation_id": "conv-2",
            "recoverable": False,
            "error_reason": "other",
        },
    )


def test_reports_transcription_failure_falls_back_to_chunk_id_when_no_conversation_id():
    with patch("dembrane.transcribe.capture_event_sync") as capture:
        _report_transcription_failure("chunk-3", RuntimeError("connection reset"))
    capture.assert_called_once_with(
        "chunk-3",
        "server_chunk_transcription_failed",
        {
            "chunk_id": "chunk-3",
            "conversation_id": None,
            "recoverable": False,
            "error_reason": "other",
        },
    )
