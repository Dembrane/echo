import json
import asyncio
import logging
from typing import Any, Dict, List, Literal, Iterable, Optional, AsyncGenerator

from fastapi import Query, APIRouter, HTTPException
from pydantic import BaseModel
from litellm.utils import token_counter
from fastapi.responses import StreamingResponse

from dembrane.llms import MODELS, arouter_completion, get_completion_kwargs
from dembrane.utils import generate_uuid
from dembrane.service import (
    chat_service,
    conversation_service,
)
from dembrane.settings import get_settings
from dembrane.analytics import capture_event
from dembrane.chat_utils import (
    CHAT_LLM,
    MAX_CHAT_CONTEXT_LENGTH,
    generate_title,
    get_project_chat_history,
    create_system_messages_for_chat,
)
from dembrane.service.chat import ChatServiceException, ChatNotFoundException
from dembrane.async_helpers import run_in_thread_pool
from dembrane.stream_status import stream_with_status
from dembrane.api.rate_limit import create_rate_limiter
from dembrane.directus_async import async_directus
from dembrane.api.conversation import (
    get_conversation_token_count,
    get_conversation_token_counts_bulk,
)
from dembrane.api.dependency_auth import DirectusSession, DependencyDirectusSession

ChatRouter = APIRouter(tags=["chat"])

# Rate limiter for suggestions: 10 per minute per project
suggestions_rate_limiter = create_rate_limiter(
    name="chat_suggestions",
    capacity=10,
    window_seconds=60,
)

logger = logging.getLogger("dembrane.chat")

settings = get_settings()

CONVERSATION_LOCKED_ERROR = "conversation_locked"

# Upper bound on one add-context batch, for both select_all and an explicit
# conversation_ids pick. Matches the ceiling select_all has always fetched at.
MAX_ADD_CONTEXT_CONVERSATIONS = 1000


async def _resolve_workspace_tier(project_id: str) -> Optional[str]:
    """Resolve the workspace tier for a project. Returns None if the chain is broken."""
    project = await async_directus.get_item("project", project_id)
    if not project or not project.get("workspace_id"):
        return None
    from dembrane.billing_account import resolve_workspace_tier

    return await resolve_workspace_tier(project["workspace_id"])


async def _check_conversation_not_locked(conversation_id: str, project_id: str) -> None:
    """Raise 402 if the conversation is locked: over-cap on an hour-capped tier
    (Free's 1-hour recording cap)."""
    conv = await async_directus.get_item("conversation", conversation_id)
    if not conv:
        return
    if not conv.get("is_over_cap"):
        # Locking only ever happens via the hours cap; an under-cap conversation
        # is never locked, so skip the tier lookup entirely.
        return
    tier = await _resolve_workspace_tier(project_id)
    from dembrane.free_tier import conversation_is_locked

    if conversation_is_locked(conv, tier):
        raise HTTPException(
            status_code=402,
            detail={
                "error": CONVERSATION_LOCKED_ERROR,
                "message": "Conversation is locked, upgrade to add it to a chat.",
            },
        )


class ChatContextConversationSchema(BaseModel):
    conversation_id: str
    conversation_participant_name: str
    locked: bool
    token_usage: float  # between 0 and 1


class ChatContextMessageSchema(BaseModel):
    role: Literal["user", "assistant"]
    token_usage: float  # between 0 and 1


class ChatContextSchema(BaseModel):
    conversations: List[ChatContextConversationSchema]
    messages: List[ChatContextMessageSchema]
    conversation_id_list: List[str]
    locked_conversation_id_list: List[str]
    chat_mode: Optional[Literal["overview", "deep_dive", "agentic"]] = (
        None  # None = not yet selected
    )


async def raise_if_chat_not_found_or_not_authorized(
    chat_id: str,
    auth_session: DirectusSession,
    *,
    include_used_conversations: bool = False,
    require: Optional[str] = None,
) -> dict:
    # v2 access gate shared with the BFF (chat:use; `require` adds a stricter
    # policy). Reads use the admin client: row ACL is admin-only post-lockdown.
    chat_svc = chat_service
    try:
        chat = await run_in_thread_pool(
            chat_svc.get_by_id_or_raise,
            chat_id,
            include_used_conversations,
        )
    except ChatNotFoundException as exc:
        logger.debug("Chat %s not found when performing authorization", chat_id)
        raise HTTPException(status_code=404, detail="Chat not found") from exc
    except ChatServiceException as exc:
        logger.error("Failed to fetch chat %s: %s", chat_id, exc)
        raise HTTPException(status_code=500, detail="Failed to load chat") from exc

    # Soft-deleted chats 404 for everyone, including staff admins.
    if chat.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Chat not found")

    # Staff admins bypass the app-layer model (they may have no app_user row).
    if not auth_session.is_admin:
        from dembrane.api.v2.bff._access import resolve_chat_access

        access, _ = await resolve_chat_access(chat_id, auth_session)
        if require:
            access.require(require)

    return chat


