"""list_conversations derived chunk fields must come from grouped aggregates."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.v2.bff import conversations as bff_mod


class _Access:
    tier = None
    workspace_id = "ws-1"

    def require(self, _policy):
        return None


def _fake_get_items(calls):
    async def _impl(collection, payload):
        query = payload["query"]
        calls.append((collection, query))
        if collection == "conversation":
            return [{"id": "c1"}, {"id": "c2"}, {"id": "c3"}]
        if collection == "conversation_artifact":
            return []
        assert collection == "conversation_chunk"
        assert "aggregate" in query, f"chunk row-scan issued: {query}"
        assert query.get("groupBy") == ["conversation_id"]
        # Directus truncates grouped rows at its default limit without this.
        assert query.get("limit") == -1, f"grouped aggregate missing limit -1: {query}"
        filt = query.get("filter", {})
        agg = query["aggregate"]
        if "max" in agg and "timestamp" in agg["max"]:
            return [{"conversation_id": "c1", "max": {"timestamp": "2026-07-20T10:00:00"}}]
        if "max" in agg and "created_at" in agg["max"]:
            return [
                {"conversation_id": "c1", "max": {"created_at": "2026-07-20T11:00:00"}},
                {"conversation_id": "c2", "max": {"created_at": "2026-07-19T09:00:00"}},
            ]
        if filt.get("transcript") == {"_nempty": True} and "error" not in filt:
            return [{"conversation_id": "c1", "count": {"id": "2"}}]
        if "error" in filt:
            return [{"conversation_id": "c2", "count": {"id": 1}}]
        if "_or" in filt:
            # non-text chunks: only c1 has one
            return [{"conversation_id": "c1", "count": {"id": 1}}]
        # plain per-conversation chunk count
        return [
            {"conversation_id": "c1", "count": {"id": 3}},
            {"conversation_id": "c2", "count": {"id": "2"}},
        ]

    return _impl


# Calling the endpoint function directly leaves FastAPI Query(...) objects
# as defaults, so every defaulted param must be passed explicitly.
_LIST_KWARGS = dict(
    include_chunks=False,
    include_tags=False,
    fields=None,
    sources=None,
    limit=1000,
    offset=0,
    sort="-created_at",
    tag_ids=None,
    verified_only=False,
    search_text=None,
    transcript_required=False,
)


@pytest.mark.asyncio
async def test_derived_fields_via_aggregates():
    calls: list = []
    with (
        patch.object(
            bff_mod, "resolve_project_access", new=AsyncMock(return_value=_Access())
        ),
        patch.object(bff_mod, "workspace_over_cap_active", new=AsyncMock(return_value=False)),
        patch.object(
            bff_mod.async_directus, "get_items", new=AsyncMock(side_effect=_fake_get_items(calls))
        ),
    ):
        convs = await bff_mod.list_conversations(
            auth=object(), project_id="p1", **_LIST_KWARGS
        )

    by_id = {c["id"]: c for c in convs}
    assert by_id["c1"]["has_transcript"] is True
    assert by_id["c2"]["has_transcript"] is False
    assert by_id["c2"]["has_transcription_error"] is True
    # coalesce semantics: c1 newest is the created_at of a timestamp-less row
    assert by_id["c1"]["last_chunk_at"] == "2026-07-20T11:00:00"
    assert by_id["c2"]["last_chunk_at"] == "2026-07-19T09:00:00"
    assert by_id["c3"]["last_chunk_at"] is None
    # c2 has chunks and none are non-text -> text only; c1 has a non-text chunk
    assert by_id["c1"]["has_only_text_chunks"] is False
    assert by_id["c2"]["has_only_text_chunks"] is True
    assert by_id["c3"]["has_only_text_chunks"] is False
    # every chunk query was a grouped aggregate (asserted in the fake)
    assert all(
        "aggregate" in q for c, q in calls if c == "conversation_chunk"
    )


@pytest.mark.asyncio
async def test_transcript_required_uses_aggregate():
    calls: list = []
    with (
        patch.object(
            bff_mod, "resolve_project_access", new=AsyncMock(return_value=_Access())
        ),
        patch.object(bff_mod, "workspace_over_cap_active", new=AsyncMock(return_value=False)),
        patch.object(
            bff_mod.async_directus, "get_items", new=AsyncMock(side_effect=_fake_get_items(calls))
        ),
    ):
        convs = await bff_mod.list_conversations(
            auth=object(),
            project_id="p1",
            **{**_LIST_KWARGS, "transcript_required": True},
        )
    assert [c["id"] for c in convs] == ["c1"]
