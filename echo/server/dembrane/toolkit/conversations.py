"""Conversation read primitives: keyword search, grep, transcript pages, listing.

Every call resolves access through the v2 resolvers and applies the
locked/over-cap scrub, so a locked conversation never leaks transcript text
through a snippet or a page. Results are small models; the front doors own
their response shapes and reshape these.
"""

from __future__ import annotations

import re
import asyncio
from typing import TYPE_CHECKING, Any, Literal, Optional
from datetime import datetime

from fastapi import HTTPException
from pydantic import BaseModel, computed_field

from dembrane.free_tier import workspace_over_cap_active
from dembrane.directus_async import async_directus
from dembrane.search_filters import merge_search_filter

if TYPE_CHECKING:
    from dembrane.api.v2.bff._access import ResourceAccess
    from dembrane.api.dependency_auth import DirectusSession

# Query words shorter than this are noise ("the", "and") and are dropped;
# at most this many distinct words are searched.
MIN_TOKEN_LENGTH = 4
MAX_QUERY_TOKENS = 4
SNIPPET_CONTEXT_CHARS = 80
MATCHES_PER_CONVERSATION = 3
# The search scans a bounded window of matching chunk rows instead of
# counting them: this many per wanted conversation, within these bounds.
# `has_more` is exact within the window.
CHUNK_SCAN_PER_CONVERSATION = 25
CHUNK_SCAN_MIN = 25
CHUNK_SCAN_MAX = 1000

SEARCH_LIMIT_MAX = 100
LIST_LIMIT_MAX = 500
GREP_LIMIT_MAX = 50
TRANSCRIPT_LIMIT_MAX = 200

ConversationSort = Literal[
    "-created_at", "created_at", "-updated_at", "updated_at", "-duration", "duration"
]

_CONVERSATION_FIELDS = [
    "id",
    "project_id",
    "title",
    "participant_name",
    "summary",
    "source",
    "duration",
    "is_finished",
    "is_all_chunks_transcribed",
    "is_over_cap",
    "created_at",
    "updated_at",
]


# ── results ────────────────────────────────────────────────────────────────


class Snippet(BaseModel):
    chunk_id: str
    timestamp: str
    snippet: str


class ConversationSummary(BaseModel):
    id: str
    project_id: str
    title: Optional[str] = None
    participant_name: Optional[str] = None
    summary: Optional[str] = None
    source: Optional[str] = None
    duration: Optional[float] = None
    is_finished: Optional[bool] = None
    is_all_chunks_transcribed: Optional[bool] = None
    locked: bool = False
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def status(self) -> str:
        """live while recording, processing until every chunk is transcribed, then done."""
        if not self.is_finished:
            return "live"
        if not self.is_all_chunks_transcribed:
            return "processing"
        return "done"


class ConversationPage(BaseModel):
    project_id: str
    offset: int
    has_more: bool
    conversations: list[ConversationSummary]


class ConversationHit(ConversationSummary):
    matches: list[Snippet] = []


class SearchResult(BaseModel):
    project_id: str
    # The words actually searched; empty when nothing in the query survived
    # normalisation, in which case nothing was scanned.
    tokens: list[str]
    offset: int
    has_more: bool
    conversations: list[ConversationHit]


class TranscriptChunk(BaseModel):
    id: str
    timestamp: Optional[str] = None
    transcript: Optional[str] = None


class TranscriptPage(BaseModel):
    conversation_id: str
    offset: int
    limit: int
    total: int
    has_more: bool
    transcript_locked: bool
    chunks: list[TranscriptChunk]


# ── helpers ────────────────────────────────────────────────────────────────


def _bff() -> tuple[Any, Any]:
    """The v2 access resolvers and the lock scrub, imported at call time.

    `dembrane.api.v2` imports every router eagerly, and the agent router
    reaches this module through `agent_access.tools`; a module-level import
    here would make the toolkit unimportable on its own.
    """
    from dembrane.api.v2.bff import _access, conversations

    return _access, conversations


def _text(value: Any) -> Optional[str]:
    """A stripped string, or None for empty, missing and structured values."""
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return None
    normalized = str(value).strip()
    return normalized or None