def _chat_project_id(chat: dict) -> Optional[str]:
    """Extract the parent project id from a chat row (relation dict or raw id)."""
    project_info = chat.get("project_id")
    if isinstance(project_info, dict):
        return project_info.get("id")
    return project_info


def _raise_if_project_mismatch(chat: dict, body_project_id: Optional[str]) -> None:
    """Reject a caller-supplied project_id that isn't the chat's own project
    (admin-client reads would otherwise leak another tenant's conversations)."""
    if body_project_id is not None and body_project_id != _chat_project_id(chat):
        raise HTTPException(
            status_code=400,
            detail="project_id does not match this chat",
        )


@ChatRouter.delete("/{chat_id}")
async def delete_chat(chat_id: str, auth: DependencyDirectusSession) -> dict:
    """Soft-delete a chat by setting deleted_at."""
    # Same policy as the BFF's chat rename / message delete.
    await raise_if_chat_not_found_or_not_authorized(chat_id, auth, require="project:update")

    from datetime import datetime

    from dembrane.directus import directus

    await run_in_thread_pool(
        directus.update_item,
        "project_chat",
        chat_id,
        {"deleted_at": datetime.utcnow().isoformat()},
    )

    return {"status": "success"}


@ChatRouter.get("/{chat_id}/context", response_model=ChatContextSchema)
async def get_chat_context(chat_id: str, auth: DependencyDirectusSession) -> ChatContextSchema:
    chat = await raise_if_chat_not_found_or_not_authorized(
        chat_id,
        auth,
        include_used_conversations=True,
    )

    chat_svc = chat_service

    messages = await run_in_thread_pool(
        chat_svc.list_messages,
        chat_id,
        include_relationships=True,
        order="asc",
    )

    locked_conversations: set[str] = set()
    user_message_token_count = 0
    assistant_message_token_count = 0

    for message in messages:
        for relation in message.get("used_conversations") or []:
            conversation_ref = relation.get("conversation_id") or {}
            conversation_id = conversation_ref.get("id")
            if conversation_id:
                locked_conversations.add(conversation_id)

        message_from = message.get("message_from")
        if message_from in ["user", "assistant"]:
            message_text = message.get("text", "")
            tokens_count = message.get("tokens_count")
            if tokens_count is None:
                tokens_count = await run_in_thread_pool(
                    token_counter,
                    messages=[{"role": message_from, "content": message_text}],
                    model=get_completion_kwargs(CHAT_LLM)["model"],
                )
                try:
                    await run_in_thread_pool(
                        chat_svc.update_message,
                        message.get("id"),
                        {"tokens_count": tokens_count},
                    )
                except ChatServiceException as exc:  # pragma: no cover - informational only
                    logger.warning(
                        "Failed to persist token count for message %s: %s",
                        message.get("id"),
                        exc,
                    )
            if tokens_count is not None:
                if message_from == "user":
                    user_message_token_count += tokens_count
                else:
                    assistant_message_token_count += tokens_count

    used_conversation_links = chat.get("used_conversations") or []
    logger.debug("Used conversation links: %s", used_conversation_links)

    # Get chat mode (may be None if not yet selected)
    chat_mode = chat.get("chat_mode")

    context = ChatContextSchema(
        conversations=[],
        conversation_id_list=[],
        locked_conversation_id_list=[],
        messages=[
            ChatContextMessageSchema(
                role="user",
                token_usage=user_message_token_count / MAX_CHAT_CONTEXT_LENGTH,
            ),
            ChatContextMessageSchema(
                role="assistant",
                token_usage=assistant_message_token_count / MAX_CHAT_CONTEXT_LENGTH,
            ),
        ],
        chat_mode=chat_mode,
    )

    # Extract conversation metadata first
    conversation_metadata: List[tuple[str, str, bool]] = []  # (id, participant_name, is_locked)
    for link in used_conversation_links:
        logger.debug(
            "Processing used conversation link for conversation %s", link.get("conversation_id")
        )
        conversation_ref = link.get("conversation_id") or {}
        conversation_id = conversation_ref.get("id")
        if not conversation_id:
            continue

        participant_name = str(conversation_ref.get("participant_name") or "")
        is_locked = conversation_id in locked_conversations
        conversation_metadata.append((conversation_id, participant_name, is_locked))

    # Fetch all token counts in one bulk call (chat already authorized above)
    if conversation_metadata:
        token_counts_by_id = await get_conversation_token_counts_bulk(
            [conv_id for conv_id, _, _ in conversation_metadata],
            auth,
            project_id=_chat_project_id(chat) or "",
        )
        # Fail closed: a missing count (transient compute failure) would make
        # this conversation read as token_usage 0 and let the add-context gate
        # admit past the context limit. The pre-bulk code raised here too.
        missing = [cid for cid, _, _ in conversation_metadata if cid not in token_counts_by_id]
        if missing:
            raise HTTPException(
                status_code=503,
                detail="Could not compute chat context size. Please try again.",
            )
    else:
        token_counts_by_id = {}

    # Build context objects with the fetched data
    for conversation_id, participant_name, is_locked in conversation_metadata:
        token_count = token_counts_by_id.get(conversation_id, 0)
        chat_context_resource = ChatContextConversationSchema(
            conversation_id=conversation_id,
            conversation_participant_name=participant_name,
            locked=is_locked,
            token_usage=token_count / MAX_CHAT_CONTEXT_LENGTH,
        )
        context.conversations.append(chat_context_resource)
        context.conversation_id_list.append(conversation_id)
        if is_locked:
            context.locked_conversation_id_list.append(conversation_id)

    return context


