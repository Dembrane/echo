"""assistant.message events carry the persisted project_chat_message id."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from dembrane import agentic_worker as aw

pytestmark = pytest.mark.asyncio

MSG_ID = "7f1c2f4e-0b2a-4c1d-9e3f-1234567890ab"


async def _run(create_message):
    svc = MagicMock()
    published: list[tuple[str, dict]] = []

    async def _append(svc_, run_id, event_type, payload):
        published.append((event_type, payload))

    async def _pool(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    with patch.object(aw, "_append_event_and_publish", new=_append), \
         patch.object(aw, "run_in_thread_pool", new=_pool), \
         patch.object(aw.chat_service, "create_message", new=create_message):
        await aw._append_assistant_message(
            svc=svc, run_id="run-1", content="Hello there", project_chat_id="chat-1", message_id=MSG_ID,
        )
    return published, create_message


async def test_event_carries_persisted_id_and_row_uses_message_id():
    create_message = MagicMock(return_value={"id": MSG_ID})
    published, cm = await _run(create_message)
    assert cm.call_args.kwargs["message_id"] == MSG_ID
    assert published == [("assistant.message", {"content": "Hello there", "message_id": MSG_ID, "persisted_message_id": MSG_ID})]


async def test_event_is_published_before_the_row_is_written():
    order: list[str] = []
    def _persist(*_args, **_kwargs):
        order.append("persist")
        return {"id": MSG_ID}

    create_message = MagicMock(side_effect=_persist)
    svc = MagicMock()

    async def _append(svc_, run_id, event_type, payload):
        order.append("publish")

    async def _pool(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    with patch.object(aw, "_append_event_and_publish", new=_append), \
         patch.object(aw, "run_in_thread_pool", new=_pool), \
         patch.object(aw.chat_service, "create_message", new=create_message):
        await aw._append_assistant_message(svc=svc, run_id="run-1", content="Hi", project_chat_id="chat-1", message_id=MSG_ID)
    assert order == ["publish", "persist"]


async def test_event_still_published_when_persist_fails():
    create_message = MagicMock(side_effect=RuntimeError("db down"))
    published, cm = await _run(create_message)
    assert published[0][0] == "assistant.message"
    assert published[0][1]["persisted_message_id"] == MSG_ID
    assert cm.call_count == 1


async def test_non_uuid_message_id_is_not_used_as_row_id():
    create_message = MagicMock(return_value={"id": "generated-uuid"})
    svc = MagicMock()
    async def _append(*a, **k): pass
    async def _pool(fn, *args, **kwargs): return fn(*args, **kwargs)
    published: list = []
    async def _capture(svc_, run_id, event_type, payload): published.append(payload)
    with patch.object(aw, "_append_event_and_publish", new=_capture), \
         patch.object(aw, "run_in_thread_pool", new=_pool), \
         patch.object(aw.chat_service, "create_message", new=create_message):
        await aw._append_assistant_message(svc=svc, run_id="run-1", content="Hi", project_chat_id="chat-1", message_id="not-a-uuid")
    assert create_message.call_args.kwargs.get("message_id") is None
    assert "persisted_message_id" not in published[0]