def _related_id(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        return _text(value.get("id"))
    return _text(value)


def _clamp(value: int, upper: int) -> int:
    return max(1, min(int(value), upper))


def _iso(value: str, name: str) -> str:
    text = value.strip()
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"{name} must be an ISO 8601 date or datetime"
        ) from None
    return text


def _aggregate_count(rows: Any) -> int:
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        return 0
    count = rows[0].get("count")
    if isinstance(count, dict):
        count = count.get("id")
    try:
        return int(count or 0)
    except (TypeError, ValueError):
        return 0


def normalize_query_tokens(query: str, *, max_tokens: int = MAX_QUERY_TOKENS) -> list[str]:
    """Lower-case alphanumeric words of MIN_TOKEN_LENGTH or more, deduplicated,
    in query order, at most `max_tokens` of them."""
    tokens: list[str] = []
    for token in re.findall(r"[a-z0-9]+", query.lower()):
        if len(token) < MIN_TOKEN_LENGTH or token in tokens:
            continue
        tokens.append(token)
        if len(tokens) >= max_tokens:
            break
    return tokens


def build_snippet(text: str, tokens: list[str], *, context: int = SNIPPET_CONTEXT_CHARS) -> str:
    """`context` characters either side of the first token found in `text`,
    with ellipses where it was cut. The head of the text when none is found."""
    lowered = text.lower()
    for token in tokens:
        offset = lowered.find(token)
        if offset < 0:
            continue
        start = max(0, offset - context)
        end = min(len(text), offset + len(token) + context)
        snippet = text[start:end].strip()
        if start > 0 and snippet:
            snippet = f"...{snippet}"
        if end < len(text) and snippet:
            snippet = f"{snippet}..."
        return snippet
    return text.strip()[: context * 2].strip()


def _transcript_clauses(tokens: list[str]) -> dict[str, Any]:
    """Any token in the transcript, or in raw_transcript, the pre-correction
    twin some older chunks carry instead."""
    clauses: list[dict[str, Any]] = []
    for token in tokens:
        clauses.append({"transcript": {"_icontains": token}})
        clauses.append({"raw_transcript": {"_icontains": token}})
    return {"_or": clauses}


def _chunk_snippet(row: dict[str, Any], tokens: list[str]) -> Optional[Snippet]:
    chunk_id = _text(row.get("id"))
    transcript = _text(row.get("transcript")) or _text(row.get("raw_transcript"))
    if chunk_id is None or transcript is None:
        return None
    timestamp = _text(row.get("timestamp")) or _text(row.get("created_at")) or ""
    return Snippet(
        chunk_id=chunk_id, timestamp=timestamp, snippet=build_snippet(transcript, tokens)
    )


def _summary_fields(row: dict[str, Any], *, project_id: Optional[str]) -> dict[str, Any]:
    summary = row.get("summary")
    return {
        "id": str(row["id"]),
        "project_id": _related_id(row.get("project_id")) or project_id or "",
        "title": _text(row.get("title")),
        "participant_name": _text(row.get("participant_name")),
        "summary": summary if isinstance(summary, str) else None,
        "source": _text(row.get("source")),
        "duration": row.get("duration"),
        "is_finished": row.get("is_finished"),
        "is_all_chunks_transcribed": row.get("is_all_chunks_transcribed"),
        "locked": bool(row.get("locked")),
        "created_at": _text(row.get("created_at")),
        "updated_at": _text(row.get("updated_at")),
    }


async def _project_read_access(
    project_id: str, session: DirectusSession, access: Optional[ResourceAccess]
) -> ResourceAccess:
    if access is None:
        bff_access, _ = _bff()
        access = await bff_access.resolve_project_access(project_id, session)
    access.require("conversation:read")
    return access


async def _conversation_scope(
    conversation_id: str,
    session: DirectusSession,
    resolved: Optional[tuple[ResourceAccess, dict[str, Any]]],
) -> tuple[ResourceAccess, dict[str, Any], bool]:
    """Access, the conversation row with its lock derived, and whether it is locked."""
    bff_access, bff_conversations = _bff()
    if resolved is None:
        resolved = await bff_access.resolve_conversation_access(conversation_id, session)
    access, conv = resolved
    # Enriching pops the over-cap stamp, so a second pass would unlock the row.
    if "locked" not in conv:
        over_cap = await workspace_over_cap_active(access.workspace_id, access.tier)
        bff_conversations._enrich_conversation(conv, access.tier, over_cap)
    return access, conv, bool(conv.get("locked"))


