from __future__ import annotations

import os

os.environ.setdefault("DIRECTUS_SECRET", "t")
os.environ.setdefault("DIRECTUS_TOKEN", "t")
os.environ.setdefault("DIRECTUS_BASE_URL", "http://l")
os.environ.setdefault("DATABASE_URL", "postgresql://u:p@l:5432/d")
os.environ.setdefault("REDIS_URL", "redis://l:6379/0")
os.environ.setdefault("STORAGE_S3_BUCKET", "test-bucket")
os.environ.setdefault("STORAGE_S3_ENDPOINT", "http://l:9000")
os.environ.setdefault("STORAGE_S3_KEY", "k")
os.environ.setdefault("STORAGE_S3_SECRET", "s")

from typing import Any  # noqa: E402

import pytest  # noqa: E402
from httpx import AsyncClient, ASGITransport  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402

import dembrane.api.stateless as stateless_api  # noqa: E402
from dembrane.transcribe import TranscriptionError  # noqa: E402
from dembrane.api.stateless import StatelessRouter  # noqa: E402
from dembrane.api.dependency_auth import DirectusSession, require_directus_session  # noqa: E402

PROJECT_ID = "project-1"


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


class _FakeDirectus:
    """Captures conversation inserts."""

    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    def create_item(self, collection: str, item_data: dict[str, Any]) -> dict[str, Any]:
        assert collection == "conversation"
        self.created.append(item_data)
        return {"data": dict(item_data)}


class _FakeAccess:
    def __init__(self) -> None:
        self.workspace_id = "workspace-1"
        self.org_id = "org-1"
        self.tier = "free"
        self.required: list[str] = []

    def require(self, policy: str) -> None:
        self.required.append(policy)


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
def fake_directus(monkeypatch: pytest.MonkeyPatch) -> _FakeDirectus:
    fake = _FakeDirectus()
    monkeypatch.setattr(stateless_api, "directus", fake)
    monkeypatch.setattr(stateless_api, "get_duration_from_s3", lambda _key: 123.5)

    class _FakeAsyncDirectus:
        async def get_item(self, collection: str, item_id: str, params: Any = None) -> dict:
            assert collection == "project"
            return {
                "id": item_id,
                "deleted_at": None,
                "workspace_id": {"id": "workspace-1", "org_id": "org-1"},
            }

    monkeypatch.setattr(stateless_api, "async_directus", _FakeAsyncDirectus())

    async def _noop_invalidate(workspace_id: str, org_id: str | None) -> None:
        return None

    monkeypatch.setattr(stateless_api, "invalidate_workspace_and_org_usage", _noop_invalidate)
    return fake


@pytest.fixture
def fake_access(monkeypatch: pytest.MonkeyPatch) -> _FakeAccess:
    access = _FakeAccess()

    async def _resolve(project_id: str, auth: Any) -> _FakeAccess:
        if project_id != PROJECT_ID:
            raise HTTPException(status_code=404, detail="Project not found")
        return access

    monkeypatch.setattr(stateless_api, "_resolve_project_access", _resolve)

    async def _not_over_cap(workspace_id: str | None, tier: str | None) -> bool:
        return False

    monkeypatch.setattr(stateless_api, "workspace_over_cap_active", _not_over_cap)
    return access


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
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, captured_transcribe: dict[str, Any]
) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("meeting.MP3", b"fake-audio", "audio/mpeg")},
            data={"project_id": PROJECT_ID},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["transcript"] == "hello world"
    assert body["note"] == "speak closer"
    assert body["conversation_id"]

    assert len(fake_s3.saved) == 1
    key = fake_s3.saved[0]
    assert key.startswith("stateless-transcription/")
    assert key.endswith(".mp3")
    # transcription consumed the signed URL of the parked upload, then the upload was dropped
    assert captured_transcribe["audio_file_uri"] == f"https://signed.example/{key}"
    assert fake_s3.deleted == [key]


@pytest.mark.asyncio
async def test_usage_conversation_is_created_soft_deleted(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, captured_transcribe: dict[str, Any]
) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": PROJECT_ID},
        )

    assert response.status_code == 200
    assert len(fake_directus.created) == 1
    row = fake_directus.created[0]
    assert row["project_id"] == PROJECT_ID
    assert row["source"] == "STATELESS"
    assert row["duration"] == 123.5
    assert row["is_finished"] is True
    assert row["deleted_at"]  # born soft-deleted: hidden from listings, counted in usage
    assert response.json()["conversation_id"] == row["id"]


