from __future__ import annotations

from typing import Any

import pytest

from dembrane.canvas import history


class _FakeDirectus:
    async def get_items(self, collection: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        query = params["query"]
        if collection == "agent_loop":
            assert query["filter"] == {"report_id": {"_eq": "canvas-1"}}
            return [
                {
                    "id": "loop-1",
                    "report_id": "canvas-1",
                    "created_from_chat_id": "chat-run",
                    "canvas_host_items": [
                        {
                            "text": "Keep the doorway open.",
                            "target_tab": "story",
                            "chat_id": "chat-1",
                            "message_id": "msg-1",
                            "added_at": "2026-07-09T12:05:00Z",
                        }
                    ],
                }
            ]
        if collection == "canvas_generation":
            return [
                {
                    "id": "gen-1",
                    "report_id": "canvas-1",
                    "status": "ok",
                    "tick_kind": "scheduled",
                    "detail": "added one quote",
                    "created_at": "2026-07-09T12:10:00Z",
                }
            ]
        if collection == "agent_loop_run":
            assert query["filter"] == {"loop_id": {"_eq": "loop-1"}}
            return [
                {
                    "id": "run-2",
                    "loop_id": "loop-1",
                    "status": "no_op",
                    "detail": "nothing fresh",
                    "generation_id": None,
                    "started_at": "2026-07-09T12:15:00Z",
                },
                {
                    "id": "run-1",
                    "loop_id": "loop-1",
                    "status": "ok",
                    "detail": "added one quote",
                    "generation_id": "gen-1",
                    "started_at": "2026-07-09T12:10:00Z",
                },
            ]
        if collection == "canvas_config_revision":
            return []
        raise AssertionError(f"unexpected collection {collection}")


@pytest.mark.asyncio
async def test_build_canvas_history_includes_no_op_and_host_causes(monkeypatch) -> None:
    monkeypatch.setattr(history, "async_directus", _FakeDirectus())

    entries = await history.build_canvas_history("canvas-1", limit=10)

    assert entries[0]["kind"] == "no change"
    assert entries[0]["changes"] == ["no change — nothing new heard"]
    assert entries[0]["cause"]["run_chat_id"] == "chat-run"
    assert entries[1]["kind"] == "run"
    assert entries[1]["version"] == 1
    assert entries[2]["kind"] == "host item added"
    assert entries[2]["cause"]["chat_id"] == "chat-1"
