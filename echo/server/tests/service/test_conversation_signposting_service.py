from __future__ import annotations

from datetime import datetime
from contextlib import nullcontext
from unittest.mock import Mock

import dembrane.tasks as tasks
from dembrane.service.conversation import ConversationService


def test_create_text_chunk_marks_signpost_ready_and_enqueues_refresh(
    monkeypatch,
) -> None:
    sent_conversation_ids: list[str] = []
    fake_client = Mock()

    fake_client.create_item.return_value = {
        "data": {
            "id": "chunk-123",
            "conversation_id": "conv-123",
            "source": "PORTAL_TEXT",
            "timestamp": "2026-03-18T12:00:00Z",
            "transcript": "A participant mentioned safer crossings.",
        }
    }

    project_service = Mock()
    project_service.get_by_id_or_raise.return_value = {
        "id": "proj-123",
        "is_conversation_allowed": True,
        "is_signposting_enabled": True,
    }

    service = ConversationService(project_service=project_service)
    service.get_by_id_or_raise = Mock(  # type: ignore[method-assign]
        return_value={
            "id": "conv-123",
            "project_id": "proj-123",
            "is_finished": False,
            "merged_audio_path": None,
        }
    )
    service.mark_chunk_signpost_ready = Mock()  # type: ignore[method-assign]
    monkeypatch.setattr(service, "_client_context", lambda *_args, **_kwargs: nullcontext(fake_client))
    monkeypatch.setattr(tasks.task_refresh_conversation_signposts, "send", sent_conversation_ids.append)

    chunk = service.create_chunk(
        conversation_id="conv-123",
        timestamp=datetime(2026, 3, 18, 12, 0, 0),
        source="PORTAL_TEXT",
        transcript="A participant mentioned safer crossings.",
    )

    assert chunk["id"] == "chunk-123"
    service.mark_chunk_signpost_ready.assert_called_once_with("chunk-123")
    assert sent_conversation_ids == ["conv-123"]
