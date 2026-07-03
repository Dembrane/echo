from __future__ import annotations

import re
import json
import time
import asyncio
from uuid import uuid4
from typing import Any, Optional, AsyncIterator
from logging import getLogger
from datetime import datetime, timezone
from contextlib import suppress

from fastapi import Query, Request, APIRouter, HTTPException
from pydantic import Field, BaseModel
from fastapi.responses import JSONResponse, StreamingResponse

from dembrane.service import chat_service, project_service, agentic_run_service
from dembrane.directus import directus
from dembrane.settings import get_settings
from dembrane.chat_utils import generate_title
from dembrane.async_helpers import run_in_thread_pool
from dembrane.agentic_worker import (
    AGENT_CANCELLED_MESSAGE,
    AGENT_CANCELLED_ERROR_CODE,
    process_agentic_run,
)
from dembrane.directus_async import async_directus
from dembrane.agentic_runtime import (
    request_cancel,
    read_live_event,
    acquire_turn_lease,
    publish_live_event,
    refresh_turn_lease,
    release_turn_lease,
    subscribe_live_events,
)
from dembrane.service.agentic import TERMINAL_RUN_STATUSES, AgenticRunNotFoundException
from dembrane.api.dependency_auth import DirectusSession, DependencyDirectusSession

AgenticRouter = APIRouter(tags=["agentic"])
logger = getLogger("dembrane.api.agentic")

settings = get_settings()
SSE_HEARTBEAT_SECONDS = settings.agentic.sse_heartbeat_seconds
RUN_LOCK_TTL_SECONDS = max(1, settings.agentic.run_lock_ttl_seconds)
RUN_LOCK_REFRESH_SECONDS = max(
    1,
    min(settings.agentic.run_lock_refresh_seconds, max(1, RUN_LOCK_TTL_SECONDS - 1)),
)

_ACTIVE_RUN_TASKS: dict[tuple[str, int], asyncio.Task[None]] = {}
_ACTIVE_RUN_TASKS_LOCK = asyncio.Lock()


class AgenticCreateRunSchema(BaseModel):
    project_id: str = Field(..., min_length=1)
    project_chat_id: Optional[str] = None
    message: str = Field(..., min_length=1)
    language: str = Field(default="en", min_length=1)


class AgenticAppendMessageSchema(BaseModel):
    message: str = Field(..., min_length=1)
    language: str = Field(default="en", min_length=1)


class AgenticSupportRequestSchema(BaseModel):
    message: str = Field(..., min_length=1)
    # A short note from the assistant about what the host was doing / needs.
    page_context: Optional[str] = None


# Agent memory: three scopes the agent both reads and writes. Private or
# personal content is only ever allowed at user scope; workspace and project
# memory content must stay generic.
MEMORY_SCOPES = ("workspace", "project", "user")
MEMORY_READ_LIMIT = 200
MEMORY_CARD_FIELDS = ["id", "scope", "memory_key", "content", "source", "updated_at"]


class AgenticMemoryWriteSchema(BaseModel):
    scope: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    memory_key: Optional[str] = None


def _run_task_key(run_id: str, turn_seq: int) -> tuple[str, int]:
    return (run_id, turn_seq)


async def _register_active_task(run_id: str, turn_seq: int, task: asyncio.Task[None]) -> bool:
    key = _run_task_key(run_id, turn_seq)
    async with _ACTIVE_RUN_TASKS_LOCK:
        existing = _ACTIVE_RUN_TASKS.get(key)
        if existing is not None and not existing.done():
            return False
        _ACTIVE_RUN_TASKS[key] = task
        return True


async def _get_active_task(run_id: str, turn_seq: int) -> Optional[asyncio.Task[None]]:
    key = _run_task_key(run_id, turn_seq)
    async with _ACTIVE_RUN_TASKS_LOCK:
        task = _ACTIVE_RUN_TASKS.get(key)
        if task is not None and task.done():
            _ACTIVE_RUN_TASKS.pop(key, None)
            return None
        return task


async def _pop_active_task(run_id: str, turn_seq: int) -> Optional[asyncio.Task[None]]:
    key = _run_task_key(run_id, turn_seq)
    async with _ACTIVE_RUN_TASKS_LOCK:
        return _ACTIVE_RUN_TASKS.pop(key, None)


def _require_agent_token(auth: DirectusSession) -> str:
    if not auth.access_token:
        raise HTTPException(
            status_code=401,
            detail="User access token required for agentic runs",
        )
    return auth.access_token


async def _assert_project_access(project_id: str, auth: DirectusSession) -> None:
    """v2 access gate shared with the chat BFF: any workspace member whose
    role grants chat:use can drive the agent (the old check required the
    project creator, which 403'd members the read tools already serve).
    Staff admins bypass the app-layer model (they may have no app_user row).
    Non-members get 404, matching the ladder's don't-confirm-existence rule."""
    if auth.is_admin:
        return
    from dembrane.api.v2.bff._access import resolve_project_access

    access = await resolve_project_access(project_id, auth)
    access.require("chat:use")


def _exclude_others_private_chats(base_filter: dict[str, Any], auth: DirectusSession) -> dict[str, Any]:
    """Hide chats that are private and owned by someone else.

    A chat is hidden when `is_private == true` AND `user_created != caller`.
    Implemented as an AND with an OR of the visible cases: not-private
    (false or legacy-null) OR owned-by-caller. Admins bypass, matching the
    admin bypass in _assert_project_access."""
    if auth.is_admin:
        return base_filter
    return {
        **base_filter,
        "_or": [
            {"is_private": {"_neq": True}},
            {"is_private": {"_null": True}},
            {"user_created": {"_eq": auth.user_id}},
        ],
    }


