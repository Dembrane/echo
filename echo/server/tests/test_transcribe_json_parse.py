"""
Gemini occasionally returns transcript JSON that json.loads rejects. Two shapes seen
in production: a stray backslash-u inside a long transcript (repairable) and a
response cut off mid-string (must be regenerated). A parse failure in the correction
pass must not re-run the transcription pass.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from litellm.exceptions import BadRequestError

import dembrane.tasks as tasks
import dembrane.transcribe as transcribe
from tests.llm_fakes import FakeCompletion

VALID = json.dumps({"corrected_transcript": "hello world", "note": "ok"})
TRUNCATED = '{\n  "corrected_transcript": "hello wor'
BAD_ESCAPE = '{"corrected_transcript": "pad \\u00e9 fine, then C:\\users bad", "note": "n"}'
# A correctly escaped backslash followed by a stray escape elsewhere.
BAD_ESCAPE_AFTER_ESCAPED_BACKSLASH = (
    '{"corrected_transcript": "C:\\\\users ok, then \\uZZ bad", "note": "n"}'
)


def _stub_common(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(transcribe, "GCP_SA_JSON", {"type": "service_account"})
    monkeypatch.setattr(
        transcribe,
        "_get_audio_file_object",
        lambda _uri: {"type": "file", "file": {"file_data": "x"}},
    )


def test_parse_repairs_invalid_unicode_escape() -> None:
    parsed = transcribe._parse_transcript_response(FakeCompletion(BAD_ESCAPE))
    assert parsed["corrected_transcript"] == "pad \u00e9 fine, then C:\\users bad"
    assert parsed["note"] == "n"


def test_parse_repair_leaves_escaped_backslashes_alone() -> None:
    parsed = transcribe._parse_transcript_response(
        FakeCompletion(BAD_ESCAPE_AFTER_ESCAPED_BACKSLASH)
    )
    assert parsed["corrected_transcript"] == "C:\\users ok, then \\uZZ bad"


def test_parse_raises_on_truncated_output() -> None:
    with pytest.raises(transcribe.TranscriptParseError):
        transcribe._parse_transcript_response(FakeCompletion(TRUNCATED, "length"))


def test_parse_raises_on_missing_keys() -> None:
    with pytest.raises(transcribe.TranscriptParseError):
        transcribe._parse_transcript_response(FakeCompletion(json.dumps({"note": "only"})))


def test_transcription_pass_retries_model_once_on_parse_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_common(monkeypatch)
    responses = [FakeCompletion(TRUNCATED, "stop"), FakeCompletion(VALID)]
    calls: list[Any] = []

    def _fake_router(model: Any, **kwargs: Any) -> FakeCompletion:
        calls.append(model)
        return responses.pop(0)

    monkeypatch.setattr(transcribe, "router_completion", _fake_router)

    transcript, note, _model = transcribe._transcribe_audio_gemini("s3://x", "en", None, False)

    assert transcript == "hello world"
    assert note == "ok"
    assert len(calls) == 2


def test_transcription_pass_gives_up_after_one_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_common(monkeypatch)
    calls: list[Any] = []

    def _fake_router(model: Any, **kwargs: Any) -> FakeCompletion:
        calls.append(model)
        return FakeCompletion(TRUNCATED, "stop")

    monkeypatch.setattr(transcribe, "router_completion", _fake_router)

    with pytest.raises(transcribe.TranscriptParseError):
        transcribe._transcribe_audio_gemini("s3://x", "en", None, False)
    assert len(calls) == 2


def test_correction_parse_error_does_not_rerun_transcription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_common(monkeypatch)
    counts = {"transcribe": 0, "correct": 0}

    def _fake_router(model: Any, **kwargs: Any) -> FakeCompletion:
        user_msg = next(m for m in kwargs["messages"] if m["role"] == "user")
        is_correction = any(part.get("type") == "text" for part in user_msg["content"])
        if not is_correction:
            counts["transcribe"] += 1
            return FakeCompletion(VALID)
        counts["correct"] += 1
        if counts["correct"] == 1:
            return FakeCompletion(TRUNCATED, "stop")
        return FakeCompletion(json.dumps({"corrected_transcript": "redacted", "note": "r"}))

    monkeypatch.setattr(transcribe, "router_completion", _fake_router)

    transcript, meta = transcribe.transcribe_audio_dembrane_26_07(
        "s3://x", language="en", use_pii_redaction=True
    )

    assert transcript == "redacted"
    assert meta["note"] == "r"
    assert counts == {"transcribe": 1, "correct": 2}


def test_transcription_call_declares_fast_fallback_for_this_call_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rate-limited transcription may degrade to the fast group. This is scoped to the
    transcription call, not the shared router, so chat keeps its own policy."""
    _stub_common(monkeypatch)
    captured: dict[str, Any] = {}

    def _fake_router(model: Any, **kwargs: Any) -> FakeCompletion:
        captured.update(kwargs)
        return FakeCompletion(VALID)

    monkeypatch.setattr(transcribe, "router_completion", _fake_router)

    transcribe._transcribe_audio_gemini("s3://x", "en", None, False)

    assert captured["fallbacks"] == [{"multi_modal_pro": ["multi_modal_fast"]}]


def test_fallback_group_names_come_from_the_model_registry(monkeypatch: pytest.MonkeyPatch) -> None:
    """A rename in llms.MODEL_REGISTRY must not silently disable the fallback."""
    monkeypatch.setitem(
        transcribe.MODEL_REGISTRY,
        transcribe.MODELS.MULTI_MODAL_FAST,
        {"settings_attr": "renamed_fast"},
    )
    assert transcribe._transcript_fallbacks() == [{"multi_modal_pro": ["renamed_fast"]}]


