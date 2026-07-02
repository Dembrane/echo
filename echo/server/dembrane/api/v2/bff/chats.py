"""BFF endpoints for project_chat + project_chat_message.

Route prefix: /v2/bff/chats (and /v2/bff/chat-messages).

Same design rules as conversations.py:
- Every endpoint goes through the access layer. chat:use gates reads,
  writes also need project:update (matrix §4 chat is member+admin).
- Soft-delete respected on project_chat (deleted_at column exists).
- Messages have no deleted_at; hard-deletes via DELETE on a message
  hit Directus directly and are gated by the parent chat's access.
"""

from __future__ import annotations

from typing import Optional
from logging import getLogger

from fastapi import Query, APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus
from dembrane.api.v2.bff._access import (
    resolve_chat_access,
    filter_exclude_deleted,
    resolve_project_access,
    resolve_chat_message_access,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
message_router = APIRouter()
logger = getLogger("api.v2.bff.chats")


# ── /v2/bff/chats ─────────────────────────────────────────────────────


class ChatCreate(BaseModel):
    project_id: str
    name: Optional[str] = None


@router.post("")
async def create_chat(
    body: ChatCreate,
    auth: DependencyDirectusSession,
) -> dict:
    """Create a new project_chat."""
    access = await resolve_project_access(body.project_id, auth)
    access.require("chat:use")

    # Free tier: one chat per workspace. Additional chats route to upgrade.
    from dembrane.free_tier import (
        FREE_TIER_MAX_CHATS,
        is_free_tier,
        count_workspace_chats,
        free_tier_limit_error,
    )

    if is_free_tier(access.tier) and (
        await count_workspace_chats(access.workspace_id) >= FREE_TIER_MAX_CHATS
    ):
        raise free_tier_limit_error("chats")


    payload: dict = {
        "id": generate_uuid(),
        "project_id": body.project_id,
    }
    if body.name is not None:
        payload["name"] = body.name

    created = await async_directus.create_item("project_chat", payload)
    if isinstance(created, dict) and "data" in created:
        return created["data"]
    return created or {}


@router.get("")
async def list_chats(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
    limit: int = Query(15, ge=1, le=200),
    offset: int = Query(0, ge=0),
    has_messages: bool = Query(False),
) -> dict:
    """List chats in a project. Returns {chats, total}.

    has_messages=true excludes chats with zero messages from page and total.
    """
    access = await resolve_project_access(project_id, auth)
    access.require("chat:use")

    base_filter: dict = {"project_id": {"_eq": project_id}}
    if has_messages:
        base_filter["count(project_chat_messages)"] = {"_gt": 0}
    filt = filter_exclude_deleted(base_filter)

    chats = (
        await async_directus.get_items(
            "project_chat",
            {
                "query": {
                    "filter": filt,
                    "fields": [
                        "id",
                        "project_id",
                        "date_created",
                        "date_updated",
                        "name",
                        "chat_mode",
                    ],
                    "sort": ["-date_created"],
                    "limit": limit,
                    "offset": offset,
                }
            },
        )
        or []
    )
    chats_list = chats if isinstance(chats, list) else []

    count_agg = await async_directus.get_items(
        "project_chat",
        {"query": {"aggregate": {"count": "id"}, "filter": filt}},
    )
    total = 0
    if isinstance(count_agg, list) and count_agg:
        total = int((count_agg[0].get("count") or {}).get("id", 0) or 0)

    return {"chats": chats_list, "total": total}


@router.get("/{chat_id}")
async def get_chat(
    chat_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Read a chat row (the minimum needed for the chat header)."""
    _access, chat = await resolve_chat_access(chat_id, auth)
    # Trim to the fields the UI actually uses so we don't leak fields
    # the frontend never consumed and can't render (keeps the contract
    # explicit and small).
    return {
        "id": chat["id"],
        "name": chat.get("name"),
        "project_id": chat.get("project_id"),
        "chat_mode": chat.get("chat_mode"),
        "date_created": chat.get("date_created"),
        "date_updated": chat.get("date_updated"),
    }


class ChatUpdate(BaseModel):
    name: Optional[str] = None
    chat_mode: Optional[str] = None


@router.patch("/{chat_id}")
async def update_chat(
    chat_id: str,
    body: ChatUpdate,
    auth: DependencyDirectusSession,
) -> dict:
    """Rename / change mode on a chat. Requires chat:use + project:update."""
    access, _ = await resolve_chat_access(chat_id, auth)
    access.require("project:update")

    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    updated = await async_directus.update_item("project_chat", chat_id, payload)
    if isinstance(updated, dict) and "data" in updated:
        return updated["data"]
    return updated or {}


# ── /v2/bff/chat-messages ─────────────────────────────────────────────


@message_router.get("")
async def list_messages(
    auth: DependencyDirectusSession,
    chat_id: str = Query(...),
    limit: int = Query(100, ge=1, le=500),
) -> list[dict]:
    """List messages for a chat. Sorted chronologically."""
    await resolve_chat_access(chat_id, auth)
    msgs = await async_directus.get_items(
        "project_chat_message",
        {
            "query": {
                "filter": {"project_chat_id": {"_eq": chat_id}},
                "fields": [
                    "id",
                    "date_created",
                    "message_from",
                    "text",
                    "template_key",
                    "tokens_count",
                    "used_conversations",
                    # Expand the m2m so the frontend can render the
                    # "Context added: <names>" line on each user message.
                    "added_conversations.id",
                    "added_conversations.conversation_id.id",
                    "added_conversations.conversation_id.participant_name",
                    "project_chat_id",
                ],
                "sort": ["date_created"],
                "limit": limit,
            }
        },
    )
    return msgs if isinstance(msgs, list) else []


class ChatMessageCreate(BaseModel):
    project_chat_id: str
    message_from: str
    text: str
    template_key: Optional[str] = None


@message_router.post("")
async def create_message(
    body: ChatMessageCreate,
    auth: DependencyDirectusSession,
) -> dict:
    """Insert a chat message. Gated on chat:use on the parent project."""
    access, _ = await resolve_chat_access(body.project_chat_id, auth)
    access.require("chat:use")

    payload = {
        "id": generate_uuid(),
        "project_chat_id": body.project_chat_id,
        "message_from": body.message_from,
        "text": body.text,
    }
    if body.template_key is not None:
        payload["template_key"] = body.template_key

    created = await async_directus.create_item("project_chat_message", payload)
    if isinstance(created, dict) and "data" in created:
        return created["data"]
    return created or {}


@message_router.delete("/{message_id}")
async def delete_message(
    message_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Delete a chat message. Gated on project:update."""
    access, _, _ = await resolve_chat_message_access(message_id, auth)
    access.require("project:update")
    await async_directus.delete_item("project_chat_message", message_id)
    return {"status": "deleted"}
