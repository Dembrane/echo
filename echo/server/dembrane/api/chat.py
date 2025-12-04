import json
import asyncio
import logging
from typing import Any, Dict, List, Literal, Iterable, Optional, AsyncGenerator

import litellm
from fastapi import Query, APIRouter, HTTPException
from pydantic import BaseModel
from litellm.utils import token_counter
from fastapi.responses import StreamingResponse

from dembrane.llms import get_completion_kwargs
from dembrane.utils import generate_uuid
from dembrane.prompts import render_prompt
from dembrane.service import (
    chat_service,
    conversation_service,
)
from dembrane.settings import get_settings
from dembrane.chat_utils import (
    CHAT_LLM,
    MAX_CHAT_CONTEXT_LENGTH,
    generate_title,
    get_project_chat_history,
    auto_select_conversations,
    create_system_messages_for_chat,
)
from dembrane.service.chat import ChatServiceException, ChatNotFoundException
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.rate_limit import create_rate_limiter
from dembrane.api.conversation import get_conversation_token_count
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
ENABLE_CHAT_AUTO_SELECT = settings.feature_flags.enable_chat_auto_select


async def is_followup_question(
    conversation_history: List[Dict[str, str]], language: str = "en"
) -> bool:
    """
    Determine if the current question is a follow-up to previous messages.
    Uses a small LLM call to check semantic relationship.

    Returns:
        True if it's a follow-up question, False if it's a new independent question
    """
    if len(conversation_history) < 2:
        # No previous context, can't be a follow-up
        return False

    # Take last 4 messages for context (2 exchanges)
    recent_messages = conversation_history[-4:]

    # Format messages for the prompt
    previous_messages = [
        {"role": msg["role"], "content": msg["content"]} for msg in recent_messages[:-1]
    ]
    current_question = recent_messages[-1]["content"]

    prompt = render_prompt(
        "is_followup_question",
        language,
        {
            "previous_messages": previous_messages,
            "current_question": current_question,
        },
    )

    try:
        response = await litellm.acompletion(
            messages=[{"role": "user", "content": prompt}],
            temperature=0,  # Deterministic
            timeout=60,  # 1 minute timeout for quick decision
            **get_completion_kwargs(CHAT_LLM),
        )

        result_text = response.choices[0].message.content.strip()
        result = json.loads(result_text)
        is_followup = result.get("is_followup", False)

        logger.info(f"Follow-up detection: {is_followup} for query: {current_question[:50]}...")
        return is_followup
    except Exception as e:
        logger.warning(f"Follow-up detection failed: {e}. Defaulting to False (run auto-select)")
        return False


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
    auto_select_bool: bool
    chat_mode: Optional[Literal["overview", "deep_dive"]] = None  # None = not yet selected


