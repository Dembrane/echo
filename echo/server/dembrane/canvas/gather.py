"""Project-scoped gather execution for canvas ticks."""

from __future__ import annotations

from typing import Any
from datetime import datetime, timezone, timedelta

from dembrane.settings import get_settings
from dembrane.canvas.access import resolve_canvas_reader_context
from dembrane.directus_async import async_directus


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value else None


def _parse_window_minutes(gather_spec: dict[str, Any] | None) -> int:
    raw = (gather_spec or {}).get("window_minutes", 60)
    try:
        minutes = int(raw)
    except (TypeError, ValueError):
        minutes = 60
    return max(1, min(minutes, 60 * 24 * 14))


def _clip(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit].rstrip() + "\n[truncated]", True


async def execute_gather_spec(
    *,
    project_id: str,
    acting_directus_user_id: str,
    gather_spec: dict[str, Any] | None,
) -> dict[str, Any]:
    """Gather recent transcript data after verifying reader access."""
    await resolve_canvas_reader_context(
        acting_directus_user_id=acting_directus_user_id,
        project_id=project_id,
    )

    settings = get_settings().canvas
    spec = gather_spec or {}
    window_minutes = _parse_window_minutes(spec)
    since = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    since_iso = since.isoformat()

    project = await async_directus.get_item("project", project_id)
    project_context = {
        "id": project_id,
        "name": (project or {}).get("name"),
        "context": (project or {}).get("context"),
        "language": (project or {}).get("language") or "en",
        "anonymize_transcripts": bool((project or {}).get("anonymize_transcripts", False)),
    }

    conv_filter: dict[str, Any] = {
        "project_id": {"_eq": project_id},
        "deleted_at": {"_null": True},
    }
    conversation_ids = [str(v) for v in spec.get("conversation_ids") or [] if v]
    if conversation_ids:
        conv_filter["id"] = {"_in": conversation_ids}

    tag_ids = [str(v) for v in spec.get("tag_ids") or [] if v]
    if tag_ids:
        conv_filter["tags"] = {"project_tag_id": {"id": {"_in": tag_ids}}}

    conversations_raw = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": conv_filter,
                "fields": ["id", "participant_name", "created_at"],
                "sort": ["-created_at"],
                "limit": 200,
            }
        },
    )
    conversations = conversations_raw if isinstance(conversations_raw, list) else []

    total_remaining = settings.max_total_transcript_chars
    out: list[dict[str, Any]] = []
    latest_content_at: str | None = None
    chunks_seen = 0
    truncated_conversations = 0

    for conv in conversations:
        conv_id = _as_id(conv.get("id"))
        if not conv_id or total_remaining <= 0:
            break
        chunks_raw = await async_directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "filter": {
                        "conversation_id": {"_eq": conv_id},
                        "transcript": {"_nnull": True},
                        "created_at": {"_gte": since_iso},
                    },
                    "fields": ["id", "transcript", "created_at", "timestamp"],
                    "sort": ["timestamp", "created_at"],
                    "limit": 1500,
                }
            },
        )
        chunks = chunks_raw if isinstance(chunks_raw, list) else []
        text_parts: list[str] = []
        for chunk in chunks:
            transcript = str(chunk.get("transcript") or "").strip()
            if not transcript:
                continue
            chunks_seen += 1
            text_parts.append(transcript)
            chunk_time = chunk.get("created_at") or chunk.get("timestamp")
            if chunk_time and (latest_content_at is None or str(chunk_time) > latest_content_at):
                latest_content_at = str(chunk_time)
        joined = "\n".join(text_parts).strip()
        if not joined:
            continue
        per_conv_limit = min(settings.max_transcript_chars_per_conversation, total_remaining)
        clipped, was_truncated = _clip(joined, per_conv_limit)
        if was_truncated:
            truncated_conversations += 1
        total_remaining -= len(clipped)
        out.append(
            {
                "id": conv_id,
                "label": conv.get("participant_name") or "participant",
                "created_at": conv.get("created_at"),
                "latest_transcript": clipped,
            }
        )

    return {
        "spec": {
            "version": 1,
            "window_minutes": window_minutes,
            "tag_ids": tag_ids,
            "conversation_ids": conversation_ids,
        },
        "project": project_context,
        "counts": {
            "conversations_considered": len(conversations),
            "conversations_with_recent_content": len(out),
            "chunks_seen": chunks_seen,
            "truncated_conversations": truncated_conversations,
            "max_transcript_chars_per_conversation": settings.max_transcript_chars_per_conversation,
            "max_total_transcript_chars": settings.max_total_transcript_chars,
        },
        "latest_content_at": latest_content_at,
        "conversations": out,
    }