class ChatAddContextSchema(BaseModel):
    conversation_id: Optional[str] = None
    # An explicit pick, e.g. the conversations chosen on the Ask screen before
    # the chat existed. Attached in one request so the token budget is walked
    # once, server-side, instead of once per parallel request.
    conversation_ids: Optional[List[str]] = None
    select_all: Optional[bool] = None
    project_id: Optional[str] = None
    tag_ids: Optional[List[str]] = None
    verified_only: Optional[bool] = None
    search_text: Optional[str] = None


class SelectAllConversationResult(BaseModel):
    conversation_id: str
    participant_name: str
    success: bool
    reason: Optional[str] = (
        None  # "added", "already_in_context", "context_limit_reached", "empty",
        # "too_long", "locked", "not_found", "error"
    )


class AddContextResponseSchema(BaseModel):
    added: Optional[List[SelectAllConversationResult]] = None
    skipped: Optional[List[SelectAllConversationResult]] = None
    total_processed: Optional[int] = None
    context_limit_reached: Optional[bool] = None


async def _attach_conversations_within_budget(
    *,
    chat_id: str,
    chat: dict,
    auth: DirectusSession,
    project_id: str,
    candidates: List[dict],
    extra_skipped: Optional[List[SelectAllConversationResult]] = None,
) -> AddContextResponseSchema:
    """Attach as many of `candidates` as this chat can take, in order.

    Shared by every batch entry point (filter-driven select_all and the
    explicit conversation_ids pick) so the token budget is walked in exactly
    one place: each conversation's cost accumulates, and once the budget runs
    out the rest are reported as skipped rather than failing the whole batch.
    That accumulation is the reason batches must not be split into parallel
    single-conversation requests, which each read the same starting context.

    Agentic chats preload nothing (the attached rows are only a focus hint the
    agent reads on demand), so they skip the budget entirely. Same bypass the
    single-conversation path uses.
    """
    from dembrane.free_tier import conversation_is_locked

    chat_svc = chat_service

    enforce_budget = chat.get("chat_mode") != "agentic"

    # Conversations already attached to this chat.
    existing_ids = {
        (link.get("conversation_id") or {}).get("id")
        for link in (chat.get("used_conversations") or [])
    }

    current_token_usage = 0.0
    if enforce_budget:
        chat_context = await get_chat_context(chat_id, auth)
        current_token_usage = sum(
            conversation_entry.token_usage for conversation_entry in chat_context.conversations
        )

    workspace_tier = await _resolve_workspace_tier(project_id)

    # One grouped aggregate instead of fetching every chunk transcript.
    # Guard the empty case: an empty _in has historically degenerated into
    # a full-table grouped scan in Directus.
    candidate_ids = [c["id"] for c in candidates if c.get("id")]
    has_content_ids: set[str] = set()
    if candidate_ids:
        content_rows = await async_directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "filter": {
                        "conversation_id": {"_in": candidate_ids},
                        "transcript": {"_nempty": True},
                    },
                    "aggregate": {"count": ["id"]},
                    "groupBy": ["conversation_id"],
                    # Directus caps grouped rows at its default limit (100).
                    "limit": -1,
                }
            },
        )
        # A non-list envelope is a Directus error, not "no content": surface
        # it instead of silently marking every conversation empty.
        if not isinstance(content_rows, list):
            raise HTTPException(
                status_code=503,
                detail="Could not check conversation content. Please try again.",
            )
        for row in content_rows:
            cid = row.get("conversation_id")
            if cid and int((row.get("count") or {}).get("id") or 0) > 0:
                has_content_ids.add(cid)

    # Bulk token counts for candidates that could still be added. Agentic
    # never reads these, so don't pay for them.
    token_counts_by_id: Dict[str, int] = {}
    if enforce_budget:
        need_tokens = [
            c["id"]
            for c in candidates
            if c.get("id")
            and c["id"] not in existing_ids
            and c["id"] in has_content_ids
            and not conversation_is_locked(c, workspace_tier)
        ]
        token_counts_by_id = await get_conversation_token_counts_bulk(
            need_tokens, auth, project_id=project_id
        )

    added: List[SelectAllConversationResult] = []
    skipped: List[SelectAllConversationResult] = list(extra_skipped or [])
    context_limit_reached = False
    to_attach: List[str] = []

    for conversation in candidates:
        conv_id = conversation.get("id")
        participant_name = str(conversation.get("participant_name") or "Unknown")

        if not conv_id:
            continue

        if conversation_is_locked(conversation, workspace_tier):
            skipped.append(
                SelectAllConversationResult(
                    conversation_id=conv_id,
                    participant_name=participant_name,
                    success=False,
                    reason="locked",
                )
            )
            continue

        # Skip if already in context
        if conv_id in existing_ids:
            skipped.append(
                SelectAllConversationResult(
                    conversation_id=conv_id,
                    participant_name=participant_name,
                    success=False,
                    reason="already_in_context",
                )
            )
            continue

        # Check if conversation has content
        if conv_id not in has_content_ids:
            skipped.append(
                SelectAllConversationResult(
                    conversation_id=conv_id,
                    participant_name=participant_name,
                    success=False,
                    reason="empty",
                )
            )
            continue

        if enforce_budget:
            # If context limit already reached, skip remaining conversations
            if context_limit_reached:
                skipped.append(
                    SelectAllConversationResult(
                        conversation_id=conv_id,
                        participant_name=participant_name,
                        success=False,
                        reason="context_limit_reached",
                    )
                )
                continue

            # Token count missing means the bulk compute failed for this id
            if conv_id not in token_counts_by_id:
                skipped.append(
                    SelectAllConversationResult(
                        conversation_id=conv_id,
                        participant_name=participant_name,
                        success=False,
                        reason="error",
                    )
                )
                continue

            token_count = token_counts_by_id.get(conv_id, 0)

            # Check if single conversation is too long
            if token_count > MAX_CHAT_CONTEXT_LENGTH:
                skipped.append(
                    SelectAllConversationResult(
                        conversation_id=conv_id,
                        participant_name=participant_name,
                        success=False,
                        reason="too_long",
                    )
                )
                continue

            # Check if adding this conversation would exceed the context limit
            conversation_usage = token_count / MAX_CHAT_CONTEXT_LENGTH
            if current_token_usage + conversation_usage > 1:
                context_limit_reached = True
                skipped.append(
                    SelectAllConversationResult(
                        conversation_id=conv_id,
                        participant_name=participant_name,
                        success=False,
                        reason="context_limit_reached",
                    )
                )
                continue

            current_token_usage += conversation_usage

        existing_ids.add(conv_id)
        to_attach.append(conv_id)

        added.append(
            SelectAllConversationResult(
                conversation_id=conv_id,
                participant_name=participant_name,
                success=True,
                reason="added",
            )
        )

    # Single bulk attach for everything accepted above.
    if to_attach:
        try:
            await run_in_thread_pool(chat_svc.attach_conversations, chat_id, to_attach)
        except Exception as exc:
            logger.warning("Bulk attach failed for chat %s: %s", chat_id, exc)
            added_snapshot = list(added)
            attach_failed = set(to_attach)
            added = [a for a in added if a.conversation_id not in attach_failed]
            skipped.extend(
                SelectAllConversationResult(
                    conversation_id=cid,
                    participant_name=next(
                        (a.participant_name for a in added_snapshot if a.conversation_id == cid),
                        "Unknown",
                    ),
                    success=False,
                    reason="error",
                )
                for cid in to_attach
            )

    return AddContextResponseSchema(
        added=added,
        skipped=skipped,
        total_processed=len(candidates) + len(extra_skipped or []),
        context_limit_reached=context_limit_reached,
    )


