from __future__ import annotations

from typing import Any
from contextlib import nullcontext

import dembrane.tasks as tasks
import dembrane.transcribe as transcribe


def test_task_transcribe_chunk_webhook_mode_returns_early(monkeypatch) -> None:
    stored: dict[str, Any] = {}
    called: dict[str, Any] = {"transcribe": False, "decrement": False}

    monkeypatch.setattr(tasks, "ProcessingStatusContext", lambda **_kwargs: nullcontext())
    monkeypatch.setattr(transcribe, "TRANSCRIPTION_PROVIDER", "Dembrane-25-09")
    monkeypatch.setattr(transcribe, "ASSEMBLYAI_WEBHOOK_URL", "https://api.example.com/hook")
    monkeypatch.setattr(transcribe, "ASSEMBLYAI_WEBHOOK_SECRET", "secret")
    monkeypatch.setattr(
        transcribe,
        "_fetch_chunk",
        lambda _chunk_id: {"conversation_id": "conv-1", "path": "uploads/chunk.mp3"},
    )
    monkeypatch.setattr(
        transcribe,
        "_fetch_conversation",
        lambda _conversation_id: {
            "project_id": {
                "language": "en",
                "default_conversation_transcript_prompt": "Dembrane",
            }
        },
    )
    monkeypatch.setattr(transcribe, "_build_hotwords", lambda _conversation: ["Dembrane"])
    monkeypatch.setattr(
        transcribe,
        "transcribe_audio_assemblyai",
        lambda *_args, **_kwargs: (None, {"transcript_id": "tx-100"}),
    )

    import dembrane.s3 as s3
    import dembrane.coordination as coordination

    monkeypatch.setattr(
        s3,
        "get_signed_url",
        lambda _path, expires_in_seconds: f"https://signed/{expires_in_seconds}",
    )
    monkeypatch.setattr(
        coordination,
        "store_assemblyai_webhook_metadata",
        lambda **kwargs: stored.update(kwargs),
    )

    def _unexpected_transcribe(*_args, **_kwargs) -> None:
        called["transcribe"] = True
        raise AssertionError("polling transcription path should not run in webhook mode")

    def _unexpected_decrement(*_args, **_kwargs) -> None:
        called["decrement"] = True
        raise AssertionError("decrement should not run before webhook completion")

    monkeypatch.setattr(tasks, "transcribe_conversation_chunk", _unexpected_transcribe)
    monkeypatch.setattr(tasks, "_on_chunk_transcription_done", _unexpected_decrement)

    tasks.task_transcribe_chunk.fn(
        conversation_chunk_id="chunk-1",
        conversation_id="conv-1",
        use_pii_redaction=True,
        anonymize_transcripts=True,
    )

    assert called["transcribe"] is False
    assert called["decrement"] is False
    assert stored["transcript_id"] == "tx-100"
    assert stored["chunk_id"] == "chunk-1"
    assert stored["conversation_id"] == "conv-1"
    assert stored["anonymize_transcripts"] is True


def test_task_correct_transcript_standard_mode(monkeypatch) -> None:
    saved: dict[str, Any] = {}
    decremented: dict[str, Any] = {}

    monkeypatch.setattr(tasks, "ProcessingStatusContext", lambda **_kwargs: nullcontext())
    monkeypatch.setattr(
        transcribe,
        "_transcript_correction_workflow",
        lambda **_kwargs: ("corrected text", "note"),
    )
    monkeypatch.setattr(
        transcribe,
        "_save_transcript",
        lambda chunk_id, transcript, diarization=None: saved.update(
            {"chunk_id": chunk_id, "transcript": transcript, "diarization": diarization}
        ),
    )
    monkeypatch.setattr(
        tasks,
        "_on_chunk_transcription_done",
        lambda conversation_id, chunk_id, _logger: decremented.update(
            {"conversation_id": conversation_id, "chunk_id": chunk_id}
        ),
    )

    tasks.task_correct_transcript.fn(
        chunk_id="chunk-2",
        conversation_id="conv-2",
        audio_file_uri="https://signed/audio.mp3",
        candidate_transcript="candidate",
        hotwords=["Dembrane"],
        use_pii_redaction=False,
        custom_guidance_prompt="guide",
        assemblyai_response={"words": []},
        anonymize_transcripts=False,
    )

    assert saved["chunk_id"] == "chunk-2"
    assert saved["transcript"] == "corrected text"
    assert saved["diarization"]["schema"] == "Dembrane-25-09"
    assert saved["diarization"]["data"]["raw"] == {"words": []}
    assert decremented == {"conversation_id": "conv-2", "chunk_id": "chunk-2"}


