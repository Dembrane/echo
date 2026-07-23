"""Conversation token counts: Redis-cached, tokenizer off the event loop."""

from __future__ import annotations

from unittest.mock import Mock, AsyncMock, patch

import pytest

from dembrane.api import conversation as conv_mod
from dembrane.api.dependency_auth import DirectusSession


def _auth() -> DirectusSession:
    return DirectusSession(user_id="u1", is_admin=True)


@pytest.mark.asyncio
async def test_cache_hit_skips_transcript_and_tokenizer():
    transcript_mock = AsyncMock()
    with (
        patch.object(conv_mod, "raise_if_conversation_not_found_or_not_authorized", new=AsyncMock()),
        patch.object(conv_mod, "cache_get_json", new=AsyncMock(return_value=42)),
        patch.object(conv_mod, "get_conversation_transcript", new=transcript_mock),
    ):
        assert await conv_mod.get_conversation_token_count("c1", _auth()) == 42
    transcript_mock.assert_not_called()


@pytest.mark.asyncio
async def test_cache_miss_counts_in_thread_pool_and_stores():
    counter = Mock(return_value=7)
    pool_calls = []

    async def _pool(func, *args, **kwargs):
        pool_calls.append(func)
        return func(*args, **kwargs)

    set_mock = AsyncMock()
    with (
        patch.object(conv_mod, "raise_if_conversation_not_found_or_not_authorized", new=AsyncMock()),
        patch.object(conv_mod, "cache_get_json", new=AsyncMock(return_value=None)),
        patch.object(conv_mod, "cache_set_json", new=set_mock),
        patch.object(conv_mod, "get_conversation_transcript", new=AsyncMock(return_value="hello")),
        patch.object(conv_mod, "token_counter", new=counter),
        patch.object(conv_mod, "run_in_thread_pool", new=_pool),
    ):
        assert await conv_mod.get_conversation_token_count("c1", _auth()) == 7

    assert counter in pool_calls, "token_counter must run via run_in_thread_pool"
    set_mock.assert_awaited_once()
    key, value, ttl = set_mock.await_args.args
    assert key == "tokcount:c1"
    assert value == 7
    assert ttl == conv_mod.TOKEN_COUNT_TTL_SECONDS
