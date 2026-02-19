from __future__ import annotations

from typing import Any

import pytest

import dembrane.transcribe as transcribe
from dembrane.transcribe import TranscriptionError


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict[str, Any]:
        return self._payload


def _stub_languages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(transcribe, "get_allowed_languages", lambda: ["en", "nl"])


def test_transcribe_audio_assemblyai_webhook_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_languages(monkeypatch)
    captured: dict[str, Any] = {}

    def _fake_post(url: str, **kwargs: Any) -> _FakeResponse:
        captured["url"] = url
        captured["headers"] = kwargs["headers"]
        captured["json"] = kwargs["json"]
        return _FakeResponse(200, {"id": "tx-1"})

    monkeypatch.setattr(transcribe.requests, "post", _fake_post)
    monkeypatch.setattr(
        transcribe.requests,
        "get",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("polling GET must not run in webhook mode")
        ),
    )

    transcript, payload = transcribe.transcribe_audio_assemblyai(
        audio_file_uri="https://example.com/audio.mp3",
        language="en",
        hotwords=["Dembrane"],
        webhook_url="https://api.example.com/api/webhooks/assemblyai",
        webhook_secret="top-secret",
    )

    assert transcript is None
    assert payload == {"transcript_id": "tx-1"}
    assert captured["url"].endswith("/v2/transcript")
    assert captured["json"]["speech_models"] == ["universal-3-pro", "universal-2"]
    assert "speech_model" not in captured["json"]
    assert "prompt" not in captured["json"]
    assert captured["json"]["keyterms_prompt"] == ["Dembrane"]
    assert captured["json"]["webhook_url"] == "https://api.example.com/api/webhooks/assemblyai"
    assert captured["json"]["webhook_auth_header_name"] == "X-AssemblyAI-Webhook-Secret"
    assert captured["json"]["webhook_auth_header_value"] == "top-secret"


def test_transcribe_audio_assemblyai_polling_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_languages(monkeypatch)
    payloads: dict[str, Any] = {"posts": [], "polls": 0}
    poll_responses = iter(
        [
            {"status": "processing"},
            {"status": "completed", "text": "hello", "words": [{"text": "hello"}]},
        ]
    )

    def _fake_post(_url: str, **kwargs: Any) -> _FakeResponse:
        payloads["posts"].append(kwargs["json"])
        return _FakeResponse(200, {"id": "tx-2"})

    def _fake_get(_url: str, **_kwargs: Any) -> _FakeResponse:
        payloads["polls"] += 1
        return _FakeResponse(200, next(poll_responses))

    monkeypatch.setattr(transcribe.requests, "post", _fake_post)
    monkeypatch.setattr(transcribe.requests, "get", _fake_get)
    monkeypatch.setattr(transcribe.time, "sleep", lambda *_args, **_kwargs: None)

    transcript, response = transcribe.transcribe_audio_assemblyai(
        audio_file_uri="https://example.com/audio.mp3",
        language="en",
        hotwords=["Dembrane"],
    )

    assert transcript == "hello"
    assert response["status"] == "completed"
    assert payloads["polls"] == 2
    post_payload = payloads["posts"][0]
    assert post_payload["speech_models"] == ["universal-3-pro", "universal-2"]
    assert "speech_model" not in post_payload
    assert "webhook_url" not in post_payload


def test_fetch_assemblyai_result_success(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_get(_url: str, **_kwargs: Any) -> _FakeResponse:
        return _FakeResponse(200, {"status": "completed", "text": "done"})

    monkeypatch.setattr(transcribe.requests, "get", _fake_get)

    text, response = transcribe.fetch_assemblyai_result("tx-3")
    assert text == "done"
    assert response["status"] == "completed"


@pytest.mark.parametrize(
    ("status_code", "payload", "message"),
    [
        (500, {"error": "boom"}, "HTTP 500"),
        (200, {"status": "error", "error": "failed"}, "failed"),
        (200, {"status": "processing"}, "not completed"),
    ],
)
def test_fetch_assemblyai_result_errors(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    payload: dict[str, Any],
    message: str,
) -> None:
    def _fake_get(_url: str, **_kwargs: Any) -> _FakeResponse:
        return _FakeResponse(status_code, payload)

    monkeypatch.setattr(transcribe.requests, "get", _fake_get)

    with pytest.raises(TranscriptionError, match=message):
        transcribe.fetch_assemblyai_result("tx-4")