def _stub_chunk_pipeline(monkeypatch: pytest.MonkeyPatch, saved: list[str], events: list) -> None:
    monkeypatch.setattr(
        transcribe, "_fetch_chunk", lambda _cid: {"conversation_id": "c1", "path": "p.mp3"}
    )
    monkeypatch.setattr(
        transcribe, "_fetch_conversation", lambda _cid: {"project_id": {"language": "en"}}
    )
    monkeypatch.setattr(transcribe, "_get_transcript_provider", lambda: "Dembrane-26-07")
    monkeypatch.setattr(transcribe, "_build_hotwords", lambda _c: None)
    monkeypatch.setattr(transcribe, "get_signed_url", lambda _p, **_k: "https://u")
    monkeypatch.setattr(transcribe, "_save_chunk_error", lambda _cid, msg: saved.append(msg))
    monkeypatch.setattr(
        transcribe, "capture_event_sync", lambda _id, name, props: events.append((name, props))
    )


def test_vertex_invalid_argument_marks_chunk_failed_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Vertex 400 INVALID_ARGUMENT means the audio itself is bad. Retrying re-sends
    the same bytes, so the chunk is marked failed and the task returns normally."""
    saved: list[str] = []
    events: list = []
    _stub_chunk_pipeline(monkeypatch, saved, events)

    def _raise(*_a: Any, **_k: Any) -> None:
        raise BadRequestError(
            "Vertex_aiException BadRequestError - 400 INVALID_ARGUMENT",
            model="gemini",
            llm_provider="vertex_ai",
        )

    monkeypatch.setattr(transcribe, "transcribe_audio_dembrane_26_07", _raise)

    assert transcribe.transcribe_conversation_chunk("chunk-1") == "chunk-1"
    assert saved and "INVALID_ARGUMENT" in saved[0]
    name, props = events[0]
    assert name == "server_chunk_transcription_failed"
    assert props["recoverable"] is True
    assert props["error_reason"] == "bad_request"


def test_router_bad_request_is_still_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    """LiteLLM's Router raises BadRequestError for its own problems (no healthy
    deployment, unknown model group). Those are config or capacity issues, not bad
    audio, and must keep going through the retry path."""
    saved: list[str] = []
    _stub_chunk_pipeline(monkeypatch, saved, [])

    def _raise(*_a: Any, **_k: Any) -> None:
        raise BadRequestError(
            "No healthy deployment available, passed model=multi_modal_pro",
            model="multi_modal_pro",
            llm_provider=None,
        )

    monkeypatch.setattr(transcribe, "transcribe_audio_dembrane_26_07", _raise)

    with pytest.raises(transcribe.TranscriptionError):
        transcribe.transcribe_conversation_chunk("chunk-1")


def test_transcribe_actor_retries_are_bounded_but_span_a_real_incident() -> None:
    """Default Dramatiq retries (20) re-send the full audio each time. Five attempts
    with 30s to 10min backoff cover roughly fifteen minutes, long enough for a Vertex
    blip, without the cost of the default."""
    options = tasks.task_transcribe_chunk.options
    assert options["max_retries"] == 5
    assert options["min_backoff"] == 30_000
    assert options["max_backoff"] == 600_000


def test_meta_records_which_models_answered(monkeypatch: pytest.MonkeyPatch) -> None:
    """A degraded (fallback) transcription must be identifiable from the stored chunk."""
    _stub_common(monkeypatch)
    models = iter(["vertex_ai/gemini-pro-x", "vertex_ai/gemini-flash-y"])

    def _fake_router(model: Any, **kwargs: Any) -> FakeCompletion:
        return FakeCompletion(VALID, model=next(models))

    monkeypatch.setattr(transcribe, "router_completion", _fake_router)

    _, meta = transcribe.transcribe_audio_dembrane_26_07(
        "s3://x", language="en", use_pii_redaction=True
    )

    assert meta["models"] == ["vertex_ai/gemini-pro-x", "vertex_ai/gemini-flash-y"]


def test_length_truncation_is_terminal_without_a_second_upload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A response cut off by the output limit repeats on the same audio, so neither the
    in-process retry nor a redelivery is worth another upload."""
    _stub_common(monkeypatch)
    calls: list[Any] = []

    def _fake_router(*_a: Any, **_k: Any) -> FakeCompletion:
        calls.append(1)
        return FakeCompletion(TRUNCATED, "length")

    monkeypatch.setattr(transcribe, "router_completion", _fake_router)

    with pytest.raises(transcribe.TranscriptParseError) as excinfo:
        transcribe._transcribe_audio_gemini("s3://x", "en", None, False)

    assert len(calls) == 1
    assert transcribe._is_recoverable_error(excinfo.value) is True
    assert transcribe._failure_reason(excinfo.value) == "truncated_output"


def test_non_length_parse_failure_is_still_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    """Garbled output with a normal stop reason succeeded on redelivery in production."""
    _stub_common(monkeypatch)
    monkeypatch.setattr(
        transcribe, "router_completion", lambda *_a, **_k: FakeCompletion(TRUNCATED, "stop")
    )

    with pytest.raises(transcribe.TranscriptParseError) as excinfo:
        transcribe._transcribe_audio_gemini("s3://x", "en", None, False)

    assert transcribe._is_recoverable_error(excinfo.value) is False
