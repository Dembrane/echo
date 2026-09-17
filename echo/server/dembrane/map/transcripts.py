"""The transcripts a map is generated from: every conversation in the project
that has transcribed text, oldest first."""

from __future__ import annotations

from typing import Any

from dembrane.map.recipe import Transcript
from dembrane.directus_async import async_directus


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value else None


async def count_conversations_with_transcripts(project_id: str) -> int:
    """How many live conversations have transcribed text: what a generation
    would read, counted without loading any of it."""
    rows = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {
                    "conversation_id": {
                        "project_id": {"_eq": project_id},
                        "deleted_at": {"_null": True},
                    },
                    "transcript": {"_nnull": True, "_nempty": True},
                },
                "aggregate": {"countDistinct": ["conversation_id"]},
            }
        },
    )
    if isinstance(rows, list) and rows:
        return int((rows[0].get("countDistinct") or {}).get("conversation_id", 0) or 0)
    return 0


async def load_transcripts(project_id: str) -> list[Transcript]:
    conversations_raw = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"project_id": {"_eq": project_id}, "deleted_at": {"_null": True}},
                "fields": ["id", "participant_name", "created_at"],
                "sort": ["created_at"],
                "limit": -1,
            }
        },
    )
    conversations = [c for c in (conversations_raw or []) if isinstance(c, dict)]
    ids = [cid for cid in (_as_id(c.get("id")) for c in conversations) if cid]
    if not ids:
        return []
    chunks_raw = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"conversation_id": {"_in": ids}, "transcript": {"_nnull": True}},
                "fields": ["conversation_id", "transcript", "timestamp", "created_at"],
                "sort": ["timestamp", "created_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(chunks_raw, list):
        raise RuntimeError("could not read the project's transcripts")
    texts: dict[str, list[str]] = {}
    for chunk in chunks_raw:
        if not isinstance(chunk, dict):
            continue
        cid = _as_id(chunk.get("conversation_id"))
        text = str(chunk.get("transcript") or "").strip()
        if cid and text:
            texts.setdefault(cid, []).append(text)

    transcripts: list[Transcript] = []
    for index, conversation in enumerate(conversations, start=1):
        cid = _as_id(conversation.get("id"))
        text = "\n".join(texts.get(cid or "", [])).strip()
        if not cid or not text:
            continue
        name = str(conversation.get("participant_name") or "").strip()
        transcripts.append(
            Transcript(
                id=cid,
                label=name or f"Conversation {index}",
                created_at=str(conversation.get("created_at") or "") or None,
                text=text,
            )
        )
    return transcripts
