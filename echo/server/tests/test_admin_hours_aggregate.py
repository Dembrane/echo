"""_workspace_hours_this_cycle must aggregate DB-side, not fetch rows."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.v2 import admin as admin_mod


def _impl_factory(calls, sum_value=9000):
    async def _impl(collection, payload):
        query = payload["query"]
        calls.append((collection, query))
        if collection == "project":
            return [{"id": "p1"}, {"id": "p2"}]
        assert "aggregate" in query, f"row-scan query issued: {query}"
        return [{"sum": {"duration": sum_value}}]

    return _impl


@pytest.mark.asyncio
async def test_cycle_hours_via_aggregate():
    calls = []
    with patch.object(
        admin_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl_factory(calls))
    ):
        hours = await admin_mod._workspace_hours_this_cycle(
            "ws-1", "2026-07-01T00:00:00+00:00", "2026-08-01T00:00:00+00:00"
        )
    assert hours == 2.5
    conv_calls = [q for c, q in calls if c == "conversation"]
    assert len(conv_calls) == 1
    assert conv_calls[0]["aggregate"] == {"sum": ["duration"]}
    assert conv_calls[0]["filter"]["created_at"] == {
        "_gte": "2026-07-01T00:00:00+00:00",
        "_lt": "2026-08-01T00:00:00+00:00",
    }


@pytest.mark.asyncio
async def test_reset_at_floor_still_applies():
    calls = []
    with patch.object(
        admin_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl_factory(calls))
    ):
        await admin_mod._workspace_hours_this_cycle(
            "ws-1",
            "2026-07-01T00:00:00+00:00",
            "2026-08-01T00:00:00+00:00",
            reset_at="2026-07-15T00:00:00+00:00",
        )
    conv_calls = [q for c, q in calls if c == "conversation"]
    assert conv_calls[0]["filter"]["created_at"]["_gte"] == "2026-07-15T00:00:00+00:00"


@pytest.mark.asyncio
async def test_null_sum_returns_zero():
    async def _impl(collection, payload):
        if collection == "project":
            return [{"id": "p1"}]
        return [{"sum": {"duration": None}}]

    with patch.object(admin_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl)):
        hours = await admin_mod._workspace_hours_this_cycle(
            "ws-1", "2026-07-01T00:00:00+00:00", "2026-08-01T00:00:00+00:00"
        )
    assert hours == 0.0