@ChatRouter.post("/{chat_id}/add-context", response_model=AddContextResponseSchema)
async def add_chat_context(
    chat_id: str,
    body: ChatAddContextSchema,
    auth: DependencyDirectusSession,
) -> AddContextResponseSchema:
    chat = await raise_if_chat_not_found_or_not_authorized(
        chat_id,
        auth,
        include_used_conversations=True,
    )
    _raise_if_project_mismatch(chat, body.project_id)

    chat_svc = chat_service
    conversation_svc = conversation_service

    project_id: Optional[str] = body.project_id or _chat_project_id(chat)

    options_provided = sum(
        [
            body.conversation_id is not None,
            body.conversation_ids is not None,
            body.select_all is not None,
        ]
    )

    if options_provided == 0:
        raise HTTPException(
            status_code=400,
            detail="One of conversation_id, conversation_ids or select_all is required",
        )

    if options_provided > 1:
        raise HTTPException(
            status_code=400,
            detail="Only one of conversation_id, conversation_ids or select_all can be provided",
        )

    # Handle select_all
    if body.select_all is True:
        if not project_id:
            raise HTTPException(
                status_code=400,
                detail="project_id is required when select_all is True",
            )

        try:
            logger.info(
                f"Select All: Fetching conversations - "
                f"project_id={project_id}, tags={body.tag_ids}, verified={body.verified_only}, search='{body.search_text}'"
            )

            all_conversations = await run_in_thread_pool(
                conversation_svc.list_by_project_with_filters,
                project_id=project_id,
                tag_ids=body.tag_ids,
                verified_only=body.verified_only or False,
                search_text=body.search_text,
                sort="-created_at",
                limit=MAX_ADD_CONTEXT_CONVERSATIONS,
            )

            logger.info(f"Select All: Fetched {len(all_conversations)} conversations")
        except Exception as e:
            logger.error(f"Failed to fetch conversations with filters: {e}")
            raise

        return await _attach_conversations_within_budget(
            chat_id=chat_id,
            chat=chat,
            auth=auth,
            project_id=project_id,
            candidates=all_conversations,
        )

    # An explicit pick, e.g. the conversations chosen on the Ask screen before
    # the chat existed. One request for the whole batch, so the token budget is
    # walked once and accumulates, instead of N parallel requests that each
    # read the same empty context and all pass.
    if body.conversation_ids is not None:
        if not project_id:
            raise HTTPException(
                status_code=400,
                detail="project_id is required when conversation_ids is provided",
            )

        requested_ids: List[str] = []
        for requested_id in body.conversation_ids:
            if requested_id and requested_id not in requested_ids:
                requested_ids.append(requested_id)

        if not requested_ids:
            raise HTTPException(
                status_code=400,
                detail="conversation_ids cannot be empty",
            )

        if len(requested_ids) > MAX_ADD_CONTEXT_CONVERSATIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot add more than {MAX_ADD_CONTEXT_CONVERSATIONS} conversations at once",
            )

        found = await run_in_thread_pool(
            conversation_svc.list_by_project_with_filters,
            project_id=project_id,
            conversation_ids=requested_ids,
            limit=len(requested_ids),
        )
        # The lookup is scoped to the chat's project, so anything missing here
        # belongs to another project or no longer exists. Report it instead of
        # dropping it silently. Order follows the host's pick, which is the
        # order the budget is then spent in.
        found_by_id = {
            conversation["id"]: conversation for conversation in found if conversation.get("id")
        }
        candidates = [
            found_by_id[requested_id]
            for requested_id in requested_ids
            if requested_id in found_by_id
        ]
        not_found = [
            SelectAllConversationResult(
                conversation_id=requested_id,
                participant_name="Unknown",
                success=False,
                reason="not_found",
            )
            for requested_id in requested_ids
            if requested_id not in found_by_id
        ]

        return await _attach_conversations_within_budget(
            chat_id=chat_id,
            chat=chat,
            auth=auth,
            project_id=project_id,
            candidates=candidates,
            extra_skipped=not_found,
        )

    if body.conversation_id is not None:
        try:
            await run_in_thread_pool(
                conversation_svc.get_by_id_or_raise,
                body.conversation_id,
                True,
                False,
            )
        except Exception as exc:
            raise HTTPException(status_code=404, detail="Conversation not found") from exc

        if project_id:
            await _check_conversation_not_locked(body.conversation_id, project_id)

        existing_ids = {
            (link.get("conversation_id") or {}).get("id")
            for link in (chat.get("used_conversations") or [])
        }
        if body.conversation_id in existing_ids:
            raise HTTPException(status_code=400, detail="Conversation already in the chat")

        # The transcript token budget only makes sense for deep_dive, which
        # preloads full transcripts into the context window. Agentic preloads
        # nothing: the attached rows are just a focus hint the agent reads on
        # demand, so gating them against MAX_CHAT_CONTEXT_LENGTH would reject
        # perfectly fine selections for no reason.
        if chat.get("chat_mode") != "agentic":
            token_count = await get_conversation_token_count(body.conversation_id, auth)
            if token_count > MAX_CHAT_CONTEXT_LENGTH:
                raise HTTPException(status_code=400, detail="Conversation is too long")

            chat_context = await get_chat_context(chat_id, auth)
            chat_context_token_usage = sum(
                conversation_entry.token_usage for conversation_entry in chat_context.conversations
            )

            conversation_to_add_usage = token_count / MAX_CHAT_CONTEXT_LENGTH
            if chat_context_token_usage + conversation_to_add_usage > 1:
                raise HTTPException(
                    status_code=400,
                    detail="Chat context is too long. Remove other conversations to proceed.",
                )

        await run_in_thread_pool(
            chat_svc.attach_conversations,
            chat_id,
            [body.conversation_id],
        )

        chat = await raise_if_chat_not_found_or_not_authorized(
            chat_id,
            auth,
            include_used_conversations=True,
        )

    return AddContextResponseSchema()


