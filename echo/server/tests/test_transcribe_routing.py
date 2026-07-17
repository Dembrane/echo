from __future__ import annotations

from typing import Any

import pytest

import dembrane.transcribe as transcribe


def _stub_chunk(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    saved: dict[str, Any] = {}
    monkeypatch.setattr(transcribe, "TRANSCRIPTION_PROVIDER", "Dembrane-26-07")
    monkeypatch.setattr(
        transcribe, "_fetch_chunk", lambda _cid: {"path": "s3://a.mp3", "conversation_id": "conv-1"}
    )
    monkeypatch.setattr(
        transcribe,
        "_fetch_conversation",
        lambda _cid: {"project_id": {"language": "en", "default_conversation_transcript_prompt": None}},
    )
    monkeypatch.setattr(transcribe, "get_signed_url", lambda *_a, **_k: "https://signed/a.mp3")
    monkeypatch.setattr(
        transcribe,
        "_save_transcript",
        lambda cid, t, diarization=None: saved.update({"cid": cid, "t": t, "d": diarization}),
    )
    return saved


def test_routes_to_26_07_and_saves_with_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    saved = _stub_chunk(monkeypatch)
    monkeypatch.setattr(
        transcribe,
        "transcribe_audio_dembrane_26_07",
        lambda *_a, **_k: ("hello world", {"note": "", "raw": {}, "error": None}),
    )

    result = transcribe.transcribe_conversation_chunk("chunk-1")

    assert result == "chunk-1"
    assert saved["t"] == "hello world"
    assert saved["d"]["schema"] == "Dembrane-26-07-gemini"


def test_26_07_anonymize_flag_forwarded(monkeypatch: pytest.MonkeyPatch) -> None:
    saved = _stub_chunk(monkeypatch)
    captured: dict[str, Any] = {}

    def _fake_transcribe(*_a: Any, **kwargs: Any) -> tuple[str, dict[str, Any]]:
        captured.update(kwargs)
        return "redacted", {"note": "", "raw": {}, "error": None}

    monkeypatch.setattr(transcribe, "transcribe_audio_dembrane_26_07", _fake_transcribe)

    transcribe.transcribe_conversation_chunk("chunk-1", anonymize_transcripts=True)

    assert captured["anonymize_transcripts"] is True
    assert saved["t"] == "redacted"
