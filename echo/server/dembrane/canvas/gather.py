"""Project-scoped gather execution for canvas ticks."""

from __future__ import annotations

from typing import Any
from datetime import datetime, timezone, timedelta

from dembrane.settings import get_settings
from dembrane.canvas.access import resolve_canvas_reader_context
from dembrane.project_goals import get_current_project_goal_content
from dembrane.directus_async import async_directus

SAMPLE_CONVERSATIONS: tuple[dict[str, Any], ...] = (
    {
        "id": "sample-conversation-1",
        "label": "Sample participant 1",
        "created_at": "sample",
        "latest_transcript": (
            "The welcome flow was clear, but I was not sure where to find the next step "
            "after leaving the session."
        ),
    },
    {
        "id": "sample-conversation-2",
        "label": "Sample participant 2",
        "created_at": "sample",
        "latest_transcript": (
            "I liked seeing the main themes quickly. I would trust it more if the page "
            "made it obvious which notes came from recent conversations."
        ),
    },
    {
        "id": "sample-conversation-3",
        "label": "Sample participant 3",
        "created_at": "sample",
        "latest_transcript": (
            "The most useful parts were concrete examples and a short list of things "
            "the team can act on this week."
        ),
    },
    {
        "id": "sample-conversation-4",
        "label": "Sample participant 4",
        "created_at": "sample",
        "latest_transcript": (
            "Some people are excited, but others need reassurance about privacy and "
            "what will happen with their feedback."
        ),
    },
)


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
    preview_sample: bool = False,
    full_history: bool = False,
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
        "goal": await get_current_project_goal_content(project_id),
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
                        **({} if full_history else {"created_at": {"_gte": since_iso}}),
                    },
                    "fields": ["id", "transcript", "created_at", "timestamp"],
                    "sort": ["timestamp", "created_at"],
                    "limit": 1500,
                }
            },
        )
        chunks = chunks_raw if isinstance(chunks_raw, list) else []
        text_parts: list[str] = []
        chunk_rows: list[dict[str, Any]] = []
        for chunk in chunks:
            transcript = str(chunk.get("transcript") or "").strip()
            if not transcript:
                continue
            chunks_seen += 1
            text_parts.append(transcript)
            chunk_rows.append(
                {
                    "id": _as_id(chunk.get("id")),
                    "transcript": transcript,
                    "created_at": chunk.get("created_at"),
                    "timestamp": chunk.get("timestamp"),
                }
            )
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
                "chunks": chunk_rows,
            }
        )

    sample_mode = bool(preview_sample and len(out) < 2)
    conversations_out = list(SAMPLE_CONVERSATIONS) if sample_mode else out

    return {
        "spec": {
            "version": 1,
            "window_minutes": window_minutes,
            "tag_ids": tag_ids,
            "conversation_ids": conversation_ids,
            "preview_sample": sample_mode,
            "full_history": full_history,
        },
        "project": project_context,
        "counts": {
            "conversations_considered": len(conversations),
            "conversations_with_recent_content": len(out),
            "sample_conversations_used": len(conversations_out) if sample_mode else 0,
            "chunks_seen": chunks_seen,
            "truncated_conversations": truncated_conversations,
            "max_transcript_chars_per_conversation": settings.max_transcript_chars_per_conversation,
            "max_total_transcript_chars": settings.max_total_transcript_chars,
        },
        "latest_content_at": latest_content_at,
        "sample_mode": sample_mode,
        "sample_notice": (
            "Sample conversations, your real conversations replace these." if sample_mode else None
        ),
        "conversations": conversations_out,
    }
