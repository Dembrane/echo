from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

import dembrane.api.stateless as stateless_api
from dembrane.transcribe import TranscriptionError
from dembrane.api.stateless import StatelessRouter
from dembrane.api.dependency_auth import DirectusSession, require_directus_session


class _FakeS3:
    """Records the S3 traffic the endpoint generates so tests can assert on order."""

    def __init__(self) -> None:
        self.saved: list[str] = []
        self.deleted: list[str] = []
        self.signed: list[str] = []

    def save(self, file_obj: Any, key: str, public: bool, size_limit_mb: int = 100) -> str:
        assert public is False
        self.saved.append(key)
        return f"http://s3.local/bucket/{key}"

    def sign(self, key: str, expires_in_seconds: int = 3600) -> str:
        self.signed.append(key)
        return f"https://signed.example/{key}"

    def delete(self, key: str) -> None:
        self.deleted.append(key)


def _build_app(is_admin: bool = True) -> FastAPI:
    app = FastAPI()
    app.include_router(StatelessRouter, prefix="/stateless")
    session = DirectusSession(user_id="user-1", is_admin=is_admin)
    app.dependency_overrides[require_directus_session] = lambda: session
    return app


def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def fake_s3(monkeypatch: pytest.MonkeyPatch) -> _FakeS3:
    s3 = _FakeS3()
    monkeypatch.setattr(stateless_api, "save_to_s3_from_file_like", s3.save)
    monkeypatch.setattr(stateless_api, "get_signed_url", s3.sign)
    monkeypatch.setattr(stateless_api, "delete_from_s3", s3.delete)
    return s3


@pytest.fixture
def captured_transcribe(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    def _fake(audio_file_uri: str, **kwargs: Any) -> tuple[str, dict[str, Any]]:
        captured["audio_file_uri"] = audio_file_uri
        captured.update(kwargs)
        return "hello world", {"note": "speak closer", "raw": {}, "error": None}

    monkeypatch.setattr(stateless_api, "transcribe_audio_dembrane_26_07", _fake)
    return captured


@pytest.mark.asyncio
async def test_upload_is_transcribed_then_deleted(
    fake_s3: _FakeS3, captured_transcribe: dict[str, Any]
) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("meeting.MP3", b"fake-audio", "audio/mpeg")},
        )

    assert response.status_code == 200
    assert response.json() == {"transcript": "hello world", "note": "speak closer"}

    assert len(fake_s3.saved) == 1
    key = fake_s3.saved[0]
    assert key.startswith("stateless-transcription/")
    assert key.endswith(".mp3")
    # transcription consumed the signed URL of the parked upload, then the upload was dropped
    assert captured_transcribe["audio_file_uri"] == f"https://signed.example/{key}"
    assert fake_s3.deleted == [key]


@pytest.mark.asyncio
async def test_upload_is_deleted_even_when_transcription_fails(
    fake_s3: _FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(audio_file_uri: str, **kwargs: Any) -> tuple[str, dict[str, Any]]:
        raise TranscriptionError("model unavailable")

    monkeypatch.setattr(stateless_api, "transcribe_audio_dembrane_26_07", _boom)

    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.wav", b"fake-audio", "audio/wav")},
        )

    assert response.status_code == 502
    assert fake_s3.deleted == fake_s3.saved


@pytest.mark.asyncio
async def test_all_params_forwarded(fake_s3: _FakeS3, captured_transcribe: dict[str, Any]) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
            data={
                "language": "nl",
                "hotwords": "Dembrane, Sameer , ",
                "use_pii_redaction": "true",
                "anonymize_transcripts": "true",
                "custom_guidance_prompt": "prefer formal spelling",
                "prompt_override": "Transcribe in ALL CAPS.",
            },
        )

    assert response.status_code == 200
    assert captured_transcribe["language"] == "nl"
    assert captured_transcribe["hotwords"] == ["Dembrane", "Sameer"]
    assert captured_transcribe["use_pii_redaction"] is True
    assert captured_transcribe["anonymize_transcripts"] is True
    assert captured_transcribe["custom_guidance_prompt"] == "prefer formal spelling"
    assert captured_transcribe["prompt_override"] == "Transcribe in ALL CAPS."


@pytest.mark.asyncio
async def test_bare_s3_key_is_signed_and_never_deleted(
    fake_s3: _FakeS3, captured_transcribe: dict[str, Any]
) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            data={"audio_file_uri": "chunks/abc/audio.mp3"},
        )

    assert response.status_code == 200
    assert fake_s3.signed == ["chunks/abc/audio.mp3"]
    assert captured_transcribe["audio_file_uri"] == "https://signed.example/chunks/abc/audio.mp3"
    assert fake_s3.saved == []
    assert fake_s3.deleted == []


@pytest.mark.asyncio
async def test_full_url_passes_through_untouched(
    fake_s3: _FakeS3, captured_transcribe: dict[str, Any]
) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            data={"audio_file_uri": "https://example.com/a.mp3?sig=1"},
        )

    assert response.status_code == 200
    assert captured_transcribe["audio_file_uri"] == "https://example.com/a.mp3?sig=1"
    assert fake_s3.signed == []
    assert fake_s3.deleted == []


@pytest.mark.asyncio
async def test_requires_exactly_one_audio_input(fake_s3: _FakeS3) -> None:
    async with _client(_build_app()) as client:
        neither = await client.post("/stateless/transcribe", data={"language": "en"})
        both = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
            data={"audio_file_uri": "chunks/abc/audio.mp3"},
        )

    assert neither.status_code == 400
    assert both.status_code == 400


@pytest.mark.asyncio
async def test_non_admin_is_forbidden(fake_s3: _FakeS3) -> None:
    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
        )

    assert response.status_code == 403
    assert fake_s3.saved == []


@pytest.mark.asyncio
async def test_rejects_empty_and_non_audio_uploads(fake_s3: _FakeS3) -> None:
    async with _client(_build_app()) as client:
        empty = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"", "audio/mpeg")},
        )
        wrong_type = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.txt", b"not audio", "text/plain")},
        )

    assert empty.status_code == 400
    assert wrong_type.status_code == 400
    assert fake_s3.saved == []