async def _visible_workspace_project_ids(workspace_id: str, auth: DirectusSession) -> list[str]:
    """Project ids in `workspace_id` this caller may see.

    Mirrors workspace_projects.list_workspace_projects visibility so a
    workspace-wide chat listing can't leak chats from private projects the
    caller isn't on. Uses the same helpers that endpoint relies on
    (_visibility_filter_for_caller + _shared_private_project_ids), resolving
    the caller's workspace role via inheritance.user_can_access rather than a
    WorkspaceContext dependency (which agentic routes don't build). Admins
    see every project in the workspace, consistent with _assert_project_access.
    Callers who aren't workspace members (only a project-level share) see just
    the projects they were explicitly shared on."""

    async def _project_ids(filter_: dict[str, Any]) -> list[str]:
        rows = await async_directus.get_items(
            "project",
            {"query": {"filter": filter_, "fields": ["id"], "limit": -1}},
        )
        if not isinstance(rows, list):
            return []
        return [row["id"] for row in rows if isinstance(row, dict) and row.get("id")]

    base_filter: dict[str, Any] = {
        "workspace_id": {"_eq": workspace_id},
        "deleted_at": {"_null": True},
    }

    if auth.is_admin:
        return await _project_ids(base_filter)

    from dembrane.app_user import get_app_user_or_raise
    from dembrane.policies import _normalize_legacy_role
    from dembrane.inheritance import user_can_access
    from dembrane.api.v2.workspace_projects import (
        _shared_private_project_ids,
        _visibility_filter_for_caller,
    )

    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    shared_ids = await _shared_private_project_ids(app_user_id)

    resolved = await user_can_access(workspace_id, app_user_id)
    if resolved is None:
        # Not a workspace member: only privately-shared projects are visible,
        # never the workspace pool.
        if not shared_ids:
            return []
        return await _project_ids({**base_filter, "id": {"_in": list(shared_ids)}})

    role, _source = resolved
    role = _normalize_legacy_role(role) or role
    visibility_clause = _visibility_filter_for_caller(
        caller_role=role,
        shared_ids=shared_ids,
        creator_directus_id=auth.user_id,
    )
    effective = base_filter if visibility_clause is None else {**base_filter, **visibility_clause}
    return await _project_ids(effective)


def _trim_agent_chat(row: dict[str, Any], auth: DirectusSession) -> dict[str, Any]:
    """Shape a project_chat row for the agent, mirroring list_chats' trim."""
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "chat_mode": row.get("chat_mode"),
        "is_private": bool(row.get("is_private")),
        "is_own": row.get("user_created") == auth.user_id,
        "date_updated": row.get("date_updated"),
        "project_id": row.get("project_id"),
    }


def _assert_run_authorized(run: dict[str, Any], auth: DirectusSession) -> None:
    if auth.is_admin:
        return
    if run.get("directus_user_id") != auth.user_id:
        raise HTTPException(status_code=403, detail="Not authorized for this run")


def _get_run_or_404(run_id: str) -> dict[str, Any]:
    try:
        return agentic_run_service.get_by_id_or_raise(run_id)
    except AgenticRunNotFoundException as exc:
        raise HTTPException(status_code=404, detail="Run not found") from exc


def _payload_to_dict(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            return {}
        if isinstance(value, dict):
            return value
    return {}


def _to_non_empty_string(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple, set)):
        return None
    if isinstance(value, str):
        normalized = value.strip()
    else:
        normalized = str(value).strip()
    if not normalized:
        return None
    return normalized


def _build_initial_agent_prompt_content(
    *,
    project_name: Optional[str],
    project_context: Optional[str],
    user_message: str,
) -> str:
    normalized_name = _to_non_empty_string(project_name) or "(none)"
    normalized_context = _to_non_empty_string(project_context) or "(none)"
    normalized_message = user_message.strip()

    return (
        f"Project Name: {normalized_name}\n"
        f"Project Context: {normalized_context}\n\n"
        f"User Message: {normalized_message}"
    )


def _conversation_status(payload: dict[str, Any]) -> str:
    if not payload.get("is_finished"):
        return "live"
    if not payload.get("is_all_chunks_transcribed"):
        return "processing"
    return "done"


def _extract_last_chunk_at(payload: dict[str, Any]) -> Optional[str]:
    direct_value = _to_non_empty_string(payload.get("last_chunk_at"))
    if direct_value is not None:
        return direct_value

    updated_value = _to_non_empty_string(payload.get("updated_at"))
    if updated_value is not None:
        return updated_value

    chunks = payload.get("chunks")
    if not isinstance(chunks, list) or not chunks:
        return None

    latest = chunks[0]
    if not isinstance(latest, dict):
        return None

    timestamp = latest.get("timestamp") or latest.get("created_at")
    return _to_non_empty_string(timestamp)


