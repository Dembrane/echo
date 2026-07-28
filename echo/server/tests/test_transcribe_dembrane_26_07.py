from __future__ import annotations

import json
from typing import Any

import pytest

import dembrane.transcribe as transcribe


class _FakeMessage:
    def __init__(self, content: str) -> None:
        self.content = content


class _FakeChoice:
    def __init__(self, content: str) -> None:
        self.message = _FakeMessage(content)


class _FakeCompletion:
    def __init__(self, content: str) -> None:
        self.choices = [_FakeChoice(content)]


def _stub_common(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(transcribe, "GCP_SA_JSON", {"type": "service_account"})
    monkeypatch.setattr(
        transcribe, "_get_audio_file_object", lambda _uri: {"type": "file", "file": {"file_data": "x"}}
    )


def _router_dispatch(transcribe_json: dict[str, Any], correction_json: dict[str, Any]):
    """Return a router_completion stub that answers the transcription call (audio-only
    user message) with transcribe_json and the correction/redaction call (candidate
    transcript text plus audio) with correction_json."""

    def _fake(model: Any, messages: Any, response_format: Any) -> _FakeCompletion:
        user_msg = next(m for m in messages if m["role"] == "user")
        has_candidate_text = any(part.get("type") == "text" for part in user_msg["content"])
        return _FakeCompletion(
            json.dumps(correction_json if has_candidate_text else transcribe_json)
        )

    return _fake


def test_transcribe_26_07_audio_only_no_candidate(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_common(monkeypatch)
    captured: dict[str, Any] = {}

    def _fake_router(model: Any, messages: Any, response_format: Any) -> _FakeCompletion:
        captured["model"] = model
        captured["messages"] = messages
        return _FakeCompletion(json.dumps({"corrected_transcript": "hello world", "note": "speak closer"}))

    monkeypatch.setattr(transcribe, "router_completion", _fake_router)

    transcript, meta = transcribe.transcribe_audio_dembrane_26_07(
        "https://example.com/a.mp3", language="en", hotwords=["Dembrane"]
    )

    assert transcript == "hello world"
    assert meta["note"] == "speak closer"
    assert meta["error"] is None
    assert captured["model"] == transcribe.MODELS.MULTI_MODAL_PRO
    user_msg = next(m for m in captured["messages"] if m["role"] == "user")
    # audio-only: no text (candidate transcript) part in the user message
    assert all(part.get("type") != "text" for part in user_msg["content"])


def test_transcribe_26_07_no_pii_is_single_call(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_common(monkeypatch)
    calls = {"n": 0}

    def _fake_router(model: Any, messages: Any, response_format: Any) -> _FakeCompletion:
        calls["n"] += 1
        return _FakeCompletion(json.dumps({"corrected_transcript": "hello", "note": ""}))

    monkeypatch.setattr(transcribe, "router_completion", _fake_router)

    transcript, _meta = transcribe.transcribe_audio_dembrane_26_07("https://example.com/a.mp3")
    assert transcript == "hello"
    # no redaction requested -> no dedicated redaction pass
    assert calls["n"] == 1


def test_transcribe_26_07_empty_maps_to_placeholder(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_common(monkeypatch)
    monkeypatch.setattr(
        transcribe,
        "router_completion",
        lambda *_args, **_kwargs: _FakeCompletion(
            json.dumps({"corrected_transcript": "", "note": ""})
        ),
    )

    transcript, _meta = transcribe.transcribe_audio_dembrane_26_07("https://example.com/a.mp3")
    assert transcript == "[Nothing to transcribe]"


def test_transcribe_26_07_pii_runs_correction_pass_over_audio_and_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """use_pii_redaction runs the correction-and-redaction pass on the audio plus the
    transcribed text (mirroring the AssemblyAI-era flow), which redacts names, cards and
    IDs that a single transcribe+redact pass and the regex net miss."""
    _stub_common(monkeypatch)
    correction_msgs: dict[str, Any] = {}

    def _router(model: Any, messages: Any, response_format: Any) -> _FakeCompletion:
        user_msg = next(m for m in messages if m["role"] == "user")
        has_candidate_text = any(part.get("type") == "text" for part in user_msg["content"])
        if has_candidate_text:
            correction_msgs["content"] = user_msg["content"]
            return _FakeCompletion(
                json.dumps(
                    {
                        "corrected_transcript": "my name is <redacted_name> and card is <redacted_card>",
                        "note": "",
                    }
                )
            )
        return _FakeCompletion(
            json.dumps({"corrected_transcript": "my name is Usama and card is 12345", "note": ""})
        )

    monkeypatch.setattr(transcribe, "router_completion", _router)

    transcript, meta = transcribe.transcribe_audio_dembrane_26_07(
        "https://example.com/a.mp3", use_pii_redaction=True
    )

    assert "Usama" not in transcript
    assert "12345" not in transcript
    assert "<redacted_name>" in transcript
    assert "<redacted_card>" in transcript
    assert meta["raw"] == {}
    # the correction pass received both the candidate transcript text and the audio
    types = {part.get("type") for part in correction_msgs["content"]}
    assert types == {"text", "file"}


def test_transcribe_26_07_anonymize_regex_before_correction_and_hides_raw(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_common(monkeypatch)
    monkeypatch.setattr(
        transcribe,
        "router_completion",
        _router_dispatch(
            {"corrected_transcript": "my name is Usama, call me at 0612345678", "note": ""},
            {"corrected_transcript": "my name is <redacted_name>, call me at <redacted_phone>", "note": ""},
        ),
    )
    seen: dict[str, str] = {}
    import dembrane.pii_regex as pii_regex

    def _fake_regex_redact_pii(text: str) -> str:
        seen["input"] = text
        return text.replace("0612345678", "<redacted_phone>")

    monkeypatch.setattr(pii_regex, "regex_redact_pii", _fake_regex_redact_pii)

    transcript, meta = transcribe.transcribe_audio_dembrane_26_07(
        "https://example.com/a.mp3", anonymize_transcripts=True
    )

    # final output is the correction pass result
    assert transcript == "my name is <redacted_name>, call me at <redacted_phone>"
    # regex ran on the raw pass-1 transcript, before the correction pass (old-pipeline order)
    assert seen["input"] == "my name is Usama, call me at 0612345678"
    assert meta["raw"] == {}
