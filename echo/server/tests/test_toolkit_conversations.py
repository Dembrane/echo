"""The shared conversation read primitives: snippet building, grouping,
pagination and the locked scrub, against a mocked async_directus."""

from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.toolkit import conversations as toolkit
from dembrane.api.dependency_auth import DirectusSession

_SESSION = DirectusSession(user_id="directus-user-1", is_admin=False)


class FakeDirectus:
    """Answers get_items from canned rows, honouring only offset and limit, and
    keeps every query so the shape sent to Directus can be asserted."""

    def __init__(self, rows: dict[str, list[dict[str, Any]]], *, count: int = 0) -> None:
        self.rows = rows
        self.count = count
        self.queries: list[tuple[str, dict[str, Any]]] = []

    async def get_items(self, collection: str, params: dict[str, Any]) -> Any:
        query = params["query"]
        self.queries.append((collection, query))
        if "aggregate" in query:
            return [{"count": {"id": str(self.count)}}]
        rows = [deepcopy(r) for r in self.rows.get(collection, [])]
        offset = int(query.get("offset") or 0)
        limit = query.get("limit")
        return rows[offset : offset + limit] if isinstance(limit, int) and limit > 0 else rows


def _access(tier: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        require=lambda _policy: None,
        project_id="p1",
        workspace_id="ws-1",
        tier=tier,
        org_id="org-1",
    )


def _chunk(conv_id: str, n: int, text: str, *, over_cap: bool = False) -> dict[str, Any]:
    return {
        "id": f"{conv_id}-chunk-{n}",
        "timestamp": f"2026-09-01T10:{n:02d}:00Z",
        "created_at": f"2026-09-01T10:{n:02d}:01Z",
        "transcript": text,
        "conversation_id": {
            "id": conv_id,
            "project_id": "p1",
            "participant_name": f"Table {conv_id}",
            "summary": f"Summary {conv_id}",
            "is_finished": True,
            "is_all_chunks_transcribed": True,
            "is_over_cap": over_cap,
            "created_at": "2026-09-01T09:00:00Z",
            "updated_at": "2026-09-01T11:00:00Z",
        },
    }


def _patched(fake: FakeDirectus, *, access: Any = None, conv: dict[str, Any] | None = None) -> Any:
    return (
        patch("dembrane.toolkit.conversations.async_directus", fake),
        patch(
            "dembrane.api.v2.bff._access.resolve_project_access",
            new=AsyncMock(return_value=access or _access()),
        ),
        patch(
            "dembrane.api.v2.bff._access.resolve_conversation_access",
            new=AsyncMock(return_value=(access or _access(), conv or {"id": "c1"})),
        ),
        patch(
            "dembrane.toolkit.conversations.workspace_over_cap_active",
            new=AsyncMock(return_value=False),
        ),
    )


# ── pure helpers ───────────────────────────────────────────────────────────


def test_normalize_query_tokens_drops_short_and_repeated_words_and_caps_at_four() -> None:
    assert toolkit.normalize_query_tokens("The fee for the Building, fee!") == ["building"]
    assert toolkit.normalize_query_tokens("alpha beta gamma delta epsilon") == [
        "alpha",
        "beta",
        "gamma",
        "delta",
    ]
    assert toolkit.normalize_query_tokens("a an the") == []


def test_build_snippet_centres_on_the_first_token_found_with_ellipses() -> None:
    text = "x" * 100 + " membership " + "y" * 100
    snippet = toolkit.build_snippet(text, ["missing", "membership"])
    assert snippet.startswith("...") and snippet.endswith("...")
    assert "membership" in snippet
    # 80 characters either side of the match, plus the match itself.
    assert len(snippet) == 3 + 80 + len(" membership ") - 2 + 80 + 3


def test_build_snippet_falls_back_to_the_head_of_the_text() -> None:
    text = "z" * 400
    assert toolkit.build_snippet(text, ["nothing"]) == "z" * 160