class ChatDeleteContextSchema(BaseModel):
    conversation_id: str


@ChatRouter.post("/{chat_id}/delete-context")
async def delete_chat_context(
    chat_id: str,
    body: ChatDeleteContextSchema,
    auth: DependencyDirectusSession,
) -> None:
    chat_svc = chat_service

    await raise_if_chat_not_found_or_not_authorized(chat_id, auth)
    chat_context = await get_chat_context(chat_id, auth)

    conversation_entry = next(
        (
            conversation_resource
            for conversation_resource in chat_context.conversations
            if conversation_resource.conversation_id == body.conversation_id
        ),
        None,
    )

    if conversation_entry is None:
        raise HTTPException(status_code=404, detail="Conversation not found in the chat")

    if conversation_entry.locked:
        raise HTTPException(status_code=400, detail="Conversation is locked")

    await run_in_thread_pool(
        chat_svc.detach_conversation,
        chat_id,
        body.conversation_id,
    )


@ChatRouter.post("/{chat_id}/lock-conversations", response_model=None)
async def lock_conversations(
    chat_id: str,
    auth: DependencyDirectusSession,
) -> List[dict]:
    await raise_if_chat_not_found_or_not_authorized(chat_id, auth)

    chat_svc = chat_service
    conversation_svc = conversation_service

    messages = await run_in_thread_pool(
        chat_svc.list_messages,
        chat_id,
        include_relationships=True,
        order="desc",
    )

    conversations_already_locked: set[str] = set()
    for message in messages:
        for relation in message.get("used_conversations") or []:
            conversation_ref = relation.get("conversation_id") or {}
            conv_id = conversation_ref.get("id")
            if conv_id:
                conversations_already_locked.add(conv_id)

    current_context = await get_chat_context(chat_id, auth)

    set_all_conversations = set(current_context.conversation_id_list)
    set_conversations_to_add = set_all_conversations - conversations_already_locked

    if set_conversations_to_add:
        added_count = len(set_conversations_to_add)
        message_text = (
            f"You added {added_count} conversations as context to the chat."
            if added_count > 1
            else "You added 1 conversation as context to the chat."
        )

        await run_in_thread_pool(
            chat_svc.create_message,
            chat_id,
            "dembrane",
            message_text,
            message_id=generate_uuid(),
            used_conversation_ids=set_conversations_to_add,
            added_conversation_ids=set_conversations_to_add,
        )

    used_conversations = await run_in_thread_pool(
        conversation_svc.list_by_ids,
        current_context.conversation_id_list,
        with_chunks=False,
        with_tags=True,
    )

    return used_conversations


