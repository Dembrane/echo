from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from datetime import datetime

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException

import dembrane.api.stateless as stateless_api
import dembrane.api.conversation as conversation_api
from dembrane.api.v2.bff import _access as bff_access
from dembrane.transcribe import TranscriptionError
from dembrane.api.stateless import StatelessRouter
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

PROBED_DURATION_SECONDS = 137.25


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


@pytest.fixture(autouse=True)
def probed_duration(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Stand in for ffprobe. Autouse so no test ever shells out or hits the network."""
    probed: list[str] = []

    def _fake(url: str, **_kwargs: Any) -> float:
        probed.append(url)
        return PROBED_DURATION_SECONDS

    monkeypatch.setattr(stateless_api, "get_duration_from_url", _fake)
    return probed


class _FakeDirectus:
    """Captures conversation rows the endpoint writes."""

    def __init__(self, fail: bool = False) -> None:
        self.created: list[tuple[str, dict[str, Any]]] = []
        self.fail = fail

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("directus is down")
        self.created.append((collection, data))
        return {"data": data}


class _FakeRateLimiter:
    """Stands in for the Redis limiter. Autouse below so no test opens a socket."""

    def __init__(self) -> None:
        self.checked: list[str] = []
        self.raises: HTTPException | None = None

    async def check(self, user_id: str) -> None:
        self.checked.append(user_id)
        if self.raises is not None:
            raise self.raises


@pytest.fixture(autouse=True)
def pricing_intake_limiter(monkeypatch: pytest.MonkeyPatch) -> _FakeRateLimiter:
    limiter = _FakeRateLimiter()
    monkeypatch.setattr(stateless_api, "_pricing_intake_rate_limiter", limiter)
    return limiter


@pytest.fixture
def fake_directus(monkeypatch: pytest.MonkeyPatch) -> _FakeDirectus:
    directus = _FakeDirectus()
    monkeypatch.setattr(stateless_api, "async_directus", directus)

    async def _no_cache_bust(conversation_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(
        conversation_api, "_invalidate_usage_cache_for_conversation", _no_cache_bust
    )
    return directus


def _grant_project_access(
    monkeypatch: pytest.MonkeyPatch,
    *,
    allowed_project_ids: set[str],
    denied_policy: str | None = None,
) -> list[str]:
    """Fake the v2 access ladder. Returns the list of policies that were required.

    Ladder semantics, same as agentic: a project the caller isn't on is a 404 (don't
    confirm existence), a policy the caller's role lacks is a 403.
    """
    required: list[str] = []

    async def _resolve(project_id: str, auth: Any) -> Any:  # noqa: ARG001
        if project_id not in allowed_project_ids:
            raise HTTPException(status_code=404, detail="Project not found")

        def _require(policy: str) -> None:
            required.append(policy)
            if denied_policy is not None and policy == denied_policy:
                raise HTTPException(status_code=403, detail="Forbidden")

        return SimpleNamespace(require=_require, role="member", project={})

    monkeypatch.setattr(bff_access, "resolve_project_access", _resolve)
    return required


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


# ── project access + metering ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_host_with_project_access_is_metered(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    captured_transcribe: dict[str, Any],
    probed_duration: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    required = _grant_project_access(monkeypatch, allowed_project_ids={"proj-1"})

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "proj-1"},
        )

    assert response.status_code == 200
    assert response.json()["transcript"] == "hello world"
    # A host, not an admin, and the gate is write access rather than read.
    assert required == ["project:update"]

    # Duration came from the same audio that was transcribed.
    assert probed_duration == [captured_transcribe["audio_file_uri"]]

    assert len(fake_directus.created) == 1
    collection, row = fake_directus.created[0]
    assert collection == "conversation"
    assert row["project_id"] == "proj-1"
    assert row["source"] == stateless_api.STATELESS_CONVERSATION_SOURCE
    assert row["duration"] == PROBED_DURATION_SECONDS
    # Born deleted: counted for billable hours, invisible in every listing.
    assert row["deleted_at"]
    assert datetime.fromisoformat(row["deleted_at"]).tzinfo is not None
    assert row["participant_name"] == stateless_api.STATELESS_PARTICIPANT_NAME
    assert row["is_finished"] is True

    # Still stateless about the audio itself.
    assert fake_s3.deleted == fake_s3.saved


@pytest.mark.asyncio
async def test_host_without_project_access_is_refused(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, monkeypatch: pytest.MonkeyPatch
) -> None:
    _grant_project_access(monkeypatch, allowed_project_ids={"proj-1"})

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "someone-elses-project"},
        )

    # 404 rather than 403: the ladder does not confirm a project's existence to
    # someone who isn't on it (same as agentic._assert_project_access).
    assert response.status_code == 404
    assert fake_s3.saved == []
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_host_lacking_write_policy_is_forbidden(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, monkeypatch: pytest.MonkeyPatch
) -> None:
    _grant_project_access(
        monkeypatch, allowed_project_ids={"proj-1"}, denied_policy="project:update"
    )

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "proj-1"},
        )

    assert response.status_code == 403
    assert fake_s3.saved == []
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_non_admin_without_project_id_is_forbidden(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus
) -> None:
    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
        )

    assert response.status_code == 403
    assert fake_s3.saved == []
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_admin_without_project_id_still_works_and_is_not_metered(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, captured_transcribe: dict[str, Any]
) -> None:
    async with _client(_build_app(is_admin=True)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
        )

    assert response.status_code == 200
    assert response.json() == {"transcript": "hello world", "note": "speak closer"}
    # No project means nothing to bill, which is how the endpoint shipped.
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_admin_with_project_id_is_metered_without_consulting_the_ladder(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    captured_transcribe: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _explode(project_id: str, auth: Any) -> Any:  # noqa: ARG001
        raise AssertionError("staff admins must not need an app_user row")

    monkeypatch.setattr(bff_access, "resolve_project_access", _explode)

    async with _client(_build_app(is_admin=True)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "proj-1"},
        )

    assert response.status_code == 200
    assert len(fake_directus.created) == 1
    assert fake_directus.created[0][1]["project_id"] == "proj-1"


@pytest.mark.asyncio
async def test_metering_failure_does_not_cost_the_caller_their_transcript(
    fake_s3: _FakeS3, captured_transcribe: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    _grant_project_access(monkeypatch, allowed_project_ids={"proj-1"})
    monkeypatch.setattr(stateless_api, "async_directus", _FakeDirectus(fail=True))

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "proj-1"},
        )

    assert response.status_code == 200
    assert response.json() == {"transcript": "hello world", "note": "speak closer"}
    assert fake_s3.deleted == fake_s3.saved


@pytest.mark.asyncio
async def test_unreadable_duration_is_recorded_as_null_never_as_zero(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    captured_transcribe: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _grant_project_access(monkeypatch, allowed_project_ids={"proj-1"})

    def _boom(url: str, **_kwargs: Any) -> float:  # noqa: ARG001
        raise ValueError("ffprobe failed on url")

    monkeypatch.setattr(stateless_api, "get_duration_from_url", _boom)

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "proj-1"},
        )

    assert response.status_code == 200
    assert len(fake_directus.created) == 1
    assert fake_directus.created[0][1]["duration"] is None


@pytest.mark.asyncio
async def test_non_positive_duration_is_treated_as_unknown(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    captured_transcribe: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """merge_multiple_audio_files_and_save_to_s3 uses -1.0 as its probe-failed
    sentinel; a negative or zero duration is a failure here too, not a free minute."""
    _grant_project_access(monkeypatch, allowed_project_ids={"proj-1"})
    monkeypatch.setattr(stateless_api, "get_duration_from_url", lambda _url, **_k: -1.0)

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "proj-1"},
        )

    assert response.status_code == 200
    assert fake_directus.created[0][1]["duration"] is None


@pytest.mark.asyncio
async def test_uri_input_is_metered_too(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    captured_transcribe: dict[str, Any],
    probed_duration: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _grant_project_access(monkeypatch, allowed_project_ids={"proj-1"})

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            data={"project_id": "proj-1", "audio_file_uri": "https://example.com/a.mp3?sig=1"},
        )

    assert response.status_code == 200
    assert probed_duration == ["https://example.com/a.mp3?sig=1"]
    assert fake_directus.created[0][1]["duration"] == PROBED_DURATION_SECONDS
    # A caller-provided URI is still never deleted.
    assert fake_s3.deleted == []


# ── the pricing intake purpose ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_pricing_intake_purpose_passes_without_a_project(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    captured_transcribe: dict[str, Any],
    pricing_intake_limiter: _FakeRateLimiter,
) -> None:
    """A signed in person who is not staff and names no project. There is no
    workspace to bill, so nothing is metered and no conversation row is born."""
    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("answer.webm", b"fake-audio", "audio/webm")},
            data={"purpose": "pricing_intake"},
        )

    assert response.status_code == 200
    assert response.json() == {"transcript": "hello world", "note": "speak closer"}
    assert fake_directus.created == []
    assert pricing_intake_limiter.checked == ["user-1"]
    # Still stateless about the audio itself.
    assert fake_s3.deleted == fake_s3.saved


@pytest.mark.asyncio
async def test_unknown_purpose_is_refused(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    pricing_intake_limiter: _FakeRateLimiter,
) -> None:
    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("answer.webm", b"fake-audio", "audio/webm")},
            data={"purpose": "something_else"},
        )

    assert response.status_code == 422
    assert fake_s3.saved == []
    assert fake_directus.created == []
    assert pricing_intake_limiter.checked == []


@pytest.mark.asyncio
async def test_unknown_purpose_is_refused_even_with_a_project(
    fake_s3: _FakeS3, fake_directus: _FakeDirectus, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The project would have carried the call. The disagreement about purpose
    is still the answer, because a value nobody reads is a caller bug."""
    _grant_project_access(monkeypatch, allowed_project_ids={"proj-1"})

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "proj-1", "purpose": "something_else"},
        )

    assert response.status_code == 422
    assert fake_s3.saved == []
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_project_id_wins_over_purpose(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    captured_transcribe: dict[str, Any],
    pricing_intake_limiter: _FakeRateLimiter,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both together is not a conflict: the named project is billed, the access
    ladder runs, and the intake ceiling is not the one that applies."""
    required = _grant_project_access(monkeypatch, allowed_project_ids={"proj-1"})

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("memo.mp3", b"fake-audio", "audio/mpeg")},
            data={"project_id": "proj-1", "purpose": "pricing_intake"},
        )

    assert response.status_code == 200
    assert required == ["project:update"]
    assert len(fake_directus.created) == 1
    assert fake_directus.created[0][1]["project_id"] == "proj-1"
    assert fake_directus.created[0][1]["duration"] == PROBED_DURATION_SECONDS
    assert pricing_intake_limiter.checked == []


@pytest.mark.asyncio
async def test_pricing_intake_rate_limit_engages(
    fake_s3: _FakeS3,
    fake_directus: _FakeDirectus,
    pricing_intake_limiter: _FakeRateLimiter,
) -> None:
    """Over the ceiling the call stops before the upload is parked, so a loop
    costs nothing but the request itself."""
    pricing_intake_limiter.raises = HTTPException(
        status_code=429, detail="Too many requests. Try again later."
    )

    async with _client(_build_app(is_admin=False)) as client:
        response = await client.post(
            "/stateless/transcribe",
            files={"file": ("answer.webm", b"fake-audio", "audio/webm")},
            data={"purpose": "pricing_intake"},
        )

    assert response.status_code == 429
    assert fake_s3.saved == []
    assert fake_directus.created == []


@pytest.mark.asyncio
async def test_pricing_intake_is_named_by_a_constant_the_client_can_read() -> None:
    """The endpoint accepts one word, and it is the same word the form sends."""
    assert stateless_api.PRICING_INTAKE_PURPOSE == "pricing_intake"