def _to_related_id(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        return _to_non_empty_string(value.get("id"))
    return _to_non_empty_string(value)


def _memory_scope_owner_ids(
    scope: str,
    *,
    directus_user_id: Optional[str],
    workspace_id: Optional[str],
    project_id: str,
) -> dict[str, Any]:
    """Owner id fields to persist on a memory row of the given scope.

    User memory is owned by the host and may hold private content. Workspace
    and project memory carry no per-user owner, so their content stays generic
    and shared with everyone who can reach that scope."""
    if scope == "user":
        return {"directus_user_id": directus_user_id}
    if scope == "workspace":
        return {"workspace_id": workspace_id}
    if scope == "project":
        return {"project_id": project_id, "workspace_id": workspace_id}
    raise ValueError(f"Unsupported memory scope: {scope}")


def _memory_read_or_filter(
    *,
    directus_user_id: Optional[str],
    workspace_id: Optional[str],
    project_id: str,
) -> dict[str, Any]:
    """Directus _or filter for the three memory scopes the agent reads: this
    host's own user memory, the workspace's memory, and the project's memory."""
    return {
        "_or": [
            {
                "_and": [
                    {"scope": {"_eq": "user"}},
                    {"directus_user_id": {"_eq": directus_user_id}},
                ]
            },
            {
                "_and": [
                    {"scope": {"_eq": "workspace"}},
                    {"workspace_id": {"_eq": workspace_id}},
                ]
            },
            {
                "_and": [
                    {"scope": {"_eq": "project"}},
                    {"project_id": {"_eq": project_id}},
                ]
            },
        ]
    }


def _to_memory_card(row: dict[str, Any]) -> dict[str, Any]:
    return {field: row.get(field) for field in MEMORY_CARD_FIELDS}


def _normalize_transcript_query_tokens(query: str, *, max_tokens: int = 4) -> list[str]:
    raw_tokens = re.findall(r"[a-z0-9]+", query.lower())
    normalized_tokens: list[str] = []
    seen: set[str] = set()
    for token in raw_tokens:
        if len(token) < 4 or token in seen:
            continue
        seen.add(token)
        normalized_tokens.append(token)
        if len(normalized_tokens) >= max_tokens:
            break
    return normalized_tokens


def _build_match_snippet(*, text: str, tokens: list[str], context_window: int = 80) -> str:
    lowered = text.lower()
    best_offset = -1
    best_length = 0

    for token in tokens:
        offset = lowered.find(token)
        if offset < 0:
            continue
        best_offset = offset
        best_length = len(token)
        break

    if best_offset < 0:
        snippet = text.strip()
        return snippet[: context_window * 2].strip()

    start = max(0, best_offset - context_window)
    end = min(len(text), best_offset + best_length + context_window)
    snippet = text[start:end].strip()
    if start > 0 and snippet:
        snippet = f"...{snippet}"
    if end < len(text) and snippet:
        snippet = f"{snippet}..."
    return snippet


def _to_chunk_match(row: dict[str, Any], *, tokens: list[str]) -> Optional[dict[str, str]]:
    chunk_id = _to_non_empty_string(row.get("id"))
    if chunk_id is None:
        return None

    transcript = _to_non_empty_string(row.get("transcript")) or _to_non_empty_string(
        row.get("raw_transcript")
    )
    if transcript is None:
        return None

    timestamp = _to_non_empty_string(row.get("timestamp")) or _to_non_empty_string(
        row.get("created_at")
    )
    return {
        "chunk_id": chunk_id,
        "timestamp": timestamp or "",
        "snippet": _build_match_snippet(text=transcript, tokens=tokens),
    }


def _to_agent_conversation_card(
    row: dict[str, Any],
    *,
    project_id: str,
    fallback_project_id: Optional[str] = None,
    matches: Optional[list[dict[str, str]]] = None,
) -> Optional[dict[str, Any]]:
    normalized_conversation_id = _to_non_empty_string(row.get("id"))
    if normalized_conversation_id is None:
        return None

    row_project_id = _to_related_id(row.get("project_id")) or fallback_project_id
    if row_project_id != project_id:
        return None

    payload = {
        "conversation_id": normalized_conversation_id,
        "participant_name": _to_non_empty_string(row.get("participant_name")),
        "status": _conversation_status(row),
        "summary": row.get("summary") if isinstance(row.get("summary"), str) else None,
        "started_at": _to_non_empty_string(row.get("created_at")),
        "last_chunk_at": _extract_last_chunk_at(row),
    }
    if matches is not None:
        payload["matches"] = matches
    return payload


def _list_project_conversations_for_agent(
    *,
    project_id: str,
    limit: int,
    conversation_id: Optional[str] = None,
    transcript_query: Optional[str] = None,
    directus_client: Any,
) -> dict[str, Any]:
    normalized_limit = max(1, min(limit, 100))
    normalized_conversation_id = _to_non_empty_string(conversation_id)
    normalized_transcript_query = _to_non_empty_string(transcript_query)

    if normalized_transcript_query is not None:
        tokens = _normalize_transcript_query_tokens(normalized_transcript_query)
        if not tokens:
            return {
                "project_id": project_id,
                "count": 0,
                "conversations": [],
            }

        transcript_or_filters: list[dict[str, Any]] = []
        for token in tokens:
            transcript_or_filters.append({"transcript": {"_icontains": token}})
            transcript_or_filters.append({"raw_transcript": {"_icontains": token}})

        transcript_and_filters: list[dict[str, Any]] = [
            {"conversation_id": {"project_id": {"_eq": project_id}}},
            {"_or": transcript_or_filters},
        ]
        if normalized_conversation_id:
            transcript_and_filters.append(
                {"conversation_id": {"id": {"_eq": normalized_conversation_id}}}
            )

        chunk_limit = min(max(normalized_limit * 25, 25), 250)
        chunk_rows = directus_client.get_items(
            "conversation_chunk",
            {
                "query": {
                    "filter": {"_and": transcript_and_filters},
                    "fields": [
                        "id",
                        "timestamp",
                        "created_at",
                        "transcript",
                        "raw_transcript",
                        "conversation_id.id",
                        "conversation_id.project_id",
                        "conversation_id.participant_name",
                        "conversation_id.summary",
                        "conversation_id.is_finished",
                        "conversation_id.is_all_chunks_transcribed",
                        "conversation_id.created_at",
                        "conversation_id.updated_at",
                    ],
                    "sort": ["-timestamp", "-created_at"],
                    "limit": chunk_limit,
                }
            },
        )

        conversations_by_id: dict[str, dict[str, Any]] = {}
        if isinstance(chunk_rows, list):
            for row in chunk_rows:
                if not isinstance(row, dict):
                    continue
                conversation_ref = row.get("conversation_id")
                if not isinstance(conversation_ref, dict):
                    continue
                conversation_identifier = _to_non_empty_string(conversation_ref.get("id"))
                if conversation_identifier is None:
                    continue
                is_new_conversation = conversation_identifier not in conversations_by_id
                if is_new_conversation and len(conversations_by_id) >= normalized_limit:
                    continue
                existing_matches = conversations_by_id.get(conversation_identifier, {}).get("matches")
                normalized_existing_matches = (
                    existing_matches if isinstance(existing_matches, list) else []
                )
                match = _to_chunk_match(row, tokens=tokens)
                next_matches = normalized_existing_matches
                if match is not None and len(normalized_existing_matches) < 3:
                    next_matches = [*normalized_existing_matches, match]
                card = _to_agent_conversation_card(
                    conversation_ref,
                    project_id=project_id,
                    fallback_project_id=project_id,
                    matches=next_matches,
                )
                if card is None:
                    continue
                conversations_by_id[conversation_identifier] = card

        conversations = list(conversations_by_id.values())
        return {
            "project_id": project_id,
            "count": len(conversations),
            "conversations": conversations,
        }

    conversation_filter: dict[str, Any] = {
        "project_id": {"_eq": project_id},
        "deleted_at": {"_null": True},
    }
    if normalized_conversation_id:
        conversation_filter["id"] = {"_eq": normalized_conversation_id}

    rows = directus_client.get_items(
        "conversation",
        {
            "query": {
                "filter": conversation_filter,
                "fields": [
                    "id",
                    "project_id",
                    "participant_name",
                    "summary",
                    "is_finished",
                    "is_all_chunks_transcribed",
                    "created_at",
                    "updated_at",
                ],
                "sort": "-updated_at",
                "limit": normalized_limit,
            }
        },
    )

    conversation_cards: list[dict[str, Any]] = []
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            card = _to_agent_conversation_card(
                row,
                project_id=project_id,
                fallback_project_id=project_id,
            )
            if card is not None:
                conversation_cards.append(card)

    return {
        "project_id": project_id,
        "count": len(conversation_cards),
        "conversations": conversation_cards,
    }


def _persist_chat_user_message(project_chat_id: Optional[str], message: str) -> None:
    if not project_chat_id:
        return

    try:
        chat_service.create_message(
            project_chat_id,
            "user",
            message,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to persist agentic user message to chat %s: %s",
            project_chat_id,
            exc,
        )


async def _maybe_generate_chat_title(
    project_chat_id: Optional[str],
    user_message: str,
    language: str,
) -> None:
    normalized_chat_id = _to_non_empty_string(project_chat_id)
    if normalized_chat_id is None:
        return

    try:
        chat = await run_in_thread_pool(chat_service.get_by_id_or_raise, normalized_chat_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to load agentic chat %s before title generation: %s",
            normalized_chat_id,
            exc,
        )
        return

    existing_name = _to_non_empty_string(chat.get("name"))
    if existing_name is not None:
        return

    try:
        generated_title = await generate_title(user_message, language)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to generate agentic chat title for %s: %s",
            normalized_chat_id,
            exc,
        )
        return

    if _to_non_empty_string(generated_title) is None:
        return

    try:
        await run_in_thread_pool(chat_service.set_chat_name, normalized_chat_id, generated_title)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to persist generated agentic chat title for %s: %s",
            normalized_chat_id,
            exc,
        )


