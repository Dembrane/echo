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
        out = await conv_mod.get_conversation_token_counts_bulk(
            ["c1", "c2", "c3"], object(), project_id="p1"
        )
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
        out = await conv_mod.get_conversation_token_counts_bulk(
            ["c1", "c2"], object(), project_id="p1"
        )
    assert out == {"c1": 5}


@pytest.mark.asyncio
async def test_bulk_column_read_is_scoped_to_project_and_not_deleted():
    """The column shortcut must filter by project_id + deleted_at null so a
    caller can only bulk-read counts for its own project's conversations."""
    get_items = AsyncMock(return_value=[])
    with (
        patch.object(conv_mod, "cache_get_json", new=AsyncMock(return_value=None)),
        patch.object(conv_mod, "cache_set_json", new=AsyncMock()),
        patch.object(conv_mod.async_directus, "get_items", new=get_items),
        patch.object(conv_mod, "get_conversation_token_count", new=AsyncMock(return_value=0)),
    ):
        await conv_mod.get_conversation_token_counts_bulk(["c1"], object(), project_id="p1")
    filt = get_items.await_args.args[1]["query"]["filter"]
    assert filt["project_id"] == {"_eq": "p1"}
    assert filt["deleted_at"] == {"_null": True}


@pytest.mark.asyncio
async def test_bulk_out_of_scope_id_falls_through_to_authorized_path():
    """An id the scoped column read doesn't return is routed to the per-id
    endpoint (which re-checks access), never served from the column."""
    # Column read returns nothing (foreign / deleted id filtered out by scope).
    compute = AsyncMock(return_value=99)
    with (
        patch.object(conv_mod, "cache_get_json", new=AsyncMock(return_value=None)),
        patch.object(conv_mod, "cache_set_json", new=AsyncMock()),
        patch.object(conv_mod.async_directus, "get_items", new=AsyncMock(return_value=[])),
        patch.object(conv_mod, "get_conversation_token_count", new=compute),
    ):
        out = await conv_mod.get_conversation_token_counts_bulk(
            ["foreign"], object(), project_id="p1"
        )
    assert out == {"foreign": 99}
    compute.assert_awaited_once()
    assert compute.await_args.args[0] == "foreign"


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


def test_used_conversations_deep_query_is_unbounded():
    """Directus caps nested rows at 100; a truncated used_conversations makes
    add-context / select-all miscount already-attached rows as newly added and
    create duplicate junction rows. Both deep loaders must pass _limit -1."""
    import inspect

    from dembrane.service import chat as chat_svc

    src = inspect.getsource(chat_svc)
    # every 'used_conversations' deep spec that sets _sort must also set _limit -1
    import re

    specs = re.findall(r'"used_conversations":\s*\{[^}]*\}', src)
    specs += re.findall(r'deep\["used_conversations"\]\s*=\s*\{[^}]*\}', src)
    assert specs, "expected at least one used_conversations deep spec"
    for s in specs:
        assert '"_limit": -1' in s, f"used_conversations deep spec missing _limit -1: {s}"