async def raise_if_chat_not_found_or_not_authorized(
    chat_id: str,
    auth_session: DirectusSession,
    *,
    include_used_conversations: bool = False,
) -> dict:
    # Always use the global (admin) chat_service for reads here.
    # Authorization is checked manually below (project owner vs user_id).
    # Using user-scoped Directus client would cause junction table data
    # (e.g., used_conversations) to be filtered by Directus permissions,
    # leading to inconsistencies where writes succeed but reads return empty.
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

    project_owner: Optional[str] = None
    project_info = chat.get("project_id")
    if isinstance(project_info, dict):
        project_owner = project_info.get("directus_user_id")

    if not auth_session.is_admin and project_owner != auth_session.user_id:
        logger.debug(
            "Chat %s not authorized for user %s (owner=%s)",
            chat_id,
            auth_session.user_id,
            project_owner,
        )
        raise HTTPException(status_code=403, detail="You are not authorized to access this chat")

    return chat


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
                tokens_count = token_counter(
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

    auto_select_value = chat.get("auto_select")
    if auto_select_value is None:
        raise HTTPException(status_code=400, detail="Auto select is not boolean")

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
        auto_select_bool=bool(auto_select_value),
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

    # Fetch all token counts in parallel
    if conversation_metadata:
        token_count_tasks = [
            get_conversation_token_count(conv_id, auth) for conv_id, _, _ in conversation_metadata
        ]
        token_counts = await asyncio.gather(*token_count_tasks)
    else:
        token_counts = []

    # Build context objects with the fetched data
    for (conversation_id, participant_name, is_locked), token_count in zip(
        conversation_metadata, token_counts, strict=True
    ):
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
    auto_select_bool: Optional[bool] = None


@ChatRouter.post("/{chat_id}/add-context")
async def add_chat_context(
    chat_id: str,
    body: ChatAddContextSchema,
    auth: DependencyDirectusSession,
) -> None:
    chat = await raise_if_chat_not_found_or_not_authorized(
        chat_id,
        auth,
        include_used_conversations=True,
    )

    chat_svc = chat_service
    conversation_svc = conversation_service

    if body.conversation_id is None and body.auto_select_bool is None:
        raise HTTPException(
            status_code=400, detail="conversation_id or auto_select_bool is required"
        )

    if body.conversation_id is not None and body.auto_select_bool is not None:
        raise HTTPException(
            status_code=400, detail="conversation_id and auto_select_bool cannot both be provided"
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

        existing_ids = {
            (link.get("conversation_id") or {}).get("id")
            for link in (chat.get("used_conversations") or [])
        }
        if body.conversation_id in existing_ids:
            raise HTTPException(status_code=400, detail="Conversation already in the chat")

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

    if body.auto_select_bool is not None:
        await run_in_thread_pool(chat_svc.set_auto_select, chat_id, body.auto_select_bool)


class ChatDeleteContextSchema(BaseModel):
    conversation_id: Optional[str] = None
    auto_select_bool: Optional[bool] = None


@ChatRouter.post("/{chat_id}/delete-context")
async def delete_chat_context(
    chat_id: str,
    body: ChatDeleteContextSchema,
    auth: DependencyDirectusSession,
) -> None:
    chat_svc = chat_service

    await raise_if_chat_not_found_or_not_authorized(chat_id, auth)
    if body.conversation_id is None and body.auto_select_bool is None:
        raise HTTPException(
            status_code=400, detail="conversation_id or auto_select_bool is required"
        )

    if body.conversation_id is not None and body.auto_select_bool is not None:
        raise HTTPException(
            status_code=400, detail="conversation_id and auto_select_bool cannot both be provided"
        )

    if body.auto_select_bool is True:
        raise HTTPException(status_code=400, detail="auto_select_bool cannot be True")

    if body.conversation_id is not None:
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

    if body.auto_select_bool is not None:
        await run_in_thread_pool(chat_svc.set_auto_select, chat_id, body.auto_select_bool)


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

    # Get project_id from nested object
    project_id_obj = chat.get("project_id")
    if isinstance(project_id_obj, dict):
        project_id = project_id_obj.get("id")
    else:
        project_id = project_id_obj

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
    mode: Literal["overview", "deep_dive"]
    project_id: str


class InitializeChatModeResponseSchema(BaseModel):
    chat_mode: Literal["overview", "deep_dive"]
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

    chat_svc = chat_service
    conversation_svc = conversation_service

    project_info = chat.get("project_id")
    project_id: Optional[str]
    if isinstance(project_info, dict):
        project_id = project_info.get("id")
    else:
        project_id = project_info  # directus may return an ID string

    if not project_id:
        raise HTTPException(status_code=500, detail="Chat is missing a project reference")

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
        locked_conversation_id_list = chat_context.locked_conversation_id_list

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

        conversations_added_ids: List[str] = []
        conversation_references: dict[str, List[Dict[str, str]]] = {"references": []}

        formatted_messages: List[Dict[str, str]]
        should_reuse_locked = False
        if locked_conversation_id_list:
            should_reuse_locked = await is_followup_question(conversation_history, language)

        if (
            ENABLE_CHAT_AUTO_SELECT
            and chat_context.auto_select_bool
            and not should_reuse_locked
            and conversation_history
        ):
            query = conversation_history[-1]["content"]

            logger.info(f"Calling auto_select_conversations with query: {query}")
            auto_select_result = await auto_select_conversations(
                user_query_inputs=[query],
                project_id_list=[project_id],
                language=language,
            )

            logger.info("Auto-select result: %s", auto_select_result)

            selected_conversation_ids: List[str] = []
            if "results" in auto_select_result:
                for proj_result in auto_select_result["results"].values():
                    selected_conversation_ids.extend(proj_result.get("conversation_id_list", []))

            existing_conversation_ids = set(chat_context.conversation_id_list)
            max_context_threshold = int(MAX_CHAT_CONTEXT_LENGTH * 0.8)

            for conversation_id in selected_conversation_ids:
                if (
                    conversation_id in existing_conversation_ids
                    or conversation_id in conversations_added_ids
                ):
                    continue

                temp_ids = (
                    chat_context.conversation_id_list + conversations_added_ids + [conversation_id]
                )
                candidate_messages = await build_formatted_messages(temp_ids)
                prompt_len = token_counter(
                    messages=candidate_messages,
                    model=get_completion_kwargs(CHAT_LLM)["model"],
                )

                if prompt_len > max_context_threshold:
                    logger.info(
                        "Reached 80%% context threshold (%s/%s tokens). Stopping conversation addition.",
                        prompt_len,
                        max_context_threshold,
                    )
                    break

                await run_in_thread_pool(
                    chat_svc.attach_conversations,
                    chat_id,
                    [conversation_id],
                )
                conversations_added_ids.append(conversation_id)
                existing_conversation_ids.add(conversation_id)

            if conversations_added_ids:
                await run_in_thread_pool(
                    chat_svc.create_message,
                    chat_id,
                    "dembrane",
                    text=f"Auto-selected and added {len(conversations_added_ids)} conversations as context to the chat.",
                    message_id=generate_uuid(),
                    used_conversation_ids=conversations_added_ids,
                    added_conversation_ids=conversations_added_ids,
                )

            updated_context = await get_chat_context(chat_id, auth)
            formatted_messages = await build_formatted_messages(
                updated_context.conversation_id_list
            )

            prompt_len = token_counter(
                messages=formatted_messages,
                model=get_completion_kwargs(CHAT_LLM)["model"],
            )
            if prompt_len > MAX_CHAT_CONTEXT_LENGTH:
                raise HTTPException(
                    status_code=400,
                    detail="Auto select returned too many conversations. The selected conversations exceed the maximum context length.",
                )

            if conversations_added_ids:
                added_details = await run_in_thread_pool(
                    conversation_svc.list_by_ids,
                    conversations_added_ids,
                    with_chunks=False,
                    with_tags=False,
                )
                conversation_references["references"] = [
                    {
                        "conversation": item.get("id", ""),
                        "conversation_title": str(item.get("participant_name") or ""),
                    }
                    for item in added_details
                ]
        else:
            formatted_messages = await build_formatted_messages(chat_context.conversation_id_list)

        async def stream_response_async(
            formatted: List[Dict[str, str]],
            references: Optional[dict[str, List[Dict[str, str]]]] = None,
        ) -> AsyncGenerator[str, None]:
            if references is not None:
                header_payload = f"h:{json.dumps([references])}\n"
                yield header_payload

            try:
                response = await litellm.acompletion(
                    messages=formatted,
                    stream=True,
                    timeout=300,
                    stream_timeout=180,
                    **get_completion_kwargs(CHAT_LLM),
                )
                async for chunk in response:
                    delta = chunk.choices[0].delta.content
                    if delta:
                        if protocol == "text":
                            yield delta
                        else:
                            yield f"0:{json.dumps(delta)}\n"
            except Exception as exc:  # pragma: no cover - runtime safeguard
                logger.error("Error in litellm stream response: %s", exc)
                await run_in_thread_pool(chat_svc.delete_message, user_message_id)
                if protocol == "text":
                    yield "Error: An error occurred while processing the chat response."
                else:
                    yield '3:"An error occurred while processing the chat response."\n'

        headers = {"Content-Type": "text/event-stream"}
        if protocol == "data":
            headers["x-vercel-ai-data-stream"] = "v1"

        if conversations_added_ids and conversation_references["references"]:
            stream = stream_response_async(formatted_messages, conversation_references)
        else:
            stream = stream_response_async(formatted_messages)

        return StreamingResponse(stream, headers=headers)

    except Exception:
        # Ensure the user message does not linger on failure
        await run_in_thread_pool(chat_svc.delete_message, user_message_id)
        raise