def _schedule_chat_title_generation(
    project_chat_id: Optional[str],
    user_message: str,
    language: str,
) -> None:
    async def _runner() -> None:
        try:
            await _maybe_generate_chat_title(project_chat_id, user_message, language)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Unexpected agentic chat title generation failure: %s", exc)

    asyncio.create_task(_runner())


def _sse_event_payload(event: dict[str, Any], seq: int) -> str:
    payload = json.dumps(event, default=str)
    return f"id: {seq}\nevent: {event.get('event_type')}\ndata: {payload}\n\n"


async def _list_events_after(run_id: str, after_seq: int) -> list[dict[str, Any]]:
    return await run_in_thread_pool(agentic_run_service.list_events, run_id, after_seq=after_seq)


async def _latest_user_turn(run_id: str) -> Optional[tuple[int, str]]:
    event = await run_in_thread_pool(
        agentic_run_service.get_latest_event, run_id, event_type="user.message"
    )
    if event is None:
        return None

    payload = _payload_to_dict(event.get("payload"))
    content = payload.get("agent_prompt_content")
    if not isinstance(content, str) or not content.strip():
        content = payload.get("content")
    if not isinstance(content, str) or not content.strip():
        return None

    seq = int(event.get("seq") or 0)
    if seq <= 0:
        return None
    return seq, content


def _project_id_from_run(run: dict[str, Any]) -> str:
    value = run.get("project_id")
    if isinstance(value, dict):
        return str(value.get("id") or "")
    return str(value or "")


