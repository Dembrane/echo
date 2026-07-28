from __future__ import annotations

from typing import Any

import pytest

import dembrane.canvas.gather as gather


class _FakeDirectus:
    async def get_item(self, collection: str, item_id: str) -> dict[str, Any]:  # noqa: ARG002
        return {
            "id": item_id,
            "name": "Panel day",
            "workspace_id": "workspace-1",
            "context": "Testing context",
            "language": "en",
            "anonymize_transcripts": True,
        }

    async def get_items(self, collection: str, params: dict) -> list[dict[str, Any]]:
        if collection == "conversation":
            return [{"id": "c1", "participant_name": "Alex", "created_at": "2026-07-07T10:00:00Z"}]
        assert collection == "conversation_chunk"
        return [
            {
                "id": "ch1",
                "transcript": "a" * 20,
                "created_at": "2026-07-07T10:01:00Z",
                "timestamp": "2026-07-07T10:01:00Z",
            }
        ]


class _Settings:
    max_transcript_chars_per_conversation = 10
    max_total_transcript_chars = 10


class _EmptyDirectus:
    async def get_item(self, collection: str, item_id: str) -> dict[str, Any]:  # noqa: ARG002
        return {
            "id": item_id,
            "name": "Panel day",
            "workspace_id": "workspace-1",
            "context": "Testing context",
            "language": "en",
            "anonymize_transcripts": False,
        }

    async def get_items(self, collection: str, params: dict) -> list[dict[str, Any]]:  # noqa: ARG002
        return []


class _CaptureChunkFilterDirectus(_FakeDirectus):
    def __init__(self) -> None:
        self.chunk_filters: list[dict[str, Any]] = []

    async def get_items(self, collection: str, params: dict) -> list[dict[str, Any]]:
        if collection == "conversation_chunk":
            self.chunk_filters.append(params["query"]["filter"])
        return await super().get_items(collection, params)


@pytest.mark.asyncio
async def test_gather_verifies_reader_and_caps_transcript(monkeypatch) -> None:
    calls: list[dict[str, str]] = []

    async def _resolve(**kwargs):
        calls.append(kwargs)

    async def _goal(project_id: str) -> str:
        assert project_id == "p1"
        return "Surface practical concerns."

    monkeypatch.setattr(gather, "resolve_canvas_reader_context", _resolve)
    monkeypatch.setattr(gather, "get_current_project_goal_content", _goal)
    monkeypatch.setattr(gather, "async_directus", _FakeDirectus())
    monkeypatch.setattr(gather.get_settings(), "canvas", _Settings())

    bundle = await gather.execute_gather_spec(
        project_id="p1",
        acting_directus_user_id="du1",
        gather_spec={"window_minutes": 30},
    )

    assert calls == [{"acting_directus_user_id": "du1", "project_id": "p1"}]
    assert bundle["project"]["name"] == "Panel day"
    assert bundle["project"]["workspace_id"] == "workspace-1"
    assert bundle["project"]["goal"] == "Surface practical concerns."
    assert bundle["conversations"][0]["latest_transcript"] == "aaaaaaaaaa\n[truncated]"
    assert bundle["counts"]["truncated_conversations"] == 1


@pytest.mark.asyncio
async def test_full_history_gather_removes_chunk_since_filter(monkeypatch) -> None:
    async def _resolve(**kwargs):  # noqa: ARG001
        return None

    async def _goal(project_id: str) -> str:  # noqa: ARG001
        return ""

    fake = _CaptureChunkFilterDirectus()
    monkeypatch.setattr(gather, "resolve_canvas_reader_context", _resolve)
    monkeypatch.setattr(gather, "get_current_project_goal_content", _goal)
    monkeypatch.setattr(gather, "async_directus", fake)
    monkeypatch.setattr(gather.get_settings(), "canvas", _Settings())

    await gather.execute_gather_spec(
        project_id="p1",
        acting_directus_user_id="du1",
        gather_spec={},
    )
    await gather.execute_gather_spec(
        project_id="p1",
        acting_directus_user_id="du1",
        gather_spec={},
        full_history=True,
    )

    assert "created_at" in fake.chunk_filters[0]
    assert "created_at" not in fake.chunk_filters[1]


@pytest.mark.asyncio
async def test_preview_sample_flag_injects_labeled_samples_only_for_preview(monkeypatch) -> None:
    async def _resolve(**kwargs):  # noqa: ARG001
        return None

    async def _goal(project_id: str) -> str:  # noqa: ARG001
        return ""

    monkeypatch.setattr(gather, "resolve_canvas_reader_context", _resolve)
    monkeypatch.setattr(gather, "get_current_project_goal_content", _goal)
    monkeypatch.setattr(gather, "async_directus", _EmptyDirectus())
    monkeypatch.setattr(gather.get_settings(), "canvas", _Settings())

    live_bundle = await gather.execute_gather_spec(
        project_id="p1",
        acting_directus_user_id="du1",
        gather_spec={},
    )
    preview_bundle = await gather.execute_gather_spec(
        project_id="p1",
        acting_directus_user_id="du1",
        gather_spec={},
        preview_sample=True,
    )

    assert live_bundle["sample_mode"] is False
    assert live_bundle["conversations"] == []
    assert preview_bundle["sample_mode"] is True
    assert preview_bundle["counts"]["sample_conversations_used"] == 4
    assert preview_bundle["sample_notice"] == (
        "Sample conversations, your real conversations replace these."
    )