# ── search ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_groups_chunks_into_hits_with_at_most_three_snippets() -> None:
    rows = [_chunk("A", n, f"we talked about membership {n}") for n in range(5)]
    rows.append(_chunk("B", 0, "the building needs a new roof, membership aside"))
    fake = FakeDirectus({"conversation_chunk": rows})
    patches = _patched(fake)
    with patches[0], patches[1], patches[3]:
        result = await toolkit.search_transcripts(
            "p1", "membership fee", limit=10, offset=0, session=_SESSION
        )

    assert result.tokens == ["membership"]
    assert [h.id for h in result.conversations] == ["A", "B"]
    a, b = result.conversations
    assert [m.chunk_id for m in a.matches] == ["A-chunk-0", "A-chunk-1", "A-chunk-2"]
    assert a.matches[0].timestamp == "2026-09-01T10:00:00Z"
    assert "membership" in a.matches[0].snippet
    assert a.status == "done" and a.summary == "Summary A" and a.locked is False
    assert len(b.matches) == 1
    assert result.has_more is False

    collection, query = fake.queries[0]
    assert collection == "conversation_chunk"
    clauses = query["filter"]["_and"]
    assert {"conversation_id": {"project_id": {"_eq": "p1"}}} in clauses
    assert {"conversation_id": {"deleted_at": {"_null": True}}} in clauses
    assert {
        "_or": [
            {"transcript": {"_icontains": "membership"}},
            {"raw_transcript": {"_icontains": "membership"}},
        ]
    } in clauses
    assert query["limit"] == 250 and query["sort"] == ["-timestamp", "-created_at"]


@pytest.mark.asyncio
async def test_search_pages_with_exact_has_more_and_bounds_the_chunk_scan() -> None:
    rows = [_chunk(cid, 0, "money money money") for cid in ("A", "B", "C", "D")]
    fake = FakeDirectus({"conversation_chunk": rows})
    patches = _patched(fake)
    with patches[0], patches[1], patches[3]:
        first = await toolkit.search_transcripts("p1", "money", limit=2, offset=0, session=_SESSION)
        second = await toolkit.search_transcripts(
            "p1", "money", limit=2, offset=2, session=_SESSION
        )
        third = await toolkit.search_transcripts("p1", "money", limit=2, offset=4, session=_SESSION)

    assert [h.id for h in first.conversations] == ["A", "B"] and first.has_more is True
    assert [h.id for h in second.conversations] == ["C", "D"] and second.has_more is False
    assert second.offset == 2
    assert third.conversations == [] and third.has_more is False
    # 25 matching chunks per wanted conversation, never under 25 nor over 1000.
    assert [q["limit"] for _c, q in fake.queries] == [50, 100, 150]


@pytest.mark.asyncio
async def test_search_never_leaks_a_locked_conversations_text() -> None:
    rows = [
        _chunk("locked", 0, "the secret membership plan", over_cap=True),
        _chunk("open", 0, "membership is open to all"),
    ]
    fake = FakeDirectus({"conversation_chunk": rows})
    patches = _patched(fake, access=_access(tier="free"))
    with patches[0], patches[1], patches[3]:
        result = await toolkit.search_transcripts(
            "p1", "membership", limit=10, offset=0, session=_SESSION
        )

    locked, open_ = result.conversations
    assert locked.id == "locked" and locked.locked is True
    assert locked.matches == [] and locked.summary is None
    assert open_.locked is False and len(open_.matches) == 1


@pytest.mark.asyncio
async def test_search_with_no_usable_word_reads_nothing() -> None:
    fake = FakeDirectus({"conversation_chunk": [_chunk("A", 0, "anything")]})
    patches = _patched(fake)
    with patches[0], patches[1], patches[3]:
        result = await toolkit.search_transcripts(
            "p1", "a to be", limit=5, offset=0, session=_SESSION
        )
    assert result.tokens == [] and result.conversations == [] and fake.queries == []


@pytest.mark.asyncio
async def test_search_narrows_to_one_conversation_when_asked() -> None:
    fake = FakeDirectus({"conversation_chunk": []})
    patches = _patched(fake)
    with patches[0], patches[1], patches[3]:
        await toolkit.search_transcripts(
            "p1", "roof", limit=1, offset=0, session=_SESSION, conversation_id="B"
        )
    assert {"conversation_id": {"id": {"_eq": "B"}}} in fake.queries[0][1]["filter"]["_and"]


# ── grep ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_grep_returns_snippets_in_speaking_order_and_nothing_when_locked() -> None:
    rows = [
        {"id": "k1", "timestamp": "t1", "transcript": "first the roof, then the walls"},
        {"id": "k2", "timestamp": "t2", "transcript": "the roof again"},
    ]
    fake = FakeDirectus({"conversation_chunk": rows})
    conv = {"id": "c1", "project_id": "p1", "is_finished": True, "is_over_cap": False}
    patches = _patched(fake, conv=conv)
    with patches[0], patches[2], patches[3]:
        hits = await toolkit.grep_conversation("c1", "roof", max_matches=5, session=_SESSION)
    assert [h.chunk_id for h in hits] == ["k1", "k2"]
    _collection, query = fake.queries[0]
    assert query["sort"] == ["timestamp", "created_at"] and query["limit"] == 5
    assert {"conversation_id": {"_eq": "c1"}} in query["filter"]["_and"]

    fake = FakeDirectus({"conversation_chunk": rows})
    locked_conv = {"id": "c1", "project_id": "p1", "is_finished": True, "is_over_cap": True}
    patches = _patched(fake, access=_access(tier="free"), conv=locked_conv)
    with patches[0], patches[2], patches[3]:
        hits = await toolkit.grep_conversation("c1", "roof", max_matches=5, session=_SESSION)
    assert hits == [] and fake.queries == []