async def _refresh_lease_until_done(
    *,
    run_id: str,
    turn_seq: int,
    owner_token: str,
    worker_task: asyncio.Task[None],
) -> None:
    while not worker_task.done():
        await asyncio.sleep(RUN_LOCK_REFRESH_SECONDS)
        try:
            refreshed = await refresh_turn_lease(
                run_id,
                turn_seq,
                owner_token,
                RUN_LOCK_TTL_SECONDS,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to refresh lease for run %s turn %s: %s", run_id, turn_seq, exc)
            continue

        if not refreshed:
            logger.warning(
                "Lost lease for run %s turn %s; cancelling local processor task",
                run_id,
                turn_seq,
            )
            worker_task.cancel()
            return


async def _start_claimed_turn(
    *,
    run_id: str,
    project_id: str,
    turn_seq: int,
    user_message: str,
    bearer_token: str,
    owner_token: str,
) -> None:
    async def _runner() -> None:
        worker_task = asyncio.create_task(
            process_agentic_run(
                run_id=run_id,
                project_id=project_id,
                user_message=user_message,
                bearer_token=bearer_token,
                turn_seq=turn_seq,
                owner_token=owner_token,
            )
        )
        refresh_task = asyncio.create_task(
            _refresh_lease_until_done(
                run_id=run_id,
                turn_seq=turn_seq,
                owner_token=owner_token,
                worker_task=worker_task,
            )
        )

        try:
            await worker_task
        finally:
            refresh_task.cancel()
            with suppress(Exception):
                await refresh_task
            try:
                await release_turn_lease(run_id, turn_seq, owner_token)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Failed to release lease for run %s turn %s: %s", run_id, turn_seq, exc
                )
            await _pop_active_task(run_id, turn_seq)

    task = asyncio.create_task(_runner(), name=f"agentic-run-{run_id}-{turn_seq}")
    registered = await _register_active_task(run_id, turn_seq, task)
    if not registered:
        task.cancel()