class SuggestionSchema(BaseModel):
    """A single suggestion for the user."""

    icon: str  # "sparkles", "search", "quote", "lightbulb", "list"
    label: str  # Short 2-4 word label
    prompt: str  # Full question text


class SuggestionsResponseSchema(BaseModel):
    """Response from the suggestions endpoint."""

    suggestions: List[SuggestionSchema]


@ChatRouter.get("/{chat_id}/suggestions", response_model=SuggestionsResponseSchema)
async def get_chat_suggestions(
    chat_id: str,
    auth: DependencyDirectusSession,
    language: str = Query("en"),
) -> SuggestionsResponseSchema:
    """
    Get contextual question suggestions for a chat.

    Generates up to 3 suggestions based on:
    - Project context
    - Chat mode (overview vs deep_dive)
    - Recent conversation history
    - Last AI response (for follow-up suggestions)

    This endpoint is separate from /context since LLM calls may be slow.
    """
    from dembrane.suggestion_utils import Suggestion, generate_suggestions

    chat = await raise_if_chat_not_found_or_not_authorized(
        chat_id,
        auth,
        include_used_conversations=False,
    )

    chat_mode = chat.get("chat_mode")

    project_id = _chat_project_id(chat)

    if not project_id:
        logger.warning(f"No project_id found for chat {chat_id}")
        return SuggestionsResponseSchema(suggestions=[])

    # Rate limit by project_id: 10 requests per minute
    await suggestions_rate_limiter.check(project_id)

    try:
        suggestions: List[Suggestion] = await generate_suggestions(
            project_id=project_id,
            chat_id=chat_id,
            chat_mode=chat_mode,
            language=language,
        )

        return SuggestionsResponseSchema(
            suggestions=[
                SuggestionSchema(
                    icon=s.icon,
                    label=s.label,
                    prompt=s.prompt,
                )
                for s in suggestions
            ]
        )
    except Exception as e:
        logger.error(f"Failed to get suggestions for chat {chat_id}: {e}")
        return SuggestionsResponseSchema(suggestions=[])


class InitializeChatModeSchema(BaseModel):
    mode: Literal["overview", "deep_dive", "agentic"]
    project_id: str


class InitializeChatModeResponseSchema(BaseModel):
    chat_mode: Literal["overview", "deep_dive", "agentic"]
    conversations_added: int
    conversations_summarized: int
    message: str


