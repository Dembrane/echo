"""_project_audio_hours must use one grouped aggregate, not a row scan."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.v2 import workspace_projects as wp_mod


@pytest.mark.asyncio
async def test_grouped_aggregate_single_query():
    calls = []

    async def _impl(collection, payload):
        calls.append((collection, payload["query"]))
        return [
            {"project_id": "p1", "sum": {"duration": 3600}},
            {"project_id": "p2", "sum": {"duration": 5400}},
            {"project_id": None, "sum": {"duration": 999}},
        ]

    with patch.object(wp_mod.async_directus, "get_items", new=AsyncMock(side_effect=_impl)):
        hours = await wp_mod._project_audio_hours(["p1", "p2", "p3"])

    assert hours == {"p1": 1.0, "p2": 1.5}
    assert len(calls) == 1
    collection, query = calls[0]
    assert collection == "conversation"
    assert query["aggregate"] == {"sum": ["duration"]}
    assert query["groupBy"] == ["project_id"]
    assert query["filter"]["deleted_at"] == {"_null": True}
    assert "fields" not in query


@pytest.mark.asyncio
async def test_empty_input_no_query():
    mock = AsyncMock()
    with patch.object(wp_mod.async_directus, "get_items", new=mock):
        assert await wp_mod._project_audio_hours([]) == {}
    mock.assert_not_called()


@pytest.mark.asyncio
async def test_error_response_returns_empty():
    with patch.object(
        wp_mod.async_directus, "get_items", new=AsyncMock(return_value={"error": "boom"})
    ):
        assert await wp_mod._project_audio_hours(["p1"]) == {}
