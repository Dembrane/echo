from __future__ import annotations

from types import SimpleNamespace
from typing import Any, AsyncIterator
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

import dembrane.tasks as tasks
import dembrane.transcribe as transcribe
import dembrane.api.webhooks as webhooks_api
import dembrane.coordination as coordination


@asynccontextmanager
async def _build_client() -> AsyncIterator[AsyncClient]:
    app = FastAPI()
    app.include_router(webhooks_api.WebhooksRouter, prefix="/api")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


def _set_secret(monkeypatch: pytest.MonkeyPatch, secret: str) -> None:
    monkeypatch.setattr(
        webhooks_api,
        "get_settings",
        lambda: SimpleNamespace(
            transcription=SimpleNamespace(assemblyai_webhook_secret=secret),
        ),
    )


@pytest.mark.asyncio
async def test_assemblyai_webhook_auth_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_secret(monkeypatch, "expected-secret")

    async with _build_client() as client:
        response = await client.post(
            "/api/webhooks/assemblyai",
            headers={"X-AssemblyAI-Webhook-Secret": "wrong-secret"},
            json={"transcript_id": "tx-1", "status": "completed"},
        )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_assemblyai_webhook_completed_standard(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_secret(monkeypatch, "expected-secret")
    state: dict[str, Any] = {}

    monkeypatch.setattr(
        coordination,
        "get_assemblyai_webhook_metadata",
        lambda _transcript_id: {
            "chunk_id": "chunk-1",
            "conversation_id": "conv-1",
            "audio_file_uri": "https://signed/audio.mp3",
            "hotwords": ["Dembrane"],
            "use_pii_redaction": False,
            "custom_guidance_prompt": "guide",
            "anonymize_transcripts": False,
        },
    )
    monkeypatch.setattr(coordination, "mark_assemblyai_webhook_processing", lambda _id: True)
    monkeypatch.setattr(
        coordination,
        "delete_assemblyai_webhook_metadata",
        lambda _id: state.update({"deleted": True}),
    )
    monkeypatch.setattr(
        coordination,
        "clear_assemblyai_webhook_processing",
        lambda _id: state.update({"cleared": True}),
    )
    monkeypatch.setattr(
        transcribe,
        "fetch_assemblyai_result",
        lambda _id: ("hello world", {"status": "completed", "text": "hello world"}),
    )
    monkeypatch.setattr(
        transcribe,
        "_save_transcript",
        lambda chunk_id, transcript, diarization=None: state.update(
            {"partial_chunk_id": chunk_id, "partial_transcript": transcript, "partial": diarization}
        ),
    )
    monkeypatch.setattr(
        tasks.task_correct_transcript,
        "send",
        lambda **kwargs: state.update({"task_payload": kwargs}),
    )

    async with _build_client() as client:
        response = await client.post(
            "/api/webhooks/assemblyai",
            headers={"X-AssemblyAI-Webhook-Secret": "expected-secret"},
            json={"transcript_id": "tx-1", "status": "completed"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert state["partial_chunk_id"] == "chunk-1"
    assert state["partial"]["schema"] == "Dembrane-25-09-assemblyai-partial"
    assert state["task_payload"]["anonymize_transcripts"] is False
    assert state["deleted"] is True
    assert state["cleared"] is True


@pytest.mark.asyncio
async def test_assemblyai_webhook_completed_anonymized_skips_partial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_secret(monkeypatch, "expected-secret")
    state: dict[str, Any] = {"partial_calls": 0}

    monkeypatch.setattr(
        coordination,
        "get_assemblyai_webhook_metadata",
        lambda _transcript_id: {
            "chunk_id": "chunk-2",
            "conversation_id": "conv-2",
            "audio_file_uri": "https://signed/audio.mp3",
            "hotwords": [],
            "use_pii_redaction": True,
            "custom_guidance_prompt": None,
            "anonymize_transcripts": True,
        },
    )
    monkeypatch.setattr(coordination, "mark_assemblyai_webhook_processing", lambda _id: True)
    monkeypatch.setattr(coordination, "delete_assemblyai_webhook_metadata", lambda _id: None)
    monkeypatch.setattr(
        coordination,
        "clear_assemblyai_webhook_processing",
        lambda _id: state.update({"cleared": True}),
    )
    monkeypatch.setattr(
        transcribe,
        "fetch_assemblyai_result",
        lambda _id: ("hello world", {"status": "completed", "text": "hello world"}),
    )
    monkeypatch.setattr(
        transcribe,
        "_save_transcript",
        lambda *_args, **_kwargs: state.update({"partial_calls": state["partial_calls"] + 1}),
    )
    monkeypatch.setattr(
        tasks.task_correct_transcript,
        "send",
        lambda **kwargs: state.update({"task_payload": kwargs}),
    )

    async with _build_client() as client:
        response = await client.post(
            "/api/webhooks/assemblyai",
            headers={"X-AssemblyAI-Webhook-Secret": "expected-secret"},
            json={"transcript_id": "tx-2", "status": "completed"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert state["partial_calls"] == 0
    assert state["task_payload"]["anonymize_transcripts"] is True
    assert state["cleared"] is True


@pytest.mark.asyncio
async def test_assemblyai_webhook_error_status(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_secret(monkeypatch, "expected-secret")
    state: dict[str, Any] = {}

    monkeypatch.setattr(
        coordination,
        "get_assemblyai_webhook_metadata",
        lambda _transcript_id: {"chunk_id": "chunk-3", "conversation_id": "conv-3"},
    )
    monkeypatch.setattr(coordination, "mark_assemblyai_webhook_processing", lambda _id: True)
    monkeypatch.setattr(
        coordination,
        "delete_assemblyai_webhook_metadata",
        lambda _id: state.update({"deleted": True}),
    )
    monkeypatch.setattr(
        coordination,
        "clear_assemblyai_webhook_processing",
        lambda _id: state.update({"cleared": True}),
    )
    monkeypatch.setattr(
        transcribe,
        "_save_chunk_error",
        lambda chunk_id, message: state.update({"chunk_id": chunk_id, "message": message}),
    )
    monkeypatch.setattr(
        tasks,
        "_on_chunk_transcription_done",
        lambda conversation_id, chunk_id, _logger: state.update(
            {"conversation_id": conversation_id, "done_chunk_id": chunk_id}
        ),
    )

    async with _build_client() as client:
        response = await client.post(
            "/api/webhooks/assemblyai",
            headers={"X-AssemblyAI-Webhook-Secret": "expected-secret"},
            json={"transcript_id": "tx-3", "status": "error"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "error_handled"
    assert state["chunk_id"] == "chunk-3"
    assert state["conversation_id"] == "conv-3"
    assert state["deleted"] is True
    assert state["cleared"] is True


@pytest.mark.asyncio
async def test_assemblyai_webhook_missing_metadata_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_secret(monkeypatch, "expected-secret")
    state: dict[str, Any] = {"marked": 0}

    monkeypatch.setattr(coordination, "get_assemblyai_webhook_metadata", lambda _id: None)
    monkeypatch.setattr(
        coordination,
        "mark_assemblyai_webhook_processing",
        lambda _id: state.update({"marked": state["marked"] + 1}),
    )

    async with _build_client() as client:
        response = await client.post(
            "/api/webhooks/assemblyai",
            headers={"X-AssemblyAI-Webhook-Secret": "expected-secret"},
            json={"transcript_id": "tx-4", "status": "completed"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "ignored"
    assert state["marked"] == 0


@pytest.mark.asyncio
async def test_assemblyai_webhook_duplicate_inflight_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_secret(monkeypatch, "expected-secret")
    state: dict[str, Any] = {"cleared": 0}

    monkeypatch.setattr(
        coordination,
        "get_assemblyai_webhook_metadata",
        lambda _id: {"chunk_id": "chunk-5", "conversation_id": "conv-5"},
    )
    monkeypatch.setattr(coordination, "mark_assemblyai_webhook_processing", lambda _id: False)
    monkeypatch.setattr(
        coordination,
        "clear_assemblyai_webhook_processing",
        lambda _id: state.update({"cleared": state["cleared"] + 1}),
    )

    async with _build_client() as client:
        response = await client.post(
            "/api/webhooks/assemblyai",
            headers={"X-AssemblyAI-Webhook-Secret": "expected-secret"},
            json={"transcript_id": "tx-5", "status": "completed"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "ignored"
    assert state["cleared"] == 0
