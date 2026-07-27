"""conversation.token_count: column read short-circuits, compute writes back,
transcript writes clear it."""

from __future__ import annotations

from unittest.mock import Mock, AsyncMock, MagicMock, patch

import pytest

from dembrane.api import conversation as conv_mod
from dembrane.api.dependency_auth import DirectusSession


def _auth() -> DirectusSession:
    return DirectusSession(user_id="u1", is_admin=True)


@pytest.mark.asyncio
async def test_column_hit_skips_compute_and_warms_redis():
    transcript_mock = AsyncMock()
    set_mock = AsyncMock()
    with (
        patch.object(
            conv_mod,
            "raise_if_conversation_not_found_or_not_authorized",
            new=AsyncMock(return_value={"id": "c1", "token_count": 42}),
        ),
        patch.object(conv_mod, "cache_get_json", new=AsyncMock(return_value=None)),
        patch.object(conv_mod, "cache_set_json", new=set_mock),
        patch.object(conv_mod, "get_conversation_transcript", new=transcript_mock),
    ):
        assert await conv_mod.get_conversation_token_count("c1", _auth()) == 42
    transcript_mock.assert_not_called()
    set_mock.assert_awaited_once()  # column hit re-warms the Redis layer


@pytest.mark.asyncio
async def test_compute_writes_column_and_redis():
    update_mock = AsyncMock()
    set_mock = AsyncMock()

    async def _pool(func, *args, **kwargs):
        return func(*args, **kwargs)

    with (
        patch.object(
            conv_mod,
            "raise_if_conversation_not_found_or_not_authorized",
            new=AsyncMock(return_value={"id": "c1", "token_count": None}),
        ),
        patch.object(conv_mod, "cache_get_json", new=AsyncMock(return_value=None)),
        patch.object(conv_mod, "cache_set_json", new=set_mock),
        patch.object(conv_mod, "get_conversation_transcript", new=AsyncMock(return_value="hi")),
        patch.object(conv_mod, "token_counter", new=Mock(return_value=7)),
        patch.object(conv_mod, "run_in_thread_pool", new=_pool),
        patch.object(conv_mod.async_directus, "update_item", new=update_mock),
    ):
        assert await conv_mod.get_conversation_token_count("c1", _auth()) == 7
    update_mock.assert_awaited_once_with("conversation", "c1", {"token_count": 7})
    set_mock.assert_awaited_once()


def test_update_chunk_with_transcript_clears_column():
    from dembrane.service.conversation import ConversationService

    svc = ConversationService.__new__(ConversationService)
    client = MagicMock()
    client.update_item.return_value = {"data": {"id": "ch1", "conversation_id": "c9"}}
    ctx = MagicMock()
    ctx.__enter__.return_value = client
    ctx.__exit__.return_value = False
    with patch.object(ConversationService, "_client_context", return_value=ctx):
        svc.update_chunk("ch1", transcript="new text")
    calls = [c.args for c in client.update_item.call_args_list]
    assert ("conversation", "c9", {"token_count": None}) in calls