# ── transcript pages ───────────────────────────────────────────────────────


def _transcript_rows(n: int) -> list[dict[str, Any]]:
    return [{"id": f"k{i}", "timestamp": f"t{i}", "transcript": f"text {i}"} for i in range(n)]


@pytest.mark.asyncio
async def test_read_transcript_pages_in_chunks_and_marks_has_more() -> None:
    fake = FakeDirectus({"conversation_chunk": _transcript_rows(5)}, count=5)
    conv = {"id": "c1", "project_id": "p1", "is_finished": True, "is_over_cap": False}
    patches = _patched(fake, conv=conv)
    with patches[0], patches[2], patches[3]:
        page = await toolkit.read_transcript("c1", offset=2, limit=2, session=_SESSION)
        last = await toolkit.read_transcript("c1", offset=4, limit=2, session=_SESSION)

    assert [c.id for c in page.chunks] == ["k2", "k3"]
    assert page.chunks[0].transcript == "text 2" and page.chunks[0].timestamp == "t2"
    assert page.total == 5 and page.has_more is True and page.transcript_locked is False
    assert page.offset == 2 and page.limit == 2
    assert [c.id for c in last.chunks] == ["k4"] and last.has_more is False
    rows_query = next(q for _c, q in fake.queries if "aggregate" not in q)
    assert rows_query["sort"] == ["timestamp"] and rows_query["offset"] == 2


@pytest.mark.asyncio
async def test_read_transcript_caps_the_page_and_scrubs_a_locked_conversation() -> None:
    fake = FakeDirectus({"conversation_chunk": _transcript_rows(3)}, count=3)
    conv = {"id": "c1", "project_id": "p1", "is_finished": True, "is_over_cap": True}
    patches = _patched(fake, access=_access(tier="free"), conv=conv)
    with patches[0], patches[2], patches[3]:
        page = await toolkit.read_transcript("c1", offset=0, limit=5000, session=_SESSION)

    assert page.limit == toolkit.TRANSCRIPT_LIMIT_MAX and page.transcript_locked is True
    assert [c.transcript for c in page.chunks] == [None, None, None]
    assert [c.id for c in page.chunks] == ["k0", "k1", "k2"] and page.total == 3


# ── listing ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_conversations_probes_one_extra_row_and_lands_date_bounds() -> None:
    rows = [
        {"id": f"c{i}", "project_id": "p1", "is_finished": i % 2 == 0, "created_at": f"d{i}"}
        for i in range(3)
    ]
    fake = FakeDirectus({"conversation": rows})
    patches = _patched(fake)
    with patches[0], patches[1], patches[3]:
        page = await toolkit.list_conversations(
            "p1",
            limit=2,
            offset=0,
            sort="-updated_at",
            created_after="2026-08-30",
            created_before="2026-09-06T00:00:00Z",
            session=_SESSION,
        )

    assert [c.id for c in page.conversations] == ["c0", "c1"] and page.has_more is True
    assert page.conversations[0].status == "processing"
    assert page.conversations[1].status == "live"
    _collection, query = fake.queries[0]
    assert query["limit"] == 3 and query["sort"] == ["-updated_at"]
    assert query["filter"]["created_at"] == {
        "_gte": "2026-08-30",
        "_lte": "2026-09-06T00:00:00Z",
    }
    assert query["filter"]["project_id"] == {"_eq": "p1"}


@pytest.mark.asyncio
async def test_list_conversations_rejects_a_malformed_date_bound() -> None:
    from fastapi import HTTPException

    fake = FakeDirectus({"conversation": []})
    patches = _patched(fake)
    with patches[0], patches[1], patches[3], pytest.raises(HTTPException) as exc:
        await toolkit.list_conversations("p1", created_after="last week", session=_SESSION)
    assert exc.value.status_code == 400 and "created_after" in exc.value.detail
    assert fake.queries == []
