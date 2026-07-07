from __future__ import annotations

from typing import Any

import pytest

import dembrane.canvas.gather as gather


class _FakeDirectus:
    async def get_item(self, collection: str, item_id: str) -> dict[str, Any]:  # noqa: ARG002
        return {
            "id": item_id,
            "name": "Panel day",
            "context": "Testing context",
            "language": "en",
            "anonymize_transcripts": True,
        }

    async def get_items(self, collection: str, params: dict) -> list[dict[str, Any]]:
        if collection == "conversation":
            return [
                {"id": "c1", "participant_name": "Alex", "created_at": "2026-07-07T10:00:00Z"}
            ]
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


@pytest.mark.asyncio
async def test_gather_verifies_reader_and_caps_transcript(monkeypatch) -> None:
    calls: list[dict[str, str]] = []

    async def _resolve(**kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(gather, "resolve_canvas_reader_context", _resolve)
    monkeypatch.setattr(gather, "async_directus", _FakeDirectus())
    monkeypatch.setattr(gather.get_settings(), "canvas", _Settings())

    bundle = await gather.execute_gather_spec(
        project_id="p1",
        acting_directus_user_id="du1",
        gather_spec={"window_minutes": 30},
    )

    assert calls == [{"acting_directus_user_id": "du1", "project_id": "p1"}]
    assert bundle["project"]["name"] == "Panel day"
    assert bundle["conversations"][0]["latest_transcript"] == "aaaaaaaaaa\n[truncated]"
    assert bundle["counts"]["truncated_conversations"] == 1