@AgenticRouter.post("/runs")
async def create_run(
    body: AgenticCreateRunSchema,
    auth: DependencyDirectusSession,
) -> JSONResponse:
    _require_agent_token(auth)

    try:
        project = await run_in_thread_pool(project_service.get_by_id_or_raise, body.project_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Project %s not found while creating run", body.project_id)
        raise HTTPException(status_code=404, detail="Project not found") from exc

    await _assert_project_access(body.project_id, auth)

    # Matrix §8: agentic analysis is a host-side operation → Pilot hard-block.
    from dembrane.api.v2.middleware import check_no_pilot_block_for_project

    await check_no_pilot_block_for_project(body.project_id)

    # Free tier: max 3 user turns per chat. The 4th routes to upgrade.
    if body.project_chat_id:
        from dembrane.free_tier import (
            FREE_TIER_MAX_CHAT_USER_TURNS,
            is_free_tier,
            resolve_project_tier,
            count_chat_user_turns,
            free_tier_limit_error,
        )

        if is_free_tier(await resolve_project_tier(body.project_id)) and (
            await count_chat_user_turns(body.project_chat_id) >= FREE_TIER_MAX_CHAT_USER_TURNS
        ):
            raise free_tier_limit_error("chat_turns")

    run = await run_in_thread_pool(
        agentic_run_service.create_run,
        project_id=body.project_id,
        project_chat_id=body.project_chat_id,
        directus_user_id=auth.user_id,
    )
    project_name = _to_non_empty_string(project.get("name"))
    project_context = _to_non_empty_string(project.get("context"))
    agent_prompt_content = _build_initial_agent_prompt_content(
        project_name=project_name,
        project_context=project_context,
        user_message=body.message,
    )

    await run_in_thread_pool(
        agentic_run_service.append_event,
        run["id"],
        "user.message",
        {
            "content": body.message,
            "agent_prompt_content": agent_prompt_content,
        },
    )
    await run_in_thread_pool(_persist_chat_user_message, body.project_chat_id, body.message)
    _schedule_chat_title_generation(body.project_chat_id, body.message, body.language)

    refreshed_run = await run_in_thread_pool(_get_run_or_404, run["id"])
    return JSONResponse(status_code=201, content=refreshed_run)


@AgenticRouter.post("/runs/{run_id}/messages")
async def append_message(
    run_id: str,
    body: AgenticAppendMessageSchema,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    _require_agent_token(auth)
    run = await run_in_thread_pool(_get_run_or_404, run_id)
    _assert_run_authorized(run, auth)

    if run.get("status") in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="Run already in progress")

    # Matrix §8: continuing an agentic analysis is a host-side operation.
    project_id = run.get("project_id")
    if project_id:
        from dembrane.api.v2.middleware import check_no_pilot_block_for_project

        await check_no_pilot_block_for_project(str(project_id))

    # Free tier: max 3 user turns per chat. The 4th routes to upgrade.
    chat_id_for_turns = str(run.get("project_chat_id") or "")
    if chat_id_for_turns:
        from dembrane.free_tier import (
            FREE_TIER_MAX_CHAT_USER_TURNS,
            is_free_tier,
            resolve_project_tier,
            count_chat_user_turns,
            free_tier_limit_error,
        )

        if is_free_tier(await resolve_project_tier(str(project_id or ""))) and (
            await count_chat_user_turns(chat_id_for_turns) >= FREE_TIER_MAX_CHAT_USER_TURNS
        ):
            raise free_tier_limit_error("chat_turns")

    await run_in_thread_pool(
        agentic_run_service.append_event,
        run_id,
        "user.message",
        {"content": body.message},
    )
    await run_in_thread_pool(
        _persist_chat_user_message,
        str(run.get("project_chat_id") or ""),
        body.message,
    )
    _schedule_chat_title_generation(
        _to_non_empty_string(run.get("project_chat_id")),
        body.message,
        body.language,
    )
    return await run_in_thread_pool(agentic_run_service.set_status, run_id, "queued")


@AgenticRouter.get("/projects/{project_id}/settings")
async def get_project_settings_for_agent(
    project_id: str,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    """Current editable project settings for the agent (read-only).

    Mirrors the BFF PATCH whitelist so proposeProjectUpdate diffs and the
    apply path always agree on which fields exist."""
    _require_agent_token(auth)

    try:
        project = await run_in_thread_pool(project_service.get_by_id_or_raise, project_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Project %s not found while reading settings", project_id)
        raise HTTPException(status_code=404, detail="Project not found") from exc

    await _assert_project_access(project_id, auth)

    from dembrane.api.v2.bff.tags import ProjectUpdate

    return {field: project.get(field) for field in ProjectUpdate.model_fields}


@AgenticRouter.get("/projects/{project_id}/conversations")
async def list_project_conversations(
    project_id: str,
    auth: DependencyDirectusSession,
    limit: int = Query(default=20, ge=1, le=100),
    conversation_id: Optional[str] = Query(default=None),
    transcript_query: Optional[str] = Query(default=None),
) -> dict[str, Any]:
    _require_agent_token(auth)

    try:
        await run_in_thread_pool(project_service.get_by_id_or_raise, project_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Project %s not found while listing project conversations", project_id)
        raise HTTPException(status_code=404, detail="Project not found") from exc

    await _assert_project_access(project_id, auth)
    return await run_in_thread_pool(
        _list_project_conversations_for_agent,
        project_id=project_id,
        limit=limit,
        conversation_id=conversation_id,
        transcript_query=transcript_query,
        directus_client=directus,
    )


@AgenticRouter.get("/projects/{project_id}/monitor")
async def get_project_monitor_for_agent(
    project_id: str,
    auth: DependencyDirectusSession,
    window_seconds: int = Query(default=45, ge=5, le=600),
) -> dict[str, Any]:
    """Live-conversation status for the agent: which portal conversations are
    recording right now, transcription progress, and any failures. Same
    aggregation as the host-facing monitor."""
    await _assert_project_access(project_id, auth)

    from dembrane.api.v2.bff.conversations import gather_project_monitor

    return await gather_project_monitor(project_id, window_seconds)


@AgenticRouter.get("/projects/{project_id}/chats")
async def list_project_chats_for_agent(
    project_id: str,
    auth: DependencyDirectusSession,
    limit: int = Query(default=30, ge=1, le=200),
    workspace_wide: bool = Query(default=False),
) -> list[dict[str, Any]]:
    """List previous chats the caller may see, so the agent can build on them.

    Default is project-scoped. workspace_wide widens to every project in the
    workspace the caller can access (visibility-filtered). Private chats owned
    by other people are excluded in both modes (admins see all)."""
    await _assert_project_access(project_id, auth)

    from dembrane.api.v2.bff._access import filter_exclude_deleted

    if workspace_wide:
        project = await async_directus.get_item("project", project_id)
        workspace_id = project.get("workspace_id") if isinstance(project, dict) else None
        if not workspace_id:
            base_filter = filter_exclude_deleted({"project_id": {"_eq": project_id}})
        else:
            visible_ids = await _visible_workspace_project_ids(workspace_id, auth)
            if not visible_ids:
                return []
            base_filter = filter_exclude_deleted({"project_id": {"_in": visible_ids}})
    else:
        base_filter = filter_exclude_deleted({"project_id": {"_eq": project_id}})

    filt = _exclude_others_private_chats(base_filter, auth)

    chats = await async_directus.get_items(
        "project_chat",
        {
            "query": {
                "filter": filt,
                "fields": [
                    "id",
                    "name",
                    "chat_mode",
                    "is_private",
                    "user_created",
                    "date_updated",
                    "project_id",
                ],
                "sort": ["-date_updated"],
                "limit": limit,
            }
        },
    )
    chats_list = chats if isinstance(chats, list) else []
    return [_trim_agent_chat(row, auth) for row in chats_list if isinstance(row, dict)]


@AgenticRouter.get("/chats/{chat_id}/messages")
async def read_chat_for_agent(
    chat_id: str,
    auth: DependencyDirectusSession,
    limit: int = Query(default=100, ge=1, le=500),
) -> list[dict[str, Any]]:
    """Read a previous chat's messages in order. Private chats owned by
    someone else 404 (existence-hiding), matching the access ladder."""
    from dembrane.api.v2.bff._access import resolve_chat_access

    _access, chat = await resolve_chat_access(chat_id, auth)

    if (
        not auth.is_admin
        and bool(chat.get("is_private"))
        and chat.get("user_created") != auth.user_id
    ):
        raise HTTPException(status_code=404, detail="Chat not found")

    msgs = await async_directus.get_items(
        "project_chat_message",
        {
            "query": {
                "filter": {"project_chat_id": {"_eq": chat_id}},
                "fields": ["message_from", "text", "date_created"],
                "sort": ["date_created"],
                "limit": limit,
            }
        },
    )
    msgs_list = msgs if isinstance(msgs, list) else []
    return [
        {
            "message_from": m.get("message_from"),
            "text": m.get("text"),
            "date_created": m.get("date_created"),
        }
        for m in msgs_list
        if isinstance(m, dict)
    ]


@AgenticRouter.post("/projects/{project_id}/support-request")
async def create_support_request(
    project_id: str,
    body: AgenticSupportRequestSchema,
    auth: DependencyDirectusSession,
) -> JSONResponse:
    """Raise a support request to the dembrane team on the host's behalf.

    Writes a support_request row (an outbox); a separate job forwards new rows
    to the team. The assistant never contacts anyone directly."""
    await _assert_project_access(project_id, auth)

    project = await async_directus.get_item("project", project_id)
    workspace_id = project.get("workspace_id") if isinstance(project, dict) else None

    created = await async_directus.create_item(
        "support_request",
        {
            "workspace_id": workspace_id,
            "project_id": project_id,
            "directus_user_id": auth.user_id,
            "message": body.message,
            "page_context": body.page_context,
            "status": "new",
        },
    )
    support_request_id = created.get("id") if isinstance(created, dict) else None
    return JSONResponse(
        status_code=201,
        content={"id": support_request_id, "status": "new"},
    )


async def _resolve_workspace_id_for_project(project_id: str) -> Optional[str]:
    """Resolve the workspace a project belongs to. Workspace is the data
    boundary, so it is never taken from the agent; the server derives it."""
    project = await async_directus.get_item("project", project_id)
    if not isinstance(project, dict):
        return None
    return _to_related_id(project.get("workspace_id"))


@AgenticRouter.get("/projects/{project_id}/memory")
async def list_project_memory(
    project_id: str,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    """Return the memory the agent may read for this project: the host's own
    user memory, the workspace's memory, and the project's memory."""
    _require_agent_token(auth)
    await _assert_project_access(project_id, auth)

    workspace_id = await _resolve_workspace_id_for_project(project_id)
    read_filter = _memory_read_or_filter(
        directus_user_id=auth.user_id,
        workspace_id=workspace_id,
        project_id=project_id,
    )
    rows = await async_directus.get_items(
        "agent_memory",
        {
            "query": {
                "filter": read_filter,
                "fields": MEMORY_CARD_FIELDS,
                "sort": "-updated_at",
                "limit": MEMORY_READ_LIMIT,
            }
        },
    )

    memories = [_to_memory_card(row) for row in rows if isinstance(row, dict)]
    return {
        "project_id": project_id,
        "count": len(memories),
        "memories": memories,
    }


@AgenticRouter.post("/projects/{project_id}/memory")
async def write_project_memory(
    project_id: str,
    body: AgenticMemoryWriteSchema,
    auth: DependencyDirectusSession,
) -> dict[str, Any]:
    """Save a memory for this project scope. Upserts on
    (scope, owner, memory_key) when a memory_key is given, else appends."""
    _require_agent_token(auth)
    await _assert_project_access(project_id, auth)

    scope = body.scope.strip().lower()
    if scope not in MEMORY_SCOPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid scope. Use one of: {', '.join(MEMORY_SCOPES)}",
        )

    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    workspace_id = await _resolve_workspace_id_for_project(project_id)
    if scope in {"workspace", "project"} and workspace_id is None:
        raise HTTPException(status_code=500, detail="Project is missing a workspace reference")

    owner_ids = _memory_scope_owner_ids(
        scope,
        directus_user_id=auth.user_id,
        workspace_id=workspace_id,
        project_id=project_id,
    )
    memory_key = _to_non_empty_string(body.memory_key)

    if memory_key is not None:
        existing_filter = {
            "_and": [
                {"scope": {"_eq": scope}},
                {"memory_key": {"_eq": memory_key}},
                *[{field: {"_eq": value}} for field, value in owner_ids.items()],
            ]
        }
        existing = await async_directus.get_items(
            "agent_memory",
            {"query": {"filter": existing_filter, "fields": ["id"], "limit": 1}},
        )
        if isinstance(existing, list) and existing:
            existing_id = _to_non_empty_string((existing[0] or {}).get("id"))
            if existing_id is not None:
                await async_directus.update_item(
                    "agent_memory",
                    existing_id,
                    {
                        "content": content,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    },
                )
                return {"id": existing_id, "scope": scope, "action": "updated"}

    payload = {
        "scope": scope,
        "memory_key": memory_key,
        "content": content,
        "source": "agent",
        **owner_ids,
    }
    created = await async_directus.create_item("agent_memory", payload)
    created_row = created.get("data") if isinstance(created, dict) else {}
    created_id = _to_non_empty_string((created_row or {}).get("id"))
    return {"id": created_id, "scope": scope, "action": "created"}


@AgenticRouter.post("/runs/{run_id}/stream")
async def stream_run(
    run_id: str,
    auth: DependencyDirectusSession,
    after_seq: int = Query(default=0, ge=0),
) -> StreamingResponse:
    token = _require_agent_token(auth)
    run = await run_in_thread_pool(_get_run_or_404, run_id)
    _assert_run_authorized(run, auth)

    if run.get("status") not in TERMINAL_RUN_STATUSES:
        latest_turn = await _latest_user_turn(run_id)
        if latest_turn is not None:
            turn_seq, user_message = latest_turn
            project_id = _project_id_from_run(run)
            if not project_id:
                raise HTTPException(status_code=500, detail="Run is missing project reference")

            owner_token = str(uuid4())
            lease_acquired = await acquire_turn_lease(
                run_id,
                turn_seq,
                owner_token,
                RUN_LOCK_TTL_SECONDS,
            )
            if lease_acquired:
                await _start_claimed_turn(
                    run_id=run_id,
                    project_id=project_id,
                    turn_seq=turn_seq,
                    user_message=user_message,
                    bearer_token=token,
                    owner_token=owner_token,
                )

    return StreamingResponse(
        _stream_live_events(run_id=run_id, after_seq=after_seq),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@AgenticRouter.post("/runs/{run_id}/stop")
async def stop_run(run_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    _require_agent_token(auth)
    run = await run_in_thread_pool(_get_run_or_404, run_id)
    _assert_run_authorized(run, auth)

    latest_turn = await _latest_user_turn(run_id)
    if latest_turn is None:
        raise HTTPException(status_code=409, detail="No active turn to stop")

    turn_seq, _ = latest_turn
    await request_cancel(run_id, turn_seq)

    task = await _get_active_task(run_id, turn_seq)
    if task is not None and not task.done():
        task.cancel()
        return {
            "run_id": run_id,
            "turn_seq": turn_seq,
            "status": "stopping",
        }

    # No task in this replica to cancel: the turn is executing elsewhere, or
    # its executor is gone (restart, lost lease). The cancel flag alone cannot
    # recover a dead run, so the chat would show "Agent is working" forever
    # with Stop doing nothing. Force the same terminal shape the worker's own
    # cancel path produces; a turn that is in fact still alive sees the cancel
    # flag at its next checkpoint and stops quietly.
    if run.get("status") not in TERMINAL_RUN_STATUSES:
        event = await run_in_thread_pool(
            agentic_run_service.append_event,
            run_id,
            "run.failed",
            {
                "error_code": AGENT_CANCELLED_ERROR_CODE,
                "message": AGENT_CANCELLED_MESSAGE,
            },
        )
        try:
            await publish_live_event(run_id, json.dumps(event, default=str))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to publish stop event for run %s: %s", run_id, exc)
        await run_in_thread_pool(
            agentic_run_service.set_status,
            run_id,
            "failed",
            latest_error=AGENT_CANCELLED_MESSAGE,
            latest_error_code=AGENT_CANCELLED_ERROR_CODE,
        )

    return {
        "run_id": run_id,
        "turn_seq": turn_seq,
        "status": "stopped",
    }


@AgenticRouter.get("/runs/{run_id}")
async def get_run(run_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    run = await run_in_thread_pool(_get_run_or_404, run_id)
    _assert_run_authorized(run, auth)
    return run


@AgenticRouter.get("/runs/{run_id}/events")
async def get_run_events(
    run_id: str,
    request: Request,
    auth: DependencyDirectusSession,
    after_seq: int = Query(default=0, ge=0),
) -> Any:
    run = await run_in_thread_pool(_get_run_or_404, run_id)
    _assert_run_authorized(run, auth)

    accept = request.headers.get("accept", "")
    if "text/event-stream" in accept:
        return StreamingResponse(
            _event_stream(run_id=run_id, after_seq=after_seq),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    events = await _list_events_after(run_id, after_seq)
    latest = await run_in_thread_pool(_get_run_or_404, run_id)
    next_seq = after_seq if not events else int(events[-1].get("seq") or after_seq)
    return {
        "run_id": run_id,
        "status": latest.get("status"),
        "events": events,
        "next_seq": next_seq,
        "done": latest.get("status") in TERMINAL_RUN_STATUSES,
    }


async def _stream_live_events(run_id: str, after_seq: int) -> AsyncIterator[str]:
    cursor = after_seq
    last_heartbeat = time.monotonic()

    async def _emit_db_delta() -> AsyncIterator[str]:
        nonlocal cursor
        events = await _list_events_after(run_id, cursor)
        for event in events:
            seq = int(event.get("seq") or cursor)
            if seq <= cursor:
                continue
            cursor = seq
            yield _sse_event_payload(event, seq)

    try:
        async with subscribe_live_events(run_id) as pubsub:
            async for line in _emit_db_delta():
                yield line

            async for line in _emit_db_delta():
                yield line

            while True:
                live_payload = await read_live_event(pubsub, timeout_seconds=1.0)
                if live_payload:
                    try:
                        event = json.loads(live_payload)
                    except json.JSONDecodeError:
                        event = None

                    if isinstance(event, dict):
                        seq = int(event.get("seq") or 0)
                        if seq > cursor:
                            cursor = seq
                            yield _sse_event_payload(event, seq)
                    continue

                async for line in _emit_db_delta():
                    yield line

                latest = await run_in_thread_pool(_get_run_or_404, run_id)
                if latest.get("status") in TERMINAL_RUN_STATUSES:
                    async for line in _emit_db_delta():
                        yield line
                    break

                now = time.monotonic()
                if now - last_heartbeat >= SSE_HEARTBEAT_SECONDS:
                    yield "event: heartbeat\ndata: {}\n\n"
                    last_heartbeat = now
    except Exception as exc:  # noqa: BLE001
        logger.warning("Live stream fallback to DB polling for run %s: %s", run_id, exc)
        async for line in _event_stream(run_id=run_id, after_seq=cursor):
            yield line


async def _event_stream(run_id: str, after_seq: int) -> AsyncIterator[str]:
    cursor = after_seq
    while True:
        events = await _list_events_after(run_id, cursor)
        if events:
            for event in events:
                seq = int(event.get("seq") or cursor)
                if seq <= cursor:
                    continue
                cursor = seq
                yield _sse_event_payload(event, seq)
            continue

        latest = await run_in_thread_pool(_get_run_or_404, run_id)
        if latest.get("status") in TERMINAL_RUN_STATUSES:
            break

        await asyncio.sleep(SSE_HEARTBEAT_SECONDS)
        yield "event: heartbeat\ndata: {}\n\n"
