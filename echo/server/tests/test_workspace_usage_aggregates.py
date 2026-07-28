"""_get_workspace_usage must use DB-side aggregates, not limit:-1 row scans."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.v2 import workspaces as ws_mod


def _fake_get_items(project_rows):
    """Dispatch by collection + query shape; record every call."""
    calls = []

    async def _impl(collection, payload):
        query = payload.get("query", {})
        calls.append((collection, query))
        if collection == "project":
            return project_rows
        assert collection == "conversation"
        # Every conversation query must be an aggregate, never a row fetch.
        assert "aggregate" in query, f"row-scan query issued: {query}"
        filt = query.get("filter", {})
        monthly = "created_at" in filt
        if "sum" in query["aggregate"]:
            return [{"sum": {"duration": 1800 if monthly else 7200}}]
        return [{"count": {"id": 2 if monthly else 5}}]

    return _impl, calls


@pytest.mark.asyncio
async def test_usage_via_aggregates():
    impl, calls = _fake_get_items([{"id": "p1"}, {"id": "p2"}])
    with patch.object(ws_mod.async_directus, "get_items", new=AsyncMock(side_effect=impl)):
        usage = await ws_mod._compute_workspace_usage("ws-1")

    assert usage.audio_hours == 2.0
    assert usage.conversation_count == 5
    assert usage.audio_hours_this_month == 0.5
    assert usage.conversations_this_month == 2
    conv_queries = [q for c, q in calls if c == "conversation"]
    assert len(conv_queries) == 4
    assert all("aggregate" in q for q in conv_queries)


@pytest.mark.asyncio
async def test_usage_no_projects_short_circuits():
    impl, calls = _fake_get_items([])
    with patch.object(ws_mod.async_directus, "get_items", new=AsyncMock(side_effect=impl)):
        usage = await ws_mod._compute_workspace_usage("ws-1")
    assert usage.audio_hours == 0.0
    assert usage.conversation_count == 0
    assert [c for c, _ in calls] == ["project"]


@pytest.mark.asyncio
async def test_usage_tolerates_null_and_string_aggregates():
    async def _impl(collection, payload):
        if collection == "project":
            return [{"id": "p1"}]
        query = payload["query"]
        if "sum" in query["aggregate"]:
            return [{"sum": {"duration": None}}]
        return [{"count": {"id": "3"}}]

    with patch.object(ws_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl)):
        usage = await ws_mod._compute_workspace_usage("ws-1")
    assert usage.audio_hours == 0.0
    assert usage.conversation_count == 3


@pytest.mark.asyncio
async def test_usage_cache_hit_skips_directus():
    cached = {
        "audio_hours": 3.5,
        "conversation_count": 7,
        "audio_hours_this_month": 1.0,
        "conversations_this_month": 2,
    }
    directus_mock = AsyncMock()
    with (
        patch.object(ws_mod, "cache_get_json", new=AsyncMock(return_value=cached)),
        patch.object(ws_mod.async_directus, "get_items", new=directus_mock),
    ):
        usage = await ws_mod._get_workspace_usage("ws-1")
    assert usage.audio_hours == 3.5
    assert usage.conversation_count == 7
    directus_mock.assert_not_called()


@pytest.mark.asyncio
async def test_usage_cache_miss_computes_and_stores():
    impl, _calls = _fake_get_items([{"id": "p1"}])
    set_mock = AsyncMock()
    with (
        patch.object(ws_mod, "cache_get_json", new=AsyncMock(return_value=None)),
        patch.object(ws_mod, "cache_set_json", new=set_mock),
        patch.object(ws_mod.async_directus, "get_items", new=AsyncMock(side_effect=impl)),
    ):
        usage = await ws_mod._get_workspace_usage("ws-1")
    assert usage.audio_hours == 2.0
    set_mock.assert_awaited_once()
    key, payload, ttl = set_mock.await_args.args
    assert key == "usage_summary:ws-1"
    assert payload["conversation_count"] == 5
    assert ttl == ws_mod.USAGE_SUMMARY_TTL_SECONDS


@pytest.mark.asyncio
async def test_usage_projects_error_returns_none():
    async def _impl(collection, payload):
        assert collection == "project"
        return {"error": "boom"}

    with patch.object(ws_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl)):
        usage = await ws_mod._compute_workspace_usage("ws-1")
    assert usage is None


@pytest.mark.asyncio
async def test_usage_partial_aggregate_error_returns_none():
    async def _impl(collection, payload):
        if collection == "project":
            return [{"id": "p1"}]
        query = payload["query"]
        filt = query.get("filter", {})
        monthly = "created_at" in filt
        if "sum" in query["aggregate"] and not monthly:
            return {"error": "boom"}
        if "sum" in query["aggregate"]:
            return [{"sum": {"duration": 1800}}]
        return [{"count": {"id": 2}}]

    with patch.object(ws_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl)):
        usage = await ws_mod._compute_workspace_usage("ws-1")
    assert usage is None


@pytest.mark.asyncio
async def test_get_workspace_usage_skips_cache_on_compute_error():
    set_mock = AsyncMock()
    with (
        patch.object(ws_mod, "cache_get_json", new=AsyncMock(return_value=None)),
        patch.object(ws_mod, "cache_set_json", new=set_mock),
        patch.object(ws_mod, "_compute_workspace_usage", new=AsyncMock(return_value=None)),
    ):
        usage = await ws_mod._get_workspace_usage("ws-1")
    assert usage.audio_hours == 0.0
    assert usage.conversation_count == 0
    assert usage.audio_hours_this_month == 0.0
    assert usage.conversations_this_month == 0
    set_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_invalidate_workspace_usage_busts_summary_key():
    from dembrane import cache_utils

    deleted = []
    async def _del(key):
        deleted.append(key)

    with patch.object(cache_utils, "cache_delete", new=_del):
        await cache_utils.invalidate_workspace_usage("ws-1")
    assert set(deleted) == {"usage:ws-1", "usage_summary:ws-1"}
