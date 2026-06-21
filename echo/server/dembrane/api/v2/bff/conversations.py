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

from typing import Literal, Optional
from logging import getLogger

from fastapi import Query, APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.tier_capacity import is_conversation_locked
from dembrane.directus_async import async_directus
from dembrane.search_filters import merge_search_filter
from dembrane.api.v2.bff._access import (
    filter_exclude_deleted,
    resolve_project_access,
    resolve_conversation_access,
    resolve_conversation_chunk_access,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

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


def _enrich_conversation(conv: dict, tier: Optional[str]) -> dict:
    """Add derived `locked`, strip raw `is_over_cap` from client responses."""
    conv["locked"] = is_conversation_locked(conv, tier)
    conv.pop("is_over_cap", None)
    return conv


def _scrub_chunk_transcript(chunk: dict) -> dict:
    """Redact transcript from a locked conversation's chunk."""
    chunk["transcript"] = None
    chunk["transcript_locked"] = True
    return chunk


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
            conv["has_only_text_chunks"] = (
                chunk_counts.get(cid, 0) > 0 and cid not in non_text_ids
            )

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
        await invalidate_workspace_and_org_usage(
            dst_access.workspace_id, dst_access.org_id
        )

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
    is_locked = is_conversation_locked(conv, access.tier)

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
    if is_conversation_locked(conv, access.tier):
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