# ── primitives ─────────────────────────────────────────────────────────────


async def search_transcripts(
    project_id: str,
    query: str,
    *,
    limit: int,
    offset: int,
    session: DirectusSession,
    conversation_id: Optional[str] = None,
    access: Optional[ResourceAccess] = None,
) -> SearchResult:
    """Conversations in a project whose transcript contains the query's words,
    most recently spoken first, each with up to MATCHES_PER_CONVERSATION snippets.

    Case-insensitive match per chunk on `conversation_chunk.transcript` (and
    its legacy twin `raw_transcript`). The scan reads a bounded window of matching chunks (CHUNK_SCAN_*), so a page
    deep into a large project may end early; `has_more` is exact within the
    window. `conversation_id` narrows the search to one conversation. Pass
    `access` when the caller already resolved it; the read policy is still
    enforced here.
    """
    access = await _project_read_access(project_id, session, access)
    limit = _clamp(limit, SEARCH_LIMIT_MAX)
    offset = max(0, int(offset))
    tokens = normalize_query_tokens(query)
    if not tokens:
        return SearchResult(
            project_id=project_id, tokens=[], offset=offset, has_more=False, conversations=[]
        )

    _, bff_conversations = _bff()
    over_cap = await workspace_over_cap_active(access.workspace_id, access.tier)
    wanted = limit + offset
    chunk_limit = min(max(wanted * CHUNK_SCAN_PER_CONVERSATION, CHUNK_SCAN_MIN), CHUNK_SCAN_MAX)
    clauses: list[dict[str, Any]] = [
        {"conversation_id": {"project_id": {"_eq": project_id}}},
        {"conversation_id": {"deleted_at": {"_null": True}}},
        _transcript_clauses(tokens),
    ]
    if conversation_id:
        clauses.append({"conversation_id": {"id": {"_eq": conversation_id}}})
    rows = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"_and": clauses},
                "fields": [
                    "id",
                    "timestamp",
                    "created_at",
                    "transcript",
                    "raw_transcript",
                    *[f"conversation_id.{field}" for field in _CONVERSATION_FIELDS],
                ],
                "sort": ["-timestamp", "-created_at"],
                "limit": chunk_limit,
            }
        },
    )

    hits: dict[str, ConversationHit] = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        conv = row.get("conversation_id")
        if not isinstance(conv, dict):
            continue
        cid = _text(conv.get("id"))
        if cid is None:
            continue
        hit = hits.get(cid)
        if hit is None:
            # One conversation past the page is the has_more probe.
            if len(hits) > wanted:
                continue
            bff_conversations._enrich_conversation(conv, access.tier, over_cap)
            hit = ConversationHit(**_summary_fields(conv, project_id=project_id))
            hits[cid] = hit
        if hit.locked:
            bff_conversations._scrub_chunk_transcript(row)
            row.pop("raw_transcript", None)
        if len(hit.matches) < MATCHES_PER_CONVERSATION:
            snippet = _chunk_snippet(row, tokens)
            if snippet is not None:
                hit.matches.append(snippet)

    matched = list(hits.values())
    page = matched[offset : offset + limit]
    return SearchResult(
        project_id=project_id,
        tokens=tokens,
        offset=offset,
        has_more=len(matched) > offset + len(page),
        conversations=page,
    )


async def grep_conversation(
    conversation_id: str,
    query: str,
    *,
    max_matches: int,
    session: DirectusSession,
    resolved: Optional[tuple[ResourceAccess, dict[str, Any]]] = None,
) -> list[Snippet]:
    """Snippets from one conversation's chunks that contain the query's words,
    in speaking order. Nothing comes back from a locked conversation. Pass
    `resolved` (what `resolve_conversation_access` returned) to skip a second
    lookup."""
    _access, _conv, locked = await _conversation_scope(conversation_id, session, resolved)
    max_matches = _clamp(max_matches, GREP_LIMIT_MAX)
    tokens = normalize_query_tokens(query)
    if locked or not tokens:
        return []
    rows = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {
                    "_and": [
                        {"conversation_id": {"_eq": conversation_id}},
                        _transcript_clauses(tokens),
                    ]
                },
                "fields": ["id", "timestamp", "created_at", "transcript", "raw_transcript"],
                "sort": ["timestamp", "created_at"],
                "limit": max_matches,
            }
        },
    )
    out: list[Snippet] = []
    for row in rows if isinstance(rows, list) else []:
        snippet = _chunk_snippet(row, tokens) if isinstance(row, dict) else None
        if snippet is not None:
            out.append(snippet)
    return out