def test_task_correct_transcript_anonymized_mode(monkeypatch) -> None:
    saved: dict[str, Any] = {}
    observed: dict[str, Any] = {}
    decremented: dict[str, Any] = {}

    monkeypatch.setattr(tasks, "ProcessingStatusContext", lambda **_kwargs: nullcontext())
    import dembrane.pii_regex as pii_regex

    monkeypatch.setattr(pii_regex, "regex_redact_pii", lambda text: f"redacted:{text}")

    def _fake_workflow(**kwargs):
        observed["candidate_transcript"] = kwargs["candidate_transcript"]
        observed["use_pii_redaction"] = kwargs["use_pii_redaction"]
        return ("clean transcript", "note")

    monkeypatch.setattr(transcribe, "_transcript_correction_workflow", _fake_workflow)
    monkeypatch.setattr(
        transcribe,
        "_save_transcript",
        lambda chunk_id, transcript, diarization=None: saved.update(
            {"chunk_id": chunk_id, "transcript": transcript, "diarization": diarization}
        ),
    )
    monkeypatch.setattr(
        tasks,
        "_on_chunk_transcription_done",
        lambda conversation_id, chunk_id, _logger: decremented.update(
            {"conversation_id": conversation_id, "chunk_id": chunk_id}
        ),
    )

    tasks.task_correct_transcript.fn(
        chunk_id="chunk-3",
        conversation_id="conv-3",
        audio_file_uri="https://signed/audio.mp3",
        candidate_transcript="my raw transcript",
        hotwords=[],
        use_pii_redaction=False,
        custom_guidance_prompt=None,
        assemblyai_response={"words": [{"text": "secret"}]},
        anonymize_transcripts=True,
    )

    assert observed["candidate_transcript"] == "redacted:my raw transcript"
    assert observed["use_pii_redaction"] is True
    assert saved["diarization"]["schema"] == "Dembrane-26-01-redaction"
    assert saved["diarization"]["data"]["raw"] == {}
    assert decremented == {"conversation_id": "conv-3", "chunk_id": "chunk-3"}


def test_task_correct_transcript_fallback_and_error_save(monkeypatch) -> None:
    state: dict[str, Any] = {"save_calls": 0}
    decremented: dict[str, Any] = {}

    monkeypatch.setattr(tasks, "ProcessingStatusContext", lambda **_kwargs: nullcontext())
    monkeypatch.setattr(
        transcribe,
        "_transcript_correction_workflow",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("workflow failed")),
    )

    def _failing_save(*_args, **_kwargs) -> None:
        state["save_calls"] += 1
        raise RuntimeError("save failed")

    monkeypatch.setattr(transcribe, "_save_transcript", _failing_save)
    monkeypatch.setattr(
        transcribe,
        "_save_chunk_error",
        lambda chunk_id, error_message: state.update(
            {"chunk_id": chunk_id, "error_message": error_message}
        ),
    )
    monkeypatch.setattr(
        tasks,
        "_on_chunk_transcription_done",
        lambda conversation_id, chunk_id, _logger: decremented.update(
            {"conversation_id": conversation_id, "chunk_id": chunk_id}
        ),
    )

    tasks.task_correct_transcript.fn(
        chunk_id="chunk-4",
        conversation_id="conv-4",
        audio_file_uri="https://signed/audio.mp3",
        candidate_transcript="candidate",
        hotwords=None,
        use_pii_redaction=False,
        custom_guidance_prompt=None,
        assemblyai_response={},
        anonymize_transcripts=False,
    )

    assert state["save_calls"] == 1
    assert state["chunk_id"] == "chunk-4"
    assert "Failed to save fallback transcript" in state["error_message"]
    assert decremented == {"conversation_id": "conv-4", "chunk_id": "chunk-4"}
