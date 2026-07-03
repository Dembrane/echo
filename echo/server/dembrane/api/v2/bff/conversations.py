"""BFF endpoints for conversations + chunks + conversation_project_tag.

All routes sit under /v2/bff/* and go through the access layer in
_access.py. The frontend used to talk to Directus directly for these
collections; after this migration the Directus row ACL can be locked
to admin-only because no real user path hits it anymore.

Design notes:

- **Access.** Every handler resolves access via resolve_* helpers.
  conversation:read gates the list + detail endpoints, conversation:
  delete gates delete (guest-clamped in the access layer), and
  project:update gates writes because conversations are a property of
  the project (matches the matrix §4 "Edit any project in workspace"
  row — admin + member can edit).

- **Soft delete.** conversation.deleted_at → hidden everywhere. The
  access helpers already 404 soft-deleted parents; list filters add
  deleted_at IS NULL. conversation_chunk has no deleted_at of its own;
  the parent conversation's is what matters.

- **Query shape parity.** We accept a couple of common params (fields,
  limit, offset, include_chunks) so frontend hooks can migrate with
  minimal rewriting. We do NOT expose the full Directus query grammar;
  callers that need it should add a purpose-built endpoint.
"""

from __future__ import annotations

import json
import time
import asyncio
from typing import Any, Literal, Optional, AsyncGenerator
from logging import getLogger
from datetime import datetime, timezone, timedelta

from fastapi import Query, Request, APIRouter, HTTPException
from pydantic import BaseModel
from fastapi.responses import StreamingResponse

from dembrane.redis_async import get_redis_client
from dembrane.tier_capacity import is_conversation_locked
from dembrane.directus_async import async_directus
from dembrane.monitor_stream import (
    channel_for_project,
    get_active_conversation_ids,
)
from dembrane.search_filters import merge_search_filter
from dembrane.visitor_session import (
    VALID_VISITOR_STAGES,
    get_visitors_many,
    get_active_visitor_ids,
)
from dembrane.api.v2.bff._access import (
    filter_exclude_deleted,
    resolve_project_access,
    resolve_conversation_access,
    resolve_conversation_chunk_access,
)
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.conversation_liveness import (
    VALID_PARTICIPANT_STATES,
    get_telemetry_many,
)

router = APIRouter()
logger = getLogger("api.v2.bff.conversations")


# ── /v2/bff/conversations ─────────────────────────────────────────────


_CONVERSATION_DEFAULT_FIELDS = [
    "id",
    "created_at",
    "updated_at",
    "project_id",
    "participant_name",
    "participant_email",
    "title",
    "summary",
    "source",
    "duration",
    "is_finished",
    "is_audio_processing_finished",
    "is_anonymized",
    "is_over_cap",
    "move_history",
]

# Shared by the list/count/select-all endpoints so they stay consistent.
# No `id`: Directus rejects _icontains on uuid fields and errors the query.
_CONVERSATION_SEARCH_FIELDS = [
    "participant_name",
    "participant_email",
    "title",
    "summary",
]


def _conversation_lock(
    conv: dict, tier: Optional[str]
) -> tuple[bool, Optional[str]]:
    """Resolve (locked, lock_reason) for a conversation. Single source of the
    lock decision, shared by the list/detail enrich step and the chunk
    endpoints so they cannot diverge.

    The hours cap locks over-cap conversations on hour-capped tiers (Free's
    1-hour recording cap); paid and legacy (None) tiers never lock.
    """
    if is_conversation_locked(conv, tier):
        return True, "hours_cap"
    return False, None


def _enrich_conversation(conv: dict, tier: Optional[str]) -> dict:
    """Add derived `locked` + `lock_reason`, scrub gated text (summary +
    merged_transcript) on locked rows, strip raw `is_over_cap`.

    Chunk transcripts are scrubbed separately by the chunk endpoints /
    include_chunks path via `_scrub_chunk_transcript`.
    """
    locked, reason = _conversation_lock(conv, tier)
    conv["locked"] = locked
    # Keep lock_reason symmetric with locked (always present) for stable
    # serialization; None when unlocked.
    conv["lock_reason"] = reason
    if locked:
        conv["summary"] = None
        conv["summary_locked"] = True
        # merged_transcript carries the full text; scrub it where present
        # (detail returns the full row; list with fields=* includes it).
        if "merged_transcript" in conv:
            conv["merged_transcript"] = None
        # Scrub transcript text on any embedded relations (chunks /
        # conversation_segments) the caller may have requested via `fields`,
        # so the scalar scrub above cannot be bypassed by embedding relations.
        _scrub_embedded_transcripts(conv)
    conv.pop("is_over_cap", None)
    return conv


def _scrub_chunk_transcript(chunk: dict) -> dict:
    """Redact transcript from a locked conversation's chunk."""
    chunk["transcript"] = None
    chunk["transcript_locked"] = True
    return chunk


def _scrub_embedded_transcripts(conv: dict) -> None:
    """Null transcript-bearing content on a locked conversation's embedded
    relations.

    The list endpoint accepts a caller-supplied `fields` param (incl. `*` and
    relational paths), so transcript-bearing relations like `chunks.transcript`
    or `conversation_segments.transcript` can be embedded inline on the row.
    Scrub them here regardless of which fields were requested, so the scalar
    summary/merged_transcript scrub in `_enrich_conversation` cannot be
    bypassed by requesting the relations directly.
    """
    chunks = conv.get("chunks")
    if isinstance(chunks, list):
        for ch in chunks:
            if isinstance(ch, dict):
                _scrub_chunk_transcript(ch)
    segments = conv.get("conversation_segments")
    if isinstance(segments, list):
        for seg in segments:
            if isinstance(seg, dict):
                if "transcript" in seg:
                    seg["transcript"] = None
                if "contextual_transcript" in seg:
                    seg["contextual_transcript"] = None