@pytest.mark.asyncio
async def test_registered_user_with_project_access_can_transcribe(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    fake_access: _FakeAccess,
    captured_transcribe: dict[str, Any],
) -> None:
    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": PROJECT_ID},
        )

    assert response.status_code == 200
    assert fake_access.required == ["chat:use"]
    assert len(fake_directus.created) == 1


@pytest.mark.asyncio
async def test_registered_user_without_project_access_gets_404(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, fake_access: _FakeAccess
) -> None:
    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "someone-elses-project"},
        )

    assert response.status_code == 404
    assert fake_s3.saved == []
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_free_workspace_over_cap_gets_402(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    fake_access: _FakeAccess,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _over_cap(workspace_id: str | None, tier: str | None) -> bool:
        return True

    monkeypatch.setattr(stateless_api, "workspace_over_cap_active", _over_cap)

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": PROJECT_ID},
        )

    assert response.status_code == 402
    assert fake_s3.saved == []
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_audio_file_uri_is_admin_only(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, fake_access: _FakeAccess
) -> None:
    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            data={"project_id": PROJECT_ID, "audio_file_uri": "chunks/abc/audio.mp3"},
        )

    assert response.status_code == 403
    assert fake_s3.signed == []
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_no_usage_record_when_transcription_fails(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(audio_file_uri: str, **kwargs: Any) -> tuple[str, dict[str, Any]]:
        raise TranscriptionError("model unavailable")

    monkeypatch.setattr(stateless_api, "transcribe_audio_dembrane_26_07", _boom)

    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.wav", b"fake-audio", "audio/wav")},
            data={"project_id": PROJECT_ID},
        )

    assert response.status_code == 502
    assert fake_s3.deleted == fake_s3.saved
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_all_params_forwarded(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, captured_transcribe: dict[str, Any]
) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
            data={
                "project_id": PROJECT_ID,
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
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, captured_transcribe: dict[str, Any]
) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            data={"project_id": PROJECT_ID, "audio_file_uri": "chunks/abc/audio.mp3"},
        )

    assert response.status_code == 200
    assert fake_s3.signed == ["chunks/abc/audio.mp3"]
    assert captured_transcribe["audio_file_uri"] == "https://signed.example/chunks/abc/audio.mp3"
    assert fake_s3.saved == []
    assert fake_s3.deleted == []


@pytest.mark.asyncio
async def test_full_url_passes_through_and_bills_zero_duration(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, captured_transcribe: dict[str, Any]
) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            data={"project_id": PROJECT_ID, "audio_file_uri": "https://example.com/a.mp3?sig=1"},
        )

    assert response.status_code == 200
    assert captured_transcribe["audio_file_uri"] == "https://example.com/a.mp3?sig=1"
    assert fake_s3.signed == []
    assert fake_s3.deleted == []
    # external URLs can't be probed; the usage record still exists with no duration
    assert fake_directus.created[0]["duration"] is None


@pytest.mark.asyncio
async def test_requires_exactly_one_audio_input(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus
) -> None:
    async with _client(_build_app()) as client:
        neither = await client.post("/stateless/transcribe", data={"project_id": PROJECT_ID})
        both = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": PROJECT_ID, "audio_file_uri": "chunks/abc/audio.mp3"},
        )

    assert neither.status_code == 400
    assert both.status_code == 400


@pytest.mark.asyncio
async def test_project_id_is_required(fake_s3: _FakeS3, fake_directus: _FakeDirectus) -> None:
    async with _client(_build_app()) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"fake-audio", "audio/mpeg")},
        )

    assert response.status_code == 422
    assert fake_s3.saved == []


@pytest.mark.asyncio
async def test_rejects_empty_and_non_audio_uploads(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus
) -> None:
    async with _client(_build_app()) as client:
        empty = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.mp3", b"", "audio/mpeg")},
            data={"project_id": PROJECT_ID},
        )
        wrong_type = await client.post(
            "/stateless/transcribe",
            files={"file": ("a.txt", b"not audio", "text/plain")},
            data={"project_id": PROJECT_ID},
        )

    assert empty.status_code == 400
    assert wrong_type.status_code == 400
    assert fake_s3.saved == []
