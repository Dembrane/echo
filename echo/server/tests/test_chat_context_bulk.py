"""Bulk token counts and the select-all rewrite."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api import chat as chat_mod, conversation as conv_mod


@pytest.mark.asyncio
async def test_bulk_reads_redis_then_column_then_computes():
    async def _cache_get(key):
        return 11 if key == "tokcount:c1" else None

    rows = [{"id": "c2", "token_count": 22}, {"id": "c3", "token_count": None}]
    with (
        patch.object(conv_mod, "cache_get_json", new=AsyncMock(side_effect=_cache_get)),
        patch.object(conv_mod, "cache_set_json", new=AsyncMock()),
        patch.object(conv_mod.async_directus, "get_items", new=AsyncMock(return_value=rows)),
        patch.object(
            conv_mod, "get_conversation_token_count", new=AsyncMock(return_value=33)
        ) as compute_mock,
    ):
        out = await conv_mod.get_conversation_token_counts_bulk(["c1", "c2", "c3"], object())
    assert out == {"c1": 11, "c2": 22, "c3": 33}
    compute_mock.assert_awaited_once()
    assert compute_mock.await_args.args[0] == "c3"


@pytest.mark.asyncio
async def test_bulk_omits_ids_whose_compute_raises():
    rows = [{"id": "c1", "token_count": 5}]
    with (
        patch.object(conv_mod, "cache_get_json", new=AsyncMock(return_value=None)),
        patch.object(conv_mod, "cache_set_json", new=AsyncMock()),
        patch.object(conv_mod.async_directus, "get_items", new=AsyncMock(return_value=rows)),
        patch.object(
            conv_mod,
            "get_conversation_token_count",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ),
    ):
        out = await conv_mod.get_conversation_token_counts_bulk(["c1", "c2"], object())
    assert out == {"c1": 5}


@pytest.mark.asyncio
async def test_get_chat_context_uses_bulk_not_per_conversation():
    chat = {
        "chat_mode": None,
        "used_conversations": [
            {"conversation_id": {"id": "c1", "participant_name": "A"}},
            {"conversation_id": {"id": "c2", "participant_name": "B"}},
        ],
    }
    with (
        patch.object(
            chat_mod,
            "raise_if_chat_not_found_or_not_authorized",
            new=AsyncMock(return_value=chat),
        ),
        patch.object(chat_mod, "run_in_thread_pool", new=AsyncMock(return_value=[])),
        patch.object(
            chat_mod,
            "get_conversation_token_counts_bulk",
            new=AsyncMock(return_value={"c1": 100, "c2": 200}),
        ) as bulk_mock,
    ):
        ctx = await chat_mod.get_chat_context("chat-1", object())
    bulk_mock.assert_awaited_once()
    assert bulk_mock.await_args.args[0] == ["c1", "c2"]
    assert [c.conversation_id for c in ctx.conversations] == ["c1", "c2"]
    assert ctx.conversations[0].token_usage == 100 / chat_mod.MAX_CHAT_CONTEXT_LENGTH


def test_list_by_project_with_filters_has_no_chunk_embed():
    import inspect

    from dembrane.service import conversation as svc_mod

    src = inspect.getsource(svc_mod.ConversationService.list_by_project_with_filters)
    assert "chunks.transcript" not in src
    assert '"deep"' not in src and "'deep'" not in src