@router.get("")
async def list_conversations(
    auth: DependencyDirectusSession,
    project_id: str = Query(..., description="Parent project id."),
    include_chunks: bool = Query(False, description="Embed chunks per row."),
    include_tags: bool = Query(False, description="Embed tag junction rows."),
    fields: Optional[str] = Query(
        None,
        description="Comma-separated Directus fields. Pass '*' for the full row. Defaults to a lean overview set.",
    ),
    sources: Optional[str] = Query(
        None,
        description="Comma-separated source filter (e.g. 'PORTAL_AUDIO,upload').",
    ),
    limit: int = Query(1000, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    sort: Literal[
        "-created_at",
        "created_at",
        "-participant_name",
        "participant_name",
        "-duration",
        "duration",
        "-updated_at",
        "updated_at",
    ] = Query("-created_at"),
    tag_ids: Optional[str] = Query(
        None,
        description="Comma-separated project_tag ids. Match any.",
    ),
    verified_only: bool = Query(False),
    search_text: Optional[str] = Query(None),
    transcript_required: bool = Query(
        False,
        description="Only return conversations that have at least one chunk with transcript text.",
    ),
) -> list[dict]:
    """List conversations in a project the caller can see.

    Replaces the frontend's readItems("conversation", {filter:
    {project_id, deleted_at: null}}) call. Chunks and tag junctions
    are embedded on request to match the previous deep-query shape.
    """
    access = await resolve_project_access(project_id, auth)
    access.require("conversation:read")

    conv_filter: dict = {"project_id": {"_eq": project_id}}
    conv_filter = filter_exclude_deleted(conv_filter)
    if sources:
        src_list = [s.strip() for s in sources.split(",") if s.strip()]
        if src_list:
            conv_filter["source"] = {"_in": src_list}

    tids = [x.strip() for x in (tag_ids or "").split(",") if x.strip()]
    if tids:
        conv_filter["tags"] = {
            "_some": {"project_tag_id": {"id": {"_in": tids}}},
        }

    if verified_only:
        conv_filter["conversation_artifacts"] = {
            "_some": {"approved_at": {"_nnull": True}},
        }

    if fields is None:
        field_list: list[str] = list(_CONVERSATION_DEFAULT_FIELDS)
    elif fields.strip() == "*":
        field_list = ["*"]
    else:
        field_list = [f.strip() for f in fields.split(",") if f.strip()]
        if "id" not in field_list:
            field_list.insert(0, "id")

    query_dict: dict = {
        "filter": conv_filter,
        "fields": field_list,
        "sort": [sort],
        "limit": limit,
        "offset": offset,
    }
    if search_text and search_text.strip():
        query_dict["filter"] = merge_search_filter(
            conv_filter, search_text.strip(), _CONVERSATION_SEARCH_FIELDS
        )

    convs = (
        await async_directus.get_items(
            "conversation",
            {"query": query_dict},
        )
        or []
    )
    if not isinstance(convs, list):
        return []

    if transcript_required and convs:
        # Drop conversations with no non-empty-transcript chunk. Done
        # client-side after the fetch so we don't need Directus `_some`
        # semantics (not exposed reliably via the admin SDK).
        conv_ids = [c["id"] for c in convs]
        hit = (
            await async_directus.get_items(
                "conversation_chunk",
                {
                    "query": {
                        "filter": {
                            "conversation_id": {"_in": conv_ids},
                            "transcript": {"_nempty": True},
                        },
                        "fields": ["conversation_id"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        kept: set[str] = set()
        if isinstance(hit, list):
            for row in hit:
                cid = row.get("conversation_id")
                if cid:
                    kept.add(cid)
        convs = [c for c in convs if c["id"] in kept]

    tier = access.tier
    for conv in convs:
        _enrich_conversation(conv, tier)

    if convs:
        conv_ids = [c["id"] for c in convs]

        artifacts = (
            await async_directus.get_items(
                "conversation_artifact",
                {
                    "query": {
                        "filter": {"conversation_id": {"_in": conv_ids}},
                        "fields": ["id", "conversation_id", "approved_at", "key", "topic_label"],
                        "sort": ["-approved_at", "-date_created"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        artifact_map: dict[str, list[dict]] = {}
        if isinstance(artifacts, list):
            for artifact in artifacts:
                cid = artifact.get("conversation_id")
                if cid:
                    artifact_map.setdefault(cid, []).append(artifact)
        for conv in convs:
            conv["conversation_artifacts"] = artifact_map.get(conv["id"], [])

        # Derived chunk fields (has_transcript, last_chunk_at,
        # has_only_text_chunks) so list views don't need the full chunk embed.
        lean_chunks = (
            await async_directus.get_items(
                "conversation_chunk",
                {
                    "query": {
                        "filter": {"conversation_id": {"_in": conv_ids}},
                        "fields": ["conversation_id", "source", "timestamp", "created_at"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        transcript_hits = (
            await async_directus.get_items(
                "conversation_chunk",
                {
                    "query": {
                        "filter": {
                            "conversation_id": {"_in": conv_ids},
                            "transcript": {"_nempty": True},
                        },
                        "fields": ["conversation_id"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        has_transcript_ids: set[str] = set()
        if isinstance(transcript_hits, list):
            for row in transcript_hits:
                cid = row.get("conversation_id")
                if cid:
                    has_transcript_ids.add(cid)

        # Genuinely-failed chunks: an error set AND no transcript. This
        # excludes transient errors that were later superseded by a successful
        # transcript on the same chunk, so the list badge flags real problems
        # only. Source-agnostic on purpose, so dashboard uploads surface too
        # (the live monitor is portal-only, this list is not).
        error_hits = (
            await async_directus.get_items(
                "conversation_chunk",
                {
                    "query": {
                        "filter": {
                            "conversation_id": {"_in": conv_ids},
                            "error": {"_nempty": True},
                            "transcript": {"_empty": True},
                        },
                        "fields": ["conversation_id"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        has_error_ids: set[str] = set()
        if isinstance(error_hits, list):
            for row in error_hits:
                cid = row.get("conversation_id")
                if cid:
                    has_error_ids.add(cid)
        last_chunk_at: dict[str, str] = {}
        chunk_counts: dict[str, int] = {}
        non_text_ids: set[str] = set()
        if isinstance(lean_chunks, list):
            for ch in lean_chunks:
                cid = ch.get("conversation_id")
                if not cid:
                    continue
                chunk_counts[cid] = chunk_counts.get(cid, 0) + 1
                # null source counts as "not text"
                if ch.get("source") != "PORTAL_TEXT":
                    non_text_ids.add(cid)
                ts = ch.get("timestamp") or ch.get("created_at")
                if ts and (cid not in last_chunk_at or ts > last_chunk_at[cid]):
                    last_chunk_at[cid] = ts
        for conv in convs:
            cid = conv["id"]
            conv["has_transcript"] = cid in has_transcript_ids
            conv["last_chunk_at"] = last_chunk_at.get(cid)
            conv["has_only_text_chunks"] = chunk_counts.get(cid, 0) > 0 and cid not in non_text_ids
            conv["has_transcription_error"] = cid in has_error_ids

        if include_chunks:
            chunks = (
                await async_directus.get_items(
                    "conversation_chunk",
                    {
                        "query": {
                            "filter": {"conversation_id": {"_in": conv_ids}},
                            "fields": [
                                "id",
                                "conversation_id",
                                "transcript",
                                "source",
                                "path",
                                "timestamp",
                                "created_at",
                                "error",
                            ],
                            "sort": ["-timestamp", "-created_at"],
                            "limit": -1,
                        }
                    },
                )
                or []
            )
            locked_conv_ids = {c["id"] for c in convs if c.get("locked")}
            chunk_map: dict[str, list[dict]] = {}
            if isinstance(chunks, list):
                for ch in chunks:
                    cid = ch.get("conversation_id")
                    if cid:
                        if cid in locked_conv_ids:
                            _scrub_chunk_transcript(ch)
                        chunk_map.setdefault(cid, []).append(ch)
            for conv in convs:
                conv["chunks"] = chunk_map.get(conv["id"], [])

        if include_tags:
            tags = (
                await async_directus.get_items(
                    "conversation_project_tag",
                    {
                        "query": {
                            "filter": {"conversation_id": {"_in": conv_ids}},
                            "fields": [
                                "id",
                                "conversation_id",
                                "project_tag_id.id",
                                "project_tag_id.text",
                                "project_tag_id.created_at",
                            ],
                            "limit": -1,
                        }
                    },
                )
                or []
            )
            tag_map: dict[str, list[dict]] = {}
            if isinstance(tags, list):
                for tg in tags:
                    cid = tg.get("conversation_id")
                    if cid:
                        tag_map.setdefault(cid, []).append(tg)
            for conv in convs:
                conv["tags"] = tag_map.get(conv["id"], [])

    return convs


@router.get("/count")
async def count_conversations(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
    tag_ids: Optional[str] = Query(
        None,
        description="Comma-separated project_tag ids. Match any.",
    ),
    verified_only: bool = Query(False),
    search_text: Optional[str] = Query(None),
) -> dict:
    """Count of conversations in a project (deleted_at is null)."""
    access = await resolve_project_access(project_id, auth)
    access.require("conversation:read")
    filt: dict = filter_exclude_deleted({"project_id": {"_eq": project_id}})

    tids = [x.strip() for x in (tag_ids or "").split(",") if x.strip()]
    if tids:
        filt["tags"] = {
            "_some": {"project_tag_id": {"id": {"_in": tids}}},
        }

    if verified_only:
        filt["conversation_artifacts"] = {
            "_some": {"approved_at": {"_nnull": True}},
        }

    query_dict: dict = {
        "aggregate": {"count": "id"},
        "filter": filt,
    }
    if search_text and search_text.strip():
        query_dict["filter"] = merge_search_filter(
            filt, search_text.strip(), _CONVERSATION_SEARCH_FIELDS
        )

    agg = await async_directus.get_items(
        "conversation",
        {"query": query_dict},
    )
    if isinstance(agg, list) and agg:
        return {"count": int((agg[0].get("count") or {}).get("id", 0) or 0)}
    return {"count": 0}


@router.get("/live-count")
async def count_live_conversations(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
    window_seconds: int = Query(
        30,
        ge=5,
        le=600,
        description="Conversation is 'live' if a chunk landed within this many seconds.",
    ),
) -> dict:
    """Count of conversations in this project that got a chunk in the
    last `window_seconds`. Portal-initiated only (no DASHBOARD_UPLOAD /
    CLONE sources).

    Backs the project overview's "ongoing conversations" card. Old
    implementation hit Directus aggregate directly on the frontend
    which (a) broke for workspace members once we locked the ACL down
    and (b) leaked aggregate query shape across the client boundary.
    """
    from datetime import datetime, timezone, timedelta

    access = await resolve_project_access(project_id, auth)
    access.require("conversation:read")

    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=window_seconds)).isoformat()

    agg = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "aggregate": {"countDistinct": ["conversation_id"]},
                "filter": {
                    "conversation_id": {"project_id": {"_eq": project_id}},
                    "source": {"_nin": ["DASHBOARD_UPLOAD", "CLONE"]},
                    "timestamp": {"_gt": cutoff},
                },
            }
        },
    )
    if isinstance(agg, list) and agg:
        val = (agg[0].get("countDistinct") or {}).get("conversation_id", 0) or 0
        try:
            return {"count": int(val)}
        except (TypeError, ValueError):
            return {"count": 0}
    return {"count": 0}


@router.get("/live")
async def list_live_conversations(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
    window_seconds: int = Query(
        30,
        ge=5,
        le=600,
        description="Conversation is 'live' if a chunk landed within this many seconds.",
    ),
) -> list[dict]:
    """Lean rows for conversations with a chunk in the last `window_seconds`,
    portal-initiated only. Same filter as /live-count. Backs the host
    guide's live-recordings list; replaces the frontend's direct
    conversation_chunk read that the ACL lockdown broke.
    """
    from datetime import datetime, timezone, timedelta

    access = await resolve_project_access(project_id, auth)
    access.require("conversation:read")

    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=window_seconds)).isoformat()

    chunks = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {
                    "conversation_id": {"project_id": {"_eq": project_id}},
                    "source": {"_nin": ["DASHBOARD_UPLOAD", "CLONE"]},
                    "timestamp": {"_gt": cutoff},
                },
                "fields": ["conversation_id.id", "conversation_id.participant_name"],
                "limit": 200,
            }
        },
    )

    out: dict[str, dict] = {}
    if isinstance(chunks, list):
        for chunk in chunks:
            conv = chunk.get("conversation_id")
            if isinstance(conv, dict) and conv.get("id") and conv["id"] not in out:
                out[conv["id"]] = {
                    "id": conv["id"],
                    "participant_name": conv.get("participant_name"),
                }
    return list(out.values())


# ── /v2/bff/conversations/monitor ─────────────────────────────────────
#
# Host-facing live monitoring + error exposure. Hosts need to see, at a
# glance, whether a portal conversation is actually recording (chunks
# arriving) and whether any recent chunk failed to transcribe. This is
# deliberately a light query: one bounded read over recent chunks plus
# one grouped count, aggregated in Python. No N+1 over every chunk of
# every conversation.

# A conversation is "live" if a chunk landed within this many seconds.
MONITOR_LIVE_WINDOW_SECONDS = 45
# Conversations with a chunk in the last this-many seconds are shown at
# all (the "recent/active" set). Keeps the recent-chunk read bounded.
MONITOR_LOOKBACK_SECONDS = 1800
# Hard cap on the recent-chunk read so a busy project can't turn this
# into a heavy query. Newest chunks first, so the live set is preserved.
MONITOR_MAX_CHUNKS = 500
# Truncate the surfaced error so a stack-trace-ish message stays a badge.
MONITOR_ERROR_MESSAGE_MAX_LEN = 240
# Keep the surfaced live-transcript to a short, fading one-liner, not a wall.
MONITOR_TRANSCRIPT_SNIPPET_MAX_LEN = 280


def _monitor_lifecycle_state(
    *, is_finished: bool, reported_state: Any, is_live: bool, chunk_count: int
) -> str:
    """Fold participant-reported telemetry and observed activity into one state.

    Precedence: an explicit finish wins; then whatever the portal last reported
    (recording / paused / verifying / ...); then observed liveness (a recent
    chunk implies recording); then whether any audio has landed at all.
    """
    if is_finished:
        return "finished"
    if isinstance(reported_state, str) and reported_state in VALID_PARTICIPANT_STATES:
        return reported_state
    if is_live:
        return "recording"
    if chunk_count > 0:
        return "idle"
    return "initiated"


def _parse_directus_timestamp(value: Any) -> Optional[datetime]:
    """Parse a Directus ISO timestamp into an aware UTC datetime."""
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    # Directus emits a trailing Z; fromisoformat on 3.11 accepts it, but
    # normalize defensively across formats.
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _transcription_status(
    *, has_error: bool, chunk_count: int, transcribed_count: int
) -> str:
    """Derive a host-facing transcription state for a conversation.

    - "failing": at least one recent chunk carries a transcription error.
    - "transcribing": chunks have arrived that aren't transcribed yet
      (the pipeline is still catching up, or is live and mid-stream).
    - "up_to_date": every chunk has a transcript.
    - "idle": no chunks at all (shouldn't occur in the monitor set).
    """
    if chunk_count <= 0:
        return "idle"
    if has_error:
        return "failing"
    pending = chunk_count - transcribed_count
    if pending > 0:
        return "transcribing"
    return "up_to_date"


def _build_monitor_payload(
    recent_chunks: list[dict],
    chunk_counts: dict[str, int],
    transcribed_counts: dict[str, int],
    now: datetime,
    live_window_seconds: int,
    telemetry: Optional[dict[str, dict]] = None,
    tag_map: Optional[dict[str, list[str]]] = None,
    extra_conversations: Optional[list[dict]] = None,
) -> dict:
    """Aggregate recent chunks into a per-conversation monitor view.

    `extra_conversations` seeds sessions that are pinging but have no audio
    chunk yet (just-initiated / waiting), so they appear instantly. Each is a
    dict with id, participant_name, is_finished, created_at, duration.

    `recent_chunks` MUST be newest-first (sorted by -timestamp). Each row
    carries conversation_id (dict with id + participant_name, or a bare id
    string), timestamp, error, transcript, and language. `chunk_counts` /
    `transcribed_counts` are per-conversation totals (all chunks vs. those
    with a non-empty transcript) so the payload can show transcription
    progress. `telemetry` maps conversation_id -> the latest participant ping
    (Redis): its `seen` datetime is the primary "still here" signal (live if
    it pinged OR uploaded a chunk within the window), and it may carry the
    reported lifecycle state plus best-effort network/battery. `tag_map` maps
    conversation_id -> project-tag labels. Pure function so liveness, state,
    error detection, and transcription progress are unit-testable without
    Directus or Redis.
    """
    telemetry = telemetry or {}
    tag_map = tag_map or {}
    live_cutoff = now - timedelta(seconds=live_window_seconds)

    order: list[str] = []
    by_conv: dict[str, dict] = {}

    # Seed chunk-less, currently-pinging sessions first so a just-initiated
    # conversation shows up before its first audio chunk exists.
    for extra in extra_conversations or []:
        conv_id = extra.get("id")
        if not conv_id or conv_id in by_conv:
            continue
        by_conv[conv_id] = {
            "id": conv_id,
            "label": (extra.get("participant_name") or "").strip() or None,
            "is_finished": bool(extra.get("is_finished")),
            "last_chunk_at": None,
            "last_chunk_dt": None,
            "has_error": False,
            "error_message": None,
            "latest_transcript": None,
            "language": None,
            "created_at": extra.get("created_at"),
            "duration": extra.get("duration"),
        }
        order.append(conv_id)

    for chunk in recent_chunks:
        conv = chunk.get("conversation_id")
        if isinstance(conv, dict):
            conv_id = conv.get("id")
            participant_name = conv.get("participant_name")
            is_finished = bool(conv.get("is_finished"))
            created_at = conv.get("created_at")
            duration = conv.get("duration")
        else:
            conv_id = conv
            participant_name = None
            is_finished = False
            created_at = None
            duration = None
        if not conv_id:
            continue

        entry = by_conv.get(conv_id)
        if entry is None:
            entry = {
                "id": conv_id,
                "label": (participant_name or "").strip() or None,
                "is_finished": is_finished,
                "last_chunk_at": None,
                "last_chunk_dt": None,
                "has_error": False,
                "error_message": None,
                "latest_transcript": None,
                "language": None,
                "created_at": created_at,
                "duration": duration,
            }
            by_conv[conv_id] = entry
            order.append(conv_id)

        chunk_dt = _parse_directus_timestamp(chunk.get("timestamp"))
        if chunk_dt is not None and (
            entry["last_chunk_dt"] is None or chunk_dt > entry["last_chunk_dt"]
        ):
            entry["last_chunk_dt"] = chunk_dt
            entry["last_chunk_at"] = chunk.get("timestamp")

        # Rows are newest-first, so the first transcript / language we see for a
        # conversation is its most recent one — keep that.
        transcript = chunk.get("transcript")
        if entry["latest_transcript"] is None and isinstance(transcript, str) and transcript.strip():
            entry["latest_transcript"] = transcript.strip()[:MONITOR_TRANSCRIPT_SNIPPET_MAX_LEN]
        if entry["language"] is None:
            language = chunk.get("desired_language") or chunk.get("detected_language")
            if isinstance(language, str) and language.strip():
                entry["language"] = language.strip()

        error = chunk.get("error")
        if isinstance(error, str) and error.strip():
            entry["has_error"] = True
            if entry["error_message"] is None:
                entry["error_message"] = error.strip()[:MONITOR_ERROR_MESSAGE_MAX_LEN]

    conversations: list[dict] = []
    live_count = 0
    error_count = 0
    finished_count = 0
    transcribing_count = 0
    for conv_id in order:
        entry = by_conv[conv_id]
        tele = telemetry.get(conv_id) or {}
        # Liveness folds two signals: the participant ping (primary, arrives
        # every few seconds) and audio-chunk arrival (chunks can be tens of
        # seconds apart). Take the most recent of the two.
        seen_dt = tele.get("seen") if isinstance(tele.get("seen"), datetime) else None
        activity_dt = entry["last_chunk_dt"]
        if seen_dt is not None and (activity_dt is None or seen_dt > activity_dt):
            activity_dt = seen_dt
        # The finish button is a definitive "ended" signal: a finished
        # conversation is never live, even if a late ping/chunk lands after.
        recent = activity_dt is not None and activity_dt > live_cutoff
        is_live = recent and not entry["is_finished"]
        last_seen_at = seen_dt.isoformat() if seen_dt is not None else None

        chunk_count = int(chunk_counts.get(conv_id, 0) or 0)
        transcribed_count = min(int(transcribed_counts.get(conv_id, 0) or 0), chunk_count)
        pending_transcription = max(0, chunk_count - transcribed_count)
        transcription_status = _transcription_status(
            has_error=entry["has_error"],
            chunk_count=chunk_count,
            transcribed_count=transcribed_count,
        )
        state = _monitor_lifecycle_state(
            is_finished=entry["is_finished"],
            reported_state=tele.get("state"),
            is_live=is_live,
            chunk_count=chunk_count,
        )

        if is_live:
            live_count += 1
        if entry["is_finished"]:
            finished_count += 1
        if entry["has_error"]:
            error_count += 1
        if transcription_status == "transcribing":
            transcribing_count += 1
        conversations.append(
            {
                "id": conv_id,
                "label": entry["label"],
                "is_live": is_live,
                "is_finished": entry["is_finished"],
                "state": state,
                "mode": tele.get("mode"),
                "tags": tag_map.get(conv_id, []),
                "language": entry["language"],
                "latest_transcript": entry["latest_transcript"],
                "created_at": entry["created_at"],
                "duration": entry["duration"],
                "network": tele.get("network"),
                "battery": tele.get("battery"),
                "last_chunk_at": entry["last_chunk_at"],
                "last_seen_at": last_seen_at,
                "chunk_count": chunk_count,
                "transcribed_count": transcribed_count,
                "pending_transcription": pending_transcription,
                "transcription_status": transcription_status,
                "has_error": entry["has_error"],
                "error_message": entry["error_message"],
                # Transient: combined activity recency (chunk or ping) for the
                # sort below. Popped before returning.
                "_activity_sort": activity_dt.isoformat() if activity_dt else "",
            }
        )

    # Two stable sorts: most-recent activity first (None sinks to the end),
    # then partition live conversations to the top.
    conversations.sort(key=lambda c: c["_activity_sort"], reverse=True)
    conversations.sort(key=lambda c: 0 if c["is_live"] else 1)
    for conv in conversations:
        conv.pop("_activity_sort", None)

    return {
        "conversations": conversations,
        "summary": {
            "live": live_count,
            "finished": finished_count,
            "transcribing": transcribing_count,
            "with_errors": error_count,
            "total": len(conversations),
        },
        "live_window_seconds": live_window_seconds,
    }


_FUNNEL_STAGES = ("scanned", "terms", "mic_ok", "mic_skipped", "mic_blocked", "profile")


def _build_funnel(
    visitors: dict[str, dict], graduated: set[str]
) -> dict:
    """Shape pre-conversation visitor sessions into the host funnel.

    `visitors` maps visitor_id -> telemetry (with a `seen` datetime). `graduated`
    is the set of visitor_ids that already have a live conversation, so a dot
    that became a recording isn't double-counted in the funnel.
    """
    entries: list[dict] = []
    counts = {stage: 0 for stage in _FUNNEL_STAGES}
    for visitor_id, tele in visitors.items():
        if visitor_id in graduated:
            continue
        stage = tele.get("stage")
        if stage not in VALID_VISITOR_STAGES:
            stage = "scanned"
        seen = tele.get("seen")
        entries.append(
            {
                "id": visitor_id,
                "stage": stage,
                "name": (tele.get("name") or "").strip() or None,
                "tags": tele.get("tags") or [],
                "tags_preselected": bool(tele.get("tags_preselected")),
                "scan_count": int(tele.get("scan_count") or 1),
                "device": tele.get("device"),
                "network": tele.get("network"),
                "battery": tele.get("battery"),
                "last_seen_at": seen.isoformat() if isinstance(seen, datetime) else None,
                "_sort": seen.isoformat() if isinstance(seen, datetime) else "",
            }
        )
        counts[stage] += 1
    entries.sort(key=lambda e: e["_sort"], reverse=True)
    for entry in entries:
        entry.pop("_sort", None)
    return {"visitors": entries, "summary": {**counts, "total": len(entries)}}


async def gather_project_monitor(project_id: str, window_seconds: int) -> dict:
    """Assemble the live-monitor payload for a project (no access gate).

    Callers MUST enforce access before invoking this. Shared by the
    host-facing /monitor route and the agentic monitor endpoint so both
    return exactly the same shape. Portal-initiated conversations only
    (no DASHBOARD_UPLOAD / CLONE); a few bounded reads aggregated in Python.
    """
    now = datetime.now(timezone.utc)
    lookback_cutoff = (now - timedelta(seconds=MONITOR_LOOKBACK_SECONDS)).isoformat()

    recent_chunks = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {
                    "conversation_id": {"project_id": {"_eq": project_id}},
                    "source": {"_nin": ["DASHBOARD_UPLOAD", "CLONE"]},
                    "timestamp": {"_gt": lookback_cutoff},
                },
                "fields": [
                    "conversation_id.id",
                    "conversation_id.participant_name",
                    "conversation_id.is_finished",
                    "conversation_id.created_at",
                    "conversation_id.duration",
                    "timestamp",
                    "error",
                    "transcript",
                    "detected_language",
                    "desired_language",
                ],
                "sort": ["-timestamp"],
                "limit": MONITOR_MAX_CHUNKS,
            }
        },
    )
    if not isinstance(recent_chunks, list):
        recent_chunks = []

    conv_ids: list[str] = []
    seen: set[str] = set()
    for chunk in recent_chunks:
        conv = chunk.get("conversation_id")
        conv_id = conv.get("id") if isinstance(conv, dict) else conv
        if conv_id and conv_id not in seen:
            seen.add(conv_id)
            conv_ids.append(conv_id)

    # Sessions that are pinging but have no chunk yet (just-initiated /
    # waiting) live in the Redis active index, not in the chunk read. Union
    # them in so the monitor shows a conversation the instant it starts.
    ping_only_ids: list[str] = []
    try:
        active_ids = await get_active_conversation_ids(
            project_id, min_score=(now - timedelta(seconds=MONITOR_LOOKBACK_SECONDS)).timestamp()
        )
        ping_only_ids = [cid for cid in active_ids if cid and cid not in seen]
    except Exception as exc:  # noqa: BLE001
        logger.warning("Monitor active-index read failed: %s", exc)

    # Fetch metadata for the chunk-less sessions so they render with a name,
    # tags, and duration. Bounded by the active-index size.
    extra_conversations: list[dict] = []
    if ping_only_ids:
        try:
            extra_rows = await async_directus.get_items(
                "conversation",
                {
                    "query": {
                        "filter": {
                            "id": {"_in": ping_only_ids},
                            "deleted_at": {"_null": True},
                        },
                        "fields": [
                            "id",
                            "participant_name",
                            "is_finished",
                            "created_at",
                            "duration",
                        ],
                        "limit": len(ping_only_ids),
                    }
                },
            )
            if isinstance(extra_rows, list):
                extra_conversations = extra_rows
                for row in extra_rows:
                    cid = row.get("id")
                    if cid and cid not in seen:
                        seen.add(cid)
                        conv_ids.append(cid)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Monitor ping-only metadata read failed: %s", exc)

    chunk_counts: dict[str, int] = {}
    transcribed_counts: dict[str, int] = {}
    if conv_ids:
        agg = await async_directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "aggregate": {"count": "id"},
                    "groupBy": ["conversation_id"],
                    # Re-apply the portal-only source filter so counts match the
                    # live set and don't include dashboard/clone chunks.
                    "filter": {
                        "conversation_id": {"_in": conv_ids},
                        "source": {"_nin": ["DASHBOARD_UPLOAD", "CLONE"]},
                    },
                }
            },
        )
        if isinstance(agg, list):
            for row in agg:
                cid = row.get("conversation_id")
                cnt = int((row.get("count") or {}).get("id", 0) or 0)
                if cid:
                    chunk_counts[cid] = cnt

        # Same grouped count, restricted to chunks that carry a transcript, so
        # we can show transcription progress (transcribed vs. total) without
        # reading transcript text for every chunk.
        transcribed_agg = await async_directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "aggregate": {"count": "id"},
                    "groupBy": ["conversation_id"],
                    "filter": {
                        "conversation_id": {"_in": conv_ids},
                        "source": {"_nin": ["DASHBOARD_UPLOAD", "CLONE"]},
                        "transcript": {"_nempty": True},
                    },
                }
            },
        )
        if isinstance(transcribed_agg, list):
            for row in transcribed_agg:
                cid = row.get("conversation_id")
                cnt = int((row.get("count") or {}).get("id", 0) or 0)
                if cid:
                    transcribed_counts[cid] = cnt

    # Tag labels for the active set, so the monitor can group by tag. Bounded:
    # the active set is already capped by the lookback + chunk cap above.
    tag_map: dict[str, list[str]] = {}
    if conv_ids:
        try:
            tag_rows = await async_directus.get_items(
                "conversation_project_tag",
                {
                    "query": {
                        "filter": {"conversation_id": {"_in": conv_ids}},
                        "fields": ["conversation_id", "project_tag_id.text"],
                        "limit": 2000,
                    }
                },
            )
            if isinstance(tag_rows, list):
                for row in tag_rows:
                    cid = row.get("conversation_id")
                    project_tag = row.get("project_tag_id")
                    text = project_tag.get("text") if isinstance(project_tag, dict) else None
                    if cid and isinstance(text, str) and text.strip():
                        tag_map.setdefault(cid, []).append(text.strip())
        except Exception as exc:  # noqa: BLE001
            logger.warning("Monitor tag read failed: %s", exc)

    # Participant liveness + telemetry pings (Redis) — the primary "still here"
    # signal, finer-grained than chunk arrival, and the source of the reported
    # lifecycle state / network / battery. Best-effort: a Redis blip degrades
    # gracefully to chunk-only liveness rather than failing the monitor.
    telemetry: dict[str, dict] = {}
    if conv_ids:
        try:
            telemetry = await get_telemetry_many(conv_ids)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Monitor liveness ping read failed: %s", exc)

    payload = _build_monitor_payload(
        recent_chunks,
        chunk_counts,
        transcribed_counts,
        now,
        window_seconds,
        telemetry,
        tag_map,
        extra_conversations,
    )

    # Pre-conversation funnel: visitors still onboarding (scan -> terms -> mic
    # -> profile), deduped against those that already graduated into a live
    # conversation (their recording ping carries the visitor_id).
    graduated: set[str] = {
        str(tele["visitor_id"])
        for tele in telemetry.values()
        if tele.get("visitor_id")
    }
    visitors: dict[str, dict] = {}
    try:
        visitor_ids = await get_active_visitor_ids(
            project_id,
            min_score=(now - timedelta(seconds=MONITOR_LOOKBACK_SECONDS)).timestamp(),
        )
        if visitor_ids:
            visitors = await get_visitors_many(project_id, visitor_ids)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Monitor funnel read failed: %s", exc)
    payload["funnel"] = _build_funnel(visitors, graduated)
    return payload


# The monitor snapshot is cached in Redis so Directus is hit at most ~once per
# this many seconds PER PROJECT, no matter how many hosts are watching or how
# often participants ping. Every reader (the poll endpoint and each SSE
# connection) shares one computed snapshot; a thundering herd on expiry is
# avoided with a short compute lock.
MONITOR_SNAPSHOT_CACHE_TTL_SECONDS = 3
_MONITOR_SNAPSHOT_KEY_PREFIX = "monitor:snapshot:"


async def get_project_monitor_snapshot(project_id: str, window_seconds: int) -> dict:
    """Return the monitor payload, served from a short-lived shared Redis cache.

    This is the Directus-load valve: the expensive `gather_project_monitor`
    read runs at most once per TTL per project, and its result is reused by
    every concurrent watcher. All Redis use is best-effort — if the cache is
    unavailable we simply compute directly.
    """
    key = f"{_MONITOR_SNAPSHOT_KEY_PREFIX}{project_id}:{window_seconds}"
    lock_key = f"{key}:lock"
    client = None
    try:
        client = await get_redis_client()
        cached = await client.get(key)
        if cached is not None:
            text = cached.decode("utf-8") if isinstance(cached, (bytes, bytearray)) else cached
            return json.loads(text)
    except Exception as exc:  # noqa: BLE001
        logger.warning("monitor snapshot cache read failed for %s: %s", project_id, exc)
        client = None

    # Cache miss. Take a short lock so only one worker recomputes; if we can't
    # get it, another worker is already computing, so recompute directly rather
    # than block (correctness over a rare duplicate read).
    if client is not None:
        try:
            await client.set(lock_key, b"1", nx=True, ex=5)
        except Exception:  # noqa: BLE001
            pass

    payload = await gather_project_monitor(project_id, window_seconds)

    if client is not None:
        try:
            await client.set(
                key,
                json.dumps(payload, default=str),
                ex=MONITOR_SNAPSHOT_CACHE_TTL_SECONDS,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("monitor snapshot cache write failed for %s: %s", project_id, exc)
    return payload


@router.get("/monitor")
async def monitor_conversations(
    auth: DependencyDirectusSession,
    project_id: str = Query(..., description="Parent project id."),
    window_seconds: int = Query(
        MONITOR_LIVE_WINDOW_SECONDS,
        ge=5,
        le=600,
        description="Conversation is 'live' if a chunk landed within this many seconds.",
    ),
) -> dict:
    """Host-facing live monitor for a project's portal conversations.

    Returns one row per recently-active conversation (a chunk or ping in the
    last MONITOR_LOOKBACK_SECONDS), each with a live indicator, last activity
    time, transcription progress, and an error state, plus a project rollup.
    Served from the shared snapshot cache to keep Directus load flat.
    """
    access = await resolve_project_access(project_id, auth)
    access.require("conversation:read")
    return await get_project_monitor_snapshot(project_id, window_seconds)


# How long the stream waits on the pub/sub channel before recomputing anyway.
# A nudge (participant ping / transcription / finish) wakes it sooner; this is
# the safety net so it still refreshes if a publish is missed.
MONITOR_STREAM_POLL_SECONDS = 2.0
# Emit an SSE comment at least this often so proxies keep the connection open.
MONITOR_STREAM_HEARTBEAT_SECONDS = 15.0


@router.get("/monitor/stream")
async def monitor_conversations_stream(
    request: Request,
    auth: DependencyDirectusSession,
    project_id: str = Query(..., description="Parent project id."),
    window_seconds: int = Query(
        MONITOR_LIVE_WINDOW_SECONDS,
        ge=5,
        le=600,
    ),
) -> StreamingResponse:
    """Server-sent-events stream of the live monitor for a project.

    Sends a full `snapshot` event on connect and again whenever the payload
    changes. A participant ping (with its project_id), a transcription result,
    or a finish publishes a nudge to the project's Redis channel that wakes the
    stream immediately; a short poll timeout is the safety net. Heartbeat
    comments keep proxies from dropping an idle connection.
    """
    access = await resolve_project_access(project_id, auth)
    access.require("conversation:read")

    async def event_stream() -> AsyncGenerator[str, None]:
        channel = channel_for_project(project_id)
        pubsub = None
        try:
            client = await get_redis_client()
            pubsub = client.pubsub()
            await pubsub.subscribe(channel)
        except Exception as exc:  # noqa: BLE001
            # Degrade to timeout-only refresh if pub/sub is unavailable.
            logger.warning("monitor stream subscribe failed for %s: %s", project_id, exc)
            pubsub = None

        last_serialized: Optional[str] = None
        last_emit = time.monotonic()
        try:
            while True:
                if await request.is_disconnected():
                    break

                try:
                    # Shared cache: many connections to the same project reuse
                    # one computed snapshot instead of each hitting Directus.
                    payload = await get_project_monitor_snapshot(project_id, window_seconds)
                    serialized = json.dumps(payload, default=str, sort_keys=True)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("monitor stream snapshot failed for %s: %s", project_id, exc)
                    serialized = None

                now_mono = time.monotonic()
                if serialized is not None and serialized != last_serialized:
                    last_serialized = serialized
                    last_emit = now_mono
                    yield f"event: snapshot\ndata: {serialized}\n\n"
                elif now_mono - last_emit >= MONITOR_STREAM_HEARTBEAT_SECONDS:
                    last_emit = now_mono
                    yield ": keep-alive\n\n"

                # Wait for a nudge, capped by the poll timeout as a safety net.
                if pubsub is not None:
                    try:
                        await pubsub.get_message(
                            ignore_subscribe_messages=True,
                            timeout=MONITOR_STREAM_POLL_SECONDS,
                        )
                    except Exception:  # noqa: BLE001
                        await asyncio.sleep(MONITOR_STREAM_POLL_SECONDS)
                else:
                    await asyncio.sleep(MONITOR_STREAM_POLL_SECONDS)
        finally:
            if pubsub is not None:
                try:
                    await pubsub.unsubscribe(channel)
                    await pubsub.aclose()
                except Exception:  # noqa: BLE001
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/remaining-count")
async def count_remaining_conversations(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
    exclude_ids: Optional[str] = Query(
        None,
        description="Comma-separated conversation ids already in chat context.",
    ),
    tag_ids: Optional[str] = Query(
        None,
        description="Comma-separated project_tag ids. Match any.",
    ),
    verified_only: bool = Query(False),
    search_text: Optional[str] = Query(None),
) -> dict:
    """Count of conversations NOT yet picked up by a chat context.

    Backs `useRemainingConversationsCount` on the chat composer. Has
    the same composite filter shape the frontend built before (tag
    match, verified-only, id exclusion, text search).
    """
    access = await resolve_project_access(project_id, auth)
    access.require("conversation:read")

    filt: dict = filter_exclude_deleted({"project_id": {"_eq": project_id}})

    excl = [x.strip() for x in (exclude_ids or "").split(",") if x.strip()]
    if excl:
        filt["id"] = {"_nin": excl}

    tids = [x.strip() for x in (tag_ids or "").split(",") if x.strip()]
    if tids:
        filt["tags"] = {
            "_some": {"project_tag_id": {"id": {"_in": tids}}},
        }

    if verified_only:
        filt["conversation_artifacts"] = {
            "_some": {"approved_at": {"_nnull": True}},
        }

    query: dict = {"fields": ["id"], "filter": filt, "limit": -1}
    if search_text and search_text.strip():
        query["filter"] = merge_search_filter(
            filt, search_text.strip(), _CONVERSATION_SEARCH_FIELDS
        )

    candidates = await async_directus.get_items("conversation", {"query": query})
    if not isinstance(candidates, list) or not candidates:
        return {"count": 0}

    candidate_ids = [row["id"] for row in candidates if row.get("id")]
    if not candidate_ids:
        return {"count": 0}

    # Match the select-all backend: empty conversations are skipped because
    # they do not add useful context. Counting chunks separately keeps this
    # endpoint aligned with that behavior without relying on relationship
    # aggregate semantics in Directus.
    agg = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "aggregate": {"countDistinct": ["conversation_id"]},
                "filter": {
                    "conversation_id": {"_in": candidate_ids},
                    "transcript": {"_nempty": True},
                },
            }
        },
    )
    if isinstance(agg, list) and agg:
        val = (agg[0].get("countDistinct") or {}).get("conversation_id", 0) or 0
        try:
            return {"count": int(val)}
        except (TypeError, ValueError):
            return {"count": 0}
    return {"count": 0}


@router.get("/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    auth: DependencyDirectusSession,
    include_chunks: bool = Query(False),
    include_tags: bool = Query(False),
) -> dict:
    """Read a single conversation with optional embeds."""
    access, conv = await resolve_conversation_access(conversation_id, auth)
    _enrich_conversation(conv, access.tier)
    is_locked = conv.get("locked", False)

    if include_chunks:
        chunks = (
            await async_directus.get_items(
                "conversation_chunk",
                {
                    "query": {
                        "filter": {"conversation_id": {"_eq": conversation_id}},
                        "fields": ["*"],
                        "sort": ["timestamp"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        chunk_list = chunks if isinstance(chunks, list) else []
        if is_locked:
            for ch in chunk_list:
                _scrub_chunk_transcript(ch)
        conv["chunks"] = chunk_list

    if include_tags:
        tags = (
            await async_directus.get_items(
                "conversation_project_tag",
                {
                    "query": {
                        "filter": {"conversation_id": {"_eq": conversation_id}},
                        "fields": [
                            "id",
                            "project_tag_id.id",
                            "project_tag_id.text",
                            "project_tag_id.created_at",
                        ],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        conv["tags"] = tags if isinstance(tags, list) else []

    return conv


class ConversationUpdate(BaseModel):
    participant_name: Optional[str] = None
    participant_email: Optional[str] = None
    participant_user_agent: Optional[str] = None
    title: Optional[str] = None
    summary: Optional[str] = None
    merged_transcript: Optional[str] = None
    is_anonymized: Optional[bool] = None
    is_finished: Optional[bool] = None


@router.patch("/{conversation_id}")
async def update_conversation(
    conversation_id: str,
    body: ConversationUpdate,
    auth: DependencyDirectusSession,
) -> dict:
    """Update a conversation. Requires project:update on the parent.

    Whitelist of writable fields — callers shouldn't be able to push
    project_id, deleted_at, duration, processing_status, or any other
    internal state through this endpoint. Use /move to change the
    parent project; internal state flips on its own.
    """
    access, _ = await resolve_conversation_access(conversation_id, auth)
    access.require("project:update")

    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    updated = await async_directus.update_item("conversation", conversation_id, payload)
    # Directus update returns {"data": {...}} — unwrap.
    if isinstance(updated, dict) and "data" in updated:
        return updated["data"]
    return updated or {}


class ConversationMove(BaseModel):
    target_project_id: str


@router.post("/{conversation_id}/move")
async def move_conversation(
    conversation_id: str,
    body: ConversationMove,
    auth: DependencyDirectusSession,
) -> dict:
    """Move a conversation to a different project.

    Caller must have project:update on the source AND project:update
    on the target. Same-workspace is not required — cross-workspace
    moves are allowed when the user administers both.
    """
    src_access, conv = await resolve_conversation_access(conversation_id, auth)
    src_access.require("project:update")

    dst_access = await resolve_project_access(body.target_project_id, auth)
    dst_access.require("project:update")

    from dembrane.app_user import resolve_app_user
    from dembrane.move_history import append_move_entry

    me = await resolve_app_user(auth.user_id)
    by_label = (me or {}).get("display_name") or (me or {}).get("email")

    updated = await async_directus.update_item(
        "conversation",
        conversation_id,
        {
            "project_id": body.target_project_id,
            "move_history": append_move_entry(
                conv.get("move_history"),
                from_id=conv.get("project_id"),
                to_id=body.target_project_id,
                by=src_access.app_user_id,
                from_label=src_access.project.get("name"),
                to_label=dst_access.project.get("name"),
                by_label=by_label,
            ),
        },
    )

    from dembrane.cache_utils import invalidate_workspace_and_org_usage

    src_ws_id = src_access.workspace_id
    dst_ws_id = dst_access.workspace_id
    if src_ws_id:
        await invalidate_workspace_and_org_usage(src_ws_id, src_access.org_id)
    if dst_ws_id and dst_ws_id != src_ws_id:
        await invalidate_workspace_and_org_usage(dst_ws_id, dst_access.org_id)

    if isinstance(updated, dict) and "data" in updated:
        return updated["data"]
    return updated or {}


class BulkMoveConversations(BaseModel):
    conversation_ids: list[str]
    target_project_id: str


@router.post("/bulk-move")
async def bulk_move_conversations(
    body: BulkMoveConversations,
    auth: DependencyDirectusSession,
) -> dict:
    """Move several conversations to one target project in a single action.

    Same authorization as the single move (`project:update` on the source of
    each conversation AND on the target). All-or-nothing: every permission is
    checked before any conversation is updated, so a partial-permission request
    fails cleanly without moving anything. Records a move-history entry per
    conversation.
    """
    if not body.conversation_ids:
        raise HTTPException(status_code=400, detail="No conversations selected")
    # De-dupe while preserving order.
    ids = list(dict.fromkeys(body.conversation_ids))
    if len(ids) > 500:
        raise HTTPException(status_code=400, detail="Too many conversations (max 500)")

    dst_access = await resolve_project_access(body.target_project_id, auth)
    dst_access.require("project:update")
    to_label = dst_access.project.get("name")

    from dembrane.app_user import resolve_app_user

    me = await resolve_app_user(auth.user_id)
    by_label = (me or {}).get("display_name") or (me or {}).get("email")

    # Phase 1: resolve + authorize every conversation before mutating any.
    resolved: list[dict] = []
    src_ws_ids: set[str] = set()
    for cid in ids:
        src_access, conv = await resolve_conversation_access(cid, auth)
        src_access.require("project:update")
        resolved.append(
            {
                "conv": conv,
                "app_user_id": src_access.app_user_id,
                "from_label": src_access.project.get("name"),
            }
        )
        if src_access.workspace_id:
            src_ws_ids.add(src_access.workspace_id)

    # Phase 2: apply.
    from dembrane.move_history import append_move_entry

    moved: list[str] = []
    for r in resolved:
        conv = r["conv"]
        await async_directus.update_item(
            "conversation",
            conv["id"],
            {
                "project_id": body.target_project_id,
                "move_history": append_move_entry(
                    conv.get("move_history"),
                    from_id=conv.get("project_id"),
                    to_id=body.target_project_id,
                    by=r["app_user_id"],
                    from_label=r["from_label"],
                    to_label=to_label,
                    by_label=by_label,
                ),
            },
        )
        moved.append(conv["id"])

    from dembrane.cache_utils import invalidate_workspace_and_org_usage

    for ws_id in src_ws_ids:
        await invalidate_workspace_and_org_usage(ws_id, None)
    if dst_access.workspace_id:
        await invalidate_workspace_and_org_usage(dst_access.workspace_id, dst_access.org_id)

    return {"moved": moved, "count": len(moved)}


# ── /v2/bff/conversations/:id/chunks (paginated) ──────────────────────


@router.get("/{conversation_id}/chunks")
async def list_chunks(
    conversation_id: str,
    auth: DependencyDirectusSession,
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    sort: Literal["timestamp", "-timestamp"] = Query("timestamp"),
    fields: Optional[str] = Query(
        None,
        description="Comma-separated Directus field list. Defaults to a lean set.",
    ),
) -> list[dict]:
    """Paginated chunk list for a conversation.

    Replaces the infinite-query `readItems("conversation_chunk", ...)`
    on the conversation detail view.
    """
    access, conv = await resolve_conversation_access(conversation_id, auth)
    is_locked, _ = _conversation_lock(conv, access.tier)

    default_fields = [
        "id",
        "conversation_id",
        "transcript",
        "path",
        "timestamp",
        "error",
        "source",
        "created_at",
    ]
    field_list = [f.strip() for f in fields.split(",") if f.strip()] if fields else default_fields

    chunks = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": field_list,
                "sort": [sort],
                "limit": limit,
                "offset": offset,
            }
        },
    )
    result = chunks if isinstance(chunks, list) else []
    if is_locked:
        for ch in result:
            _scrub_chunk_transcript(ch)
    return result


@router.get("/{conversation_id}/chunk-count")
async def count_chunks(
    conversation_id: str,
    auth: DependencyDirectusSession,
    transcript_required: bool = Query(
        False,
        description="When true, only count chunks whose transcript is non-empty.",
    ),
) -> dict:
    """Count of chunks for a conversation — cheap check used by status UIs.

    With `transcript_required=true` this powers the "does the conversation
    have any transcribed chunks yet" check on the transcript view.
    """
    await resolve_conversation_access(conversation_id, auth)
    filt: dict = {"conversation_id": {"_eq": conversation_id}}
    if transcript_required:
        filt = {
            "_and": [
                {"conversation_id": {"_eq": conversation_id}},
                {"transcript": {"_nempty": True}},
            ]
        }
    agg = await async_directus.get_items(
        "conversation_chunk",
        {"query": {"aggregate": {"count": "id"}, "filter": filt}},
    )
    if isinstance(agg, list) and agg:
        cnt = int((agg[0].get("count") or {}).get("id", 0) or 0)
        return {"count": cnt}
    return {"count": 0}


# ── /v2/bff/conversation-chunks/:id (single) ─────────────────────────


chunk_router = APIRouter()


@chunk_router.get("/{chunk_id}")
async def get_chunk(
    chunk_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Single-chunk read. Rare path — most callers go through the list."""
    access, chunk, conv = await resolve_conversation_chunk_access(chunk_id, auth)
    locked, _ = _conversation_lock(conv, access.tier)
    if locked:
        _scrub_chunk_transcript(chunk)
    return chunk


# ── /v2/bff/conversation-project-tags ─────────────────────────────────
#
# Junction table mapping conversation↔project_tag. Kept as its own
# router so the URL shape matches the collection name. Frontend uses
# these to replace-all tags on a conversation; we expose list + bulk
# replace + bulk delete.


junction_router = APIRouter()


@junction_router.get("")
async def list_conversation_tags(
    auth: DependencyDirectusSession,
    conversation_id: str = Query(...),
) -> list[dict]:
    """List tag-junction rows for a conversation."""
    await resolve_conversation_access(conversation_id, auth)
    rows = await async_directus.get_items(
        "conversation_project_tag",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": [
                    "id",
                    "conversation_id",
                    "project_tag_id.id",
                    "project_tag_id.text",
                    "project_tag_id.created_at",
                ],
                "limit": -1,
            }
        },
    )
    return rows if isinstance(rows, list) else []


class ConversationTagsReplace(BaseModel):
    conversation_id: str
    project_tag_ids: list[str]


@junction_router.post("/replace")
async def replace_conversation_tags(
    body: ConversationTagsReplace,
    auth: DependencyDirectusSession,
) -> list[dict]:
    """Replace the full tag set on a conversation.

    Accepts the full desired list of project_tag_ids; the server
    computes the add + remove delta. Gated on project:update.
    """
    access, conv = await resolve_conversation_access(body.conversation_id, auth)
    access.require("project:update")

    project_id = conv.get("project_id")

    # Validate that every requested tag belongs to this project — we
    # do not allow cross-project tag application even if the caller
    # has access to both projects. Tags are project-local.
    requested_ids = list({tid for tid in body.project_tag_ids if tid})
    valid_ids: set[str] = set()
    if requested_ids:
        valid = await async_directus.get_items(
            "project_tag",
            {
                "query": {
                    "filter": {
                        "id": {"_in": requested_ids},
                        "project_id": {"_eq": project_id},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        if isinstance(valid, list):
            valid_ids = {row["id"] for row in valid if row.get("id")}

    # Current junction rows.
    existing = (
        await async_directus.get_items(
            "conversation_project_tag",
            {
                "query": {
                    "filter": {"conversation_id": {"_eq": body.conversation_id}},
                    "fields": [
                        "id",
                        "project_tag_id.id",
                    ],
                    "limit": -1,
                }
            },
        )
        or []
    )
    existing_list = existing if isinstance(existing, list) else []

    current_tag_ids: set[str] = set()
    for row in existing_list:
        ptid = row.get("project_tag_id")
        if isinstance(ptid, dict):
            ptid = ptid.get("id")
        if ptid:
            current_tag_ids.add(ptid)

    to_add = valid_ids - current_tag_ids
    to_remove_tag_ids = current_tag_ids - valid_ids
    to_remove_row_ids = [
        row["id"]
        for row in existing_list
        if row.get("id")
        and (
            (
                isinstance(row.get("project_tag_id"), dict)
                and row["project_tag_id"].get("id") in to_remove_tag_ids
            )
            or (
                isinstance(row.get("project_tag_id"), str)
                and row["project_tag_id"] in to_remove_tag_ids
            )
        )
    ]

    for row_id in to_remove_row_ids:
        try:
            await async_directus.delete_item("conversation_project_tag", row_id)
        except Exception:  # noqa: BLE001 — per-row best effort
            logger.exception("conversation_project_tag delete failed id=%s", row_id)

    for tag_id in to_add:
        try:
            await async_directus.create_item(
                "conversation_project_tag",
                {
                    # PK is integer auto-increment; let Directus assign it.
                    "conversation_id": body.conversation_id,
                    "project_tag_id": tag_id,
                },
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "conversation_project_tag create failed conv=%s tag=%s",
                body.conversation_id,
                tag_id,
            )

    # Return fresh list so the client can replace state directly.
    fresh = await async_directus.get_items(
        "conversation_project_tag",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": body.conversation_id}},
                "fields": [
                    "id",
                    "conversation_id",
                    "project_tag_id.id",
                    "project_tag_id.text",
                    "project_tag_id.created_at",
                ],
                "limit": -1,
            }
        },
    )
    return fresh if isinstance(fresh, list) else []