@ChatRouter.post("/{chat_id}/initialize-mode", response_model=InitializeChatModeResponseSchema)
async def initialize_chat_mode(
    chat_id: str,
    body: InitializeChatModeSchema,
    auth: DependencyDirectusSession,
) -> InitializeChatModeResponseSchema:
    """
    Initialize the chat mode for a new chat.

    - overview: Auto-loads summaries for all conversations (most recent first)
    - deep_dive: Manual selection mode (default behavior)
    - agentic: Routes messaging through /api/agentic run APIs

    This can only be called once per chat. Mode cannot be changed after initialization.
    """
    from dembrane.summary_utils import (
        ensure_conversation_summaries,
        get_all_conversations_for_overview,
    )

    chat = await raise_if_chat_not_found_or_not_authorized(
        chat_id,
        auth,
        include_used_conversations=True,
    )
    _raise_if_project_mismatch(chat, body.project_id)

    # Check if mode is already set
    existing_mode = chat.get("chat_mode")
    if existing_mode is not None:
        raise HTTPException(
            status_code=400,
            detail=f"Chat mode is already set to '{existing_mode}'. Start a new chat to use a different mode.",
        )

    chat_svc = chat_service

    if body.mode == "deep_dive":
        # Deep dive mode: just set the mode, user will manually select conversations
        await run_in_thread_pool(chat_svc.set_chat_mode, chat_id, "deep_dive")
        return InitializeChatModeResponseSchema(
            chat_mode="deep_dive",
            conversations_added=0,
            conversations_summarized=0,
            message="Deep dive mode enabled. Select the conversations you want to analyze.",
        )

    if body.mode == "agentic":
        await run_in_thread_pool(chat_svc.set_chat_mode, chat_id, "agentic")
        return InitializeChatModeResponseSchema(
            chat_mode="agentic",
            conversations_added=0,
            conversations_summarized=0,
            message="Agentic mode enabled. Use the agentic run APIs for messaging.",
        )

    # Overview mode: Just set the mode - conversations will be fetched dynamically
    # when building the chat context (using summaries).
    # Pre-generate summaries for conversations that don't have them.
    conversations = await get_all_conversations_for_overview(body.project_id)

    # Filter to conversations with content (chunks)
    conversations_with_content = [
        conv for conv in conversations if int(conv.get("chunks_count", 0) or 0) > 0
    ]

    total_conversations = len(conversations_with_content)
    newly_summarized = 0

    if conversations_with_content:
        # Pre-generate summaries for conversations that don't have them
        conversation_ids = [conv["id"] for conv in conversations_with_content]
        summarization_result = await ensure_conversation_summaries(conversation_ids)
        newly_summarized = len(summarization_result.succeeded) - len(
            [c for c in conversations_with_content if c.get("summary")]
        )

    # Set chat mode
    await run_in_thread_pool(chat_svc.set_chat_mode, chat_id, "overview")

    if total_conversations == 0:
        return InitializeChatModeResponseSchema(
            chat_mode="overview",
            conversations_added=0,
            conversations_summarized=0,
            message="Overview mode enabled. No conversations found yet.",
        )

    return InitializeChatModeResponseSchema(
        chat_mode="overview",
        conversations_added=total_conversations,  # All conversations are included dynamically
        conversations_summarized=max(0, newly_summarized),
        message=f"Overview mode enabled with {total_conversations} conversations.",
    )


class ChatBodyMessageSchema(BaseModel):
    role: Literal["user", "assistant", "dembrane"]
    content: str


class ChatBodySchema(BaseModel):
    messages: List[ChatBodyMessageSchema]
    template_key: Optional[str] = None