async def read_transcript(
    conversation_id: str,
    *,
    offset: int,
    limit: int,
    session: DirectusSession,
    resolved: Optional[tuple[ResourceAccess, dict[str, Any]]] = None,
) -> TranscriptPage:
    """One page of a conversation's chunks in speaking order, with the total
    chunk count. `offset` and `limit` count chunks; `limit` is capped at
    TRANSCRIPT_LIMIT_MAX. A locked conversation returns its chunks without
    text and `transcript_locked` set."""
    _access, _conv, locked = await _conversation_scope(conversation_id, session, resolved)
    limit = _clamp(limit, TRANSCRIPT_LIMIT_MAX)
    offset = max(0, int(offset))
    filt = {"conversation_id": {"_eq": conversation_id}}
    count_rows, rows = await asyncio.gather(
        async_directus.get_items(
            "conversation_chunk", {"query": {"aggregate": {"count": "id"}, "filter": filt}}
        ),
        async_directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "filter": filt,
                    "fields": ["id", "timestamp", "transcript"],
                    "sort": ["timestamp"],
                    "limit": limit,
                    "offset": offset,
                }
            },
        ),
    )
    _, bff_conversations = _bff()
    chunks: list[TranscriptChunk] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or row.get("id") is None:
            continue
        if locked:
            bff_conversations._scrub_chunk_transcript(row)
        transcript = row.get("transcript")
        chunks.append(
            TranscriptChunk(
                id=str(row["id"]),
                timestamp=_text(row.get("timestamp")),
                transcript=transcript if isinstance(transcript, str) else None,
            )
        )
    total = _aggregate_count(count_rows)
    return TranscriptPage(
        conversation_id=conversation_id,
        offset=offset,
        limit=limit,
        total=total,
        has_more=offset + len(chunks) < total,
        transcript_locked=locked,
        chunks=chunks,
    )


async def list_conversations(
    project_id: str,
    *,
    search: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    sort: ConversationSort = "-created_at",
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
    conversation_id: Optional[str] = None,
    session: DirectusSession,
    access: Optional[ResourceAccess] = None,
) -> ConversationPage:
    """A page of a project's conversations without transcripts. `search`
    matches participant, email, title and summary; `created_after` and
    `created_before` are inclusive ISO 8601 bounds on `created_at`;
    `conversation_id` narrows to one row. One extra row is read so
    `has_more` is exact without a count query."""
    access = await _project_read_access(project_id, session, access)
    limit = _clamp(limit, LIST_LIMIT_MAX)
    offset = max(0, int(offset))
    _, bff_conversations = _bff()
    over_cap = await workspace_over_cap_active(access.workspace_id, access.tier)

    flt: dict[str, Any] = {"project_id": {"_eq": project_id}, "deleted_at": {"_null": True}}
    if conversation_id:
        flt["id"] = {"_eq": conversation_id}
    bounds: dict[str, str] = {}
    if created_after:
        bounds["_gte"] = _iso(created_after, "created_after")
    if created_before:
        bounds["_lte"] = _iso(created_before, "created_before")
    if bounds:
        flt["created_at"] = bounds
    if search and search.strip():
        flt = merge_search_filter(
            flt, search.strip(), bff_conversations._CONVERSATION_SEARCH_FIELDS
        )
    rows = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": flt,
                "fields": _CONVERSATION_FIELDS,
                "sort": [sort],
                "limit": limit + 1,
                "offset": offset,
            }
        },
    )
    row_list = [
        row
        for row in (rows if isinstance(rows, list) else [])
        if isinstance(row, dict) and row.get("id") is not None
    ]
    has_more = len(row_list) > limit
    out: list[ConversationSummary] = []
    for row in row_list[:limit]:
        bff_conversations._enrich_conversation(row, access.tier, over_cap)
        out.append(ConversationSummary(**_summary_fields(row, project_id=project_id)))
    return ConversationPage(
        project_id=project_id, offset=offset, has_more=has_more, conversations=out
    )