@ChatRouter.post("/{chat_id}")
async def post_chat(
    chat_id: str,
    body: ChatBodySchema,
    auth: DependencyDirectusSession,
    protocol: str = Query("data"),
    language: str = Query("en"),
) -> StreamingResponse:
    chat = await raise_if_chat_not_found_or_not_authorized(
        chat_id,
        auth,
        include_used_conversations=True,
    )

    if chat.get("chat_mode") == "agentic":
        raise HTTPException(
            status_code=400,
            detail="Agentic chats must use /api/agentic endpoints",
        )

    chat_svc = chat_service

    project_id: Optional[str] = _chat_project_id(chat)

    if not project_id:
        raise HTTPException(status_code=500, detail="Chat is missing a project reference")

    # Matrix §8: chat is a host-side operation → Pilot hard-block.
    from dembrane.api.v2.middleware import check_no_pilot_block_for_project

    await check_no_pilot_block_for_project(str(project_id))

    # Free tier: max 3 user turns per chat. The 4th routes to upgrade.
    from dembrane.free_tier import (
        FREE_TIER_MAX_CHAT_USER_TURNS,
        is_free_tier,
        count_chat_user_turns,
        free_tier_limit_error,
    )

    if is_free_tier(await _resolve_workspace_tier(project_id)) and (
        await count_chat_user_turns(chat_id) >= FREE_TIER_MAX_CHAT_USER_TURNS
    ):
        raise free_tier_limit_error("chat_turns")

    user_message_content = body.messages[-1].content
    user_message_id = generate_uuid()

    await run_in_thread_pool(
        chat_svc.create_message,
        chat_id,
        "user",
        user_message_content,
        message_id=user_message_id,
    )

    try:
        # Run independent operations in parallel for better latency
        needs_title = not chat.get("name")
        parallel_tasks: List[Any] = [
            get_project_chat_history(chat_id),
            get_chat_context(chat_id, auth),
        ]
        if needs_title:
            parallel_tasks.append(generate_title(user_message_content, language))

        results = await asyncio.gather(*parallel_tasks)

        messages = results[0]
        chat_context = results[1]
        generated_title = results[2] if needs_title else None

        if len(messages) == 0:
            logger.debug("initializing chat")

        # DB writes can happen in parallel too (fire-and-forget style updates)
        write_tasks = []
        if generated_title:
            write_tasks.append(run_in_thread_pool(chat_svc.set_chat_name, chat_id, generated_title))
        if body.template_key is not None:
            write_tasks.append(
                run_in_thread_pool(
                    chat_svc.update_message,
                    user_message_id,
                    {"template_key": body.template_key},
                )
            )
        if write_tasks:
            await asyncio.gather(*write_tasks)

        conversation_history = [
            {"role": message["role"], "content": message["content"]}
            for message in messages
            if message["role"] in ["user", "assistant"]
        ]

        if (
            len(conversation_history) >= 2
            and conversation_history[-2]["role"] == "user"
            and conversation_history[-1]["role"] == "user"
            and conversation_history[-2]["content"] == conversation_history[-1]["content"]
        ):
            conversation_history = conversation_history[:-1]

        # Get chat mode for determining how to build context
        chat_mode = chat_context.chat_mode

        async def build_formatted_messages(conversation_ids: Iterable[str]) -> List[Dict[str, str]]:
            system_messages_result = await create_system_messages_for_chat(
                list(conversation_ids),
                language,
                project_id,
                chat_mode=chat_mode,  # Pass mode to determine summary vs transcript
            )
            formatted: List[Dict[str, str]] = []
            if isinstance(system_messages_result, list):
                formatted.extend(
                    {"role": "system", "content": message["text"]}
                    for message in system_messages_result
                )
            else:
                formatted.append({"role": "system", "content": system_messages_result})

            formatted.extend(conversation_history)
            return formatted

        formatted_messages = await build_formatted_messages(chat_context.conversation_id_list)

        # Resolve a distinct_id (email) so this server event merges with the
        # user's frontend person. This endpoint serves every non-agentic chat
        # (overview, deep_dive, and chats that predate chat_mode), so their
        # server-side response/error events live here. Agentic runs emit their
        # own from the agentic worker.
        from dembrane.app_user import resolve_app_user

        _chat_user = await resolve_app_user(auth.user_id)
        chat_distinct_id = ((_chat_user or {}).get("email") or "").lower() or auth.user_id

        async def stream_response_async(
            formatted: List[Dict[str, str]],
        ) -> AsyncGenerator[str, None]:
            try:
                response = await arouter_completion(
                    MODELS.MULTI_MODAL_PRO,
                    messages=formatted,
                    stream=True,
                    timeout=300,
                    stream_timeout=180,
                )
                async for chunk in response:
                    delta = chunk.choices[0].delta.content
                    if delta:
                        if protocol == "text":
                            yield delta
                        else:
                            yield f"0:{json.dumps(delta)}\n"
                await capture_event(
                    chat_distinct_id,
                    "server_chat_response_received",
                    {"chat_id": chat_id, "project_id": project_id, "mode": "context"},
                )
            except Exception as exc:  # pragma: no cover - runtime safeguard
                logger.error("Error in litellm stream response: %s", exc)
                await capture_event(
                    chat_distinct_id,
                    "server_chat_error",
                    {
                        "chat_id": chat_id,
                        "project_id": project_id,
                        "error_code": "STREAM_ERROR",
                        "message": str(exc)[:300],
                        "mode": "context",
                    },
                )
                await run_in_thread_pool(chat_svc.delete_message, user_message_id)
                if protocol == "text":
                    yield "Error: An error occurred while processing the chat response."
                else:
                    yield '3:"An error occurred while processing the chat response."\n'

        headers = {"Content-Type": "text/event-stream"}
        if protocol == "data":
            headers["x-vercel-ai-data-stream"] = "v1"

        raw_stream = stream_response_async(formatted_messages)

        # Wrap with status notifications for high load scenarios
        stream = stream_with_status(raw_stream, protocol=protocol)

        return StreamingResponse(stream, headers=headers)

    except Exception:
        # Ensure the user message does not linger on failure
        await run_in_thread_pool(chat_svc.delete_message, user_message_id)
        raise
