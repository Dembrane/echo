# TODO:
# - Change db calls to directus calls
# - Change anthropic api to litellm

import json
import logging
from typing import Any, Dict, List, Literal, Optional, AsyncGenerator

import litellm
from fastapi import Query, APIRouter, HTTPException
from litellm import token_counter  # type: ignore
from pydantic import BaseModel
from fastapi.responses import StreamingResponse

from dembrane.utils import generate_uuid, get_utc_timestamp
from dembrane.config import (
    SMALL_LITELLM_MODEL,
    SMALL_LITELLM_API_KEY,
    SMALL_LITELLM_API_BASE,
    ENABLE_CHAT_AUTO_SELECT,
    LIGHTRAG_LITELLM_INFERENCE_MODEL,
    LIGHTRAG_LITELLM_INFERENCE_API_KEY,
    LIGHTRAG_LITELLM_INFERENCE_API_BASE,
    LIGHTRAG_LITELLM_INFERENCE_API_VERSION,
)
from dembrane.prompts import render_prompt
from dembrane.database import (
    DatabaseSession,
    ProjectChatModel,
    ConversationModel,
    ProjectChatMessageModel,
    DependencyInjectDatabase,
)
from dembrane.directus import directus
from dembrane.chat_utils import (
    MAX_CHAT_CONTEXT_LENGTH,
    generate_title,
    get_project_chat_history,
    auto_select_conversations,
    create_system_messages_for_chat,
)
from dembrane.quote_utils import count_tokens
from dembrane.api.conversation import get_conversation_token_count
from dembrane.api.dependency_auth import DirectusSession, DependencyDirectusSession
from dembrane.audio_lightrag.utils.lightrag_utils import get_project_id

ChatRouter = APIRouter(tags=["chat"])

logger = logging.getLogger("dembrane.chat")


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
            model=SMALL_LITELLM_MODEL,
            api_key=SMALL_LITELLM_API_KEY,
            api_base=SMALL_LITELLM_API_BASE,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,  # Deterministic
            timeout=60,  # 1 minute timeout for quick decision
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


def raise_if_chat_not_found_or_not_authorized(chat_id: str, auth_session: DirectusSession) -> None:
    chat_directus = directus.get_items(
        "project_chat",
        {
            "query": {
                "filter": {"id": {"_eq": chat_id}},
                "fields": ["project_id.directus_user_id"],
            },
        },
    )

    if chat_directus is None:
        logger.debug("Chat directus not found")
        raise HTTPException(status_code=404, detail="Chat not found")

    # access is denied only if the user is both not an admin AND not the project owner.
    if (not auth_session.is_admin) and (
        not chat_directus[0]["project_id"]["directus_user_id"] == auth_session.user_id
    ):
        logger.debug(
            f"Chat not authorized. is_admin={auth_session.is_admin} and user_id={auth_session.user_id} and chat_directus_user_id = {chat_directus[0]['project_id']['directus_user_id']}"
        )
        raise HTTPException(status_code=403, detail="You are not authorized to access this chat")


@ChatRouter.get("/{chat_id}/context", response_model=ChatContextSchema)
async def get_chat_context(
    chat_id: str, db: DependencyInjectDatabase, auth: DependencyDirectusSession
) -> ChatContextSchema:
    raise_if_chat_not_found_or_not_authorized(chat_id, auth)

    chat = db.get(ProjectChatModel, chat_id)

    if chat is None:
        # i still have to check for this because: mypy
        raise HTTPException(status_code=404, detail="Chat not found")

    messages = (
        db.query(ProjectChatMessageModel)
        .filter(ProjectChatMessageModel.project_chat_id == chat_id)
        .all()
    )

    # conversation is locked when any chat message is using a conversation
    locked_conversations = set()
    for message in messages:
        for conversation in message.used_conversations:
            locked_conversations.add(conversation.id)  # Add directus call here

    user_message_token_count = 0
    assistant_message_token_count = 0

    for message in messages:
        if message.message_from in ["user", "assistant"]:
            # if tokens_count is not set, set it
            if message.tokens_count is None:
                message.tokens_count = count_tokens(message.text)
                db.commit()

            if message.message_from == "user":
                user_message_token_count += message.tokens_count
            elif message.message_from == "assistant":
                assistant_message_token_count += message.tokens_count

    used_conversations = chat.used_conversations

    if chat.auto_select_bool is None:
        raise HTTPException(status_code=400, detail="Auto select is not boolean")

    # initialize response
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
        auto_select_bool=chat.auto_select_bool,
    )

    for conversation in used_conversations:
        is_conversation_locked = conversation.id in locked_conversations  # Verify with directus
        chat_context_resource = ChatContextConversationSchema(
            conversation_id=conversation.id,
            conversation_participant_name=conversation.participant_name,
            locked=is_conversation_locked,
            # TODO: if quotes for this convo are present then just use RAG
            token_usage=(
                await get_conversation_token_count(conversation.id, db, auth)
                / MAX_CHAT_CONTEXT_LENGTH
            ),
        )
        context.conversations.append(chat_context_resource)
        context.conversation_id_list.append(conversation.id)
        if is_conversation_locked:
            context.locked_conversation_id_list.append(conversation.id)

    return context


class ChatAddContextSchema(BaseModel):
    conversation_id: Optional[str] = None
    auto_select_bool: Optional[bool] = None


@ChatRouter.post("/{chat_id}/add-context")
async def add_chat_context(
    chat_id: str,
    body: ChatAddContextSchema,
    db: DependencyInjectDatabase,
    auth: DependencyDirectusSession,
) -> None:
    raise_if_chat_not_found_or_not_authorized(chat_id, auth)

    if body.conversation_id is None and body.auto_select_bool is None:
        raise HTTPException(
            status_code=400, detail="conversation_id or auto_select_bool is required"
        )

    if body.conversation_id is not None and body.auto_select_bool is not None:
        raise HTTPException(
            status_code=400, detail="conversation_id and auto_select_bool cannot both be provided"
        )

    chat = db.get(ProjectChatModel, chat_id)

    if chat is None:
        raise HTTPException(status_code=404, detail="Chat not found")

    if body.conversation_id is not None:
        conversation = db.get(ConversationModel, body.conversation_id)

        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")

        # check if the conversation is already in the chat
        for i_conversation in chat.used_conversations:
            if i_conversation.id == conversation.id:
                raise HTTPException(status_code=400, detail="Conversation already in the chat")

        # check if the conversation is too long
        if await get_conversation_token_count(conversation.id, db, auth) > MAX_CHAT_CONTEXT_LENGTH:
            raise HTTPException(status_code=400, detail="Conversation is too long")

        # sum of all other conversations
        chat_context = await get_chat_context(chat_id, db, auth)
        chat_context_token_usage = sum(
            conversation.token_usage for conversation in chat_context.conversations
        )

        conversation_to_add_token_usage = (
            await get_conversation_token_count(conversation.id, db, auth) / MAX_CHAT_CONTEXT_LENGTH
        )
        if chat_context_token_usage + conversation_to_add_token_usage > 1:
            raise HTTPException(
                status_code=400,
                detail="Chat context is too long. Remove other conversations to proceed.",
            )
        chat.used_conversations.append(conversation)
        db.commit()

    if body.auto_select_bool is not None:
        chat.auto_select_bool = body.auto_select_bool
        db.commit()


class ChatDeleteContextSchema(BaseModel):
    conversation_id: Optional[str] = None
    auto_select_bool: Optional[bool] = None


@ChatRouter.post("/{chat_id}/delete-context")
async def delete_chat_context(
    chat_id: str,
    body: ChatDeleteContextSchema,
    db: DependencyInjectDatabase,
    auth: DependencyDirectusSession,
) -> None:
    raise_if_chat_not_found_or_not_authorized(chat_id, auth)
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

    chat = db.get(ProjectChatModel, chat_id)

    if chat is None:
        raise HTTPException(status_code=404, detail="Chat not found")

    if body.conversation_id is not None:
        conversation = db.get(ConversationModel, body.conversation_id)

        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")

        chat_context = await get_chat_context(chat_id, db, auth)

        # check if conversation exists in chat_context
        for project_chat_conversation in chat_context.conversations:
            if project_chat_conversation.conversation_id == conversation.id:
                if project_chat_conversation.locked:
                    raise HTTPException(status_code=400, detail="Conversation is locked")
                else:
                    chat.used_conversations.remove(conversation)
                    db.commit()
                    return

        raise HTTPException(status_code=404, detail="Conversation not found in the chat")

    if body.auto_select_bool is not None:
        chat.auto_select_bool = body.auto_select_bool
        db.commit()


@ChatRouter.post("/{chat_id}/lock-conversations", response_model=None)
async def lock_conversations(
    chat_id: str,
    db: DependencyInjectDatabase,
    auth: DependencyDirectusSession,
) -> List[ConversationModel]:
    raise_if_chat_not_found_or_not_authorized(chat_id, auth)

    db_messages = (
        db.query(ProjectChatMessageModel)
        .filter(ProjectChatMessageModel.project_chat_id == chat_id)
        .order_by(ProjectChatMessageModel.date_created.desc())
        .all()
    )

    set_conversations_already_in_chat = set()

    for message in db_messages:
        if message.used_conversations:
            for conversation in message.used_conversations:
                set_conversations_already_in_chat.add(conversation.id)

    current_context = await get_chat_context(chat_id, db, auth)

    set_all_conversations = set(current_context.conversation_id_list)
    set_conversations_to_add = set_all_conversations - set_conversations_already_in_chat

    if len(set_conversations_to_add) > 0:
        # Fetch ConversationModel objects for added_conversations
        added_conversations = (
            db.query(ConversationModel)
            .filter(ConversationModel.id.in_(set_conversations_to_add))
            .all()
        )

        dembrane_search_complete_message = ProjectChatMessageModel(
            id=generate_uuid(),
            date_created=get_utc_timestamp(),
            message_from="dembrane",
            text=f"You added {len(set_conversations_to_add)} conversations as context to the chat.",
            project_chat_id=chat_id,
            used_conversations=added_conversations,
            added_conversations=added_conversations,
        )
        db.add(dembrane_search_complete_message)
        db.commit()

    # Fetch ConversationModel objects for used_conversations
    used_conversations = (
        db.query(ConversationModel)
        .filter(ConversationModel.id.in_(current_context.conversation_id_list))
        .all()
    )

    return used_conversations


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
    db: DependencyInjectDatabase,
    auth: DependencyDirectusSession,
    protocol: str = Query("data"),
    language: str = Query("en"),
) -> StreamingResponse:  # ignore: type
    """
    Handle a chat interaction: persist the user's message, optionally generate a title, and stream an LLM-generated response.
    This endpoint records the incoming user message into the chat, may asynchronously generate and persist a chat title if missing, and then produces a streaming response from the configured LLM. Two generation modes are supported:
    - Auto-select (when enabled for the chat): builds a RAG prompt, retrieves conversation references and citations, and streams the model output.
    - Manual-select: builds system messages from locked conversations and streams the model output.
    Side effects:
    - Persists a new ProjectChatMessageModel for the user message.
    - May update the chat name and the message's template key.
    - On generation failure the in-flight user message is deleted.
    Parameters:
    - chat_id: ID of the target chat (used to validate access and load context).
    - body: ChatBodySchema containing the messages (the last user message is used as the prompt) and optional template_key.
    - protocol: Response protocol; "data" (default) yields structured data frames, "text" yields raw text chunks.
    - language: Language code used for title generation and system message creation.
    Returns:
    - StreamingResponse that yields streamed model content and, in auto-select mode, header payloads containing conversation references and citations.
    Raises:
    - HTTPException: 404 if the chat (or required conversation data) is not found; 400 when auto-select cannot satisfy context-length constraints or request validation fails.
    """
    raise_if_chat_not_found_or_not_authorized(chat_id, auth)

    chat = db.get(ProjectChatModel, chat_id)

    if chat is None:
        raise HTTPException(status_code=404, detail="Chat not found")

    """
    Put longform data at the top: 
    Place your long documents and inputs (~20K+ tokens) near the top of your prompt, above your query, instructions, and examples. 
    This can significantly improve performance across all models.
    """

    user_message = ProjectChatMessageModel(
        id=generate_uuid(),
        date_created=get_utc_timestamp(),
        message_from="user",
        text=body.messages[-1].content,
        project_chat_id=chat.id,
    )

    db.add(user_message)
    db.commit()

    try:
        if chat.name is None:
            chat.name = await generate_title(body.messages[-1].content, language)
            db.commit()
    except Exception as e:
        logger.warning(f"Error generating title: {str(e)}")

    try:
        logger.debug("checking if user submitted template key")
        if body.template_key is not None:
            logger.debug(f"updating template key to: {body.template_key}")
            directus.update_item(
                "project_chat_message", user_message.id, {"template_key": body.template_key}
            )
    except Exception as e:
        logger.error(f"Error updating template key: {str(e)}")

    project_id = get_project_id(chat.id)  # TODO: Write directus call here

    messages = get_project_chat_history(chat_id, db)

    if len(messages) == 0:
        logger.debug("initializing chat")

    chat_context = await get_chat_context(chat_id, db, auth)

    locked_conversation_id_list = chat_context.locked_conversation_id_list  # Verify with directus

    logger.debug(f"ENABLE_CHAT_AUTO_SELECT: {ENABLE_CHAT_AUTO_SELECT}")
    logger.debug(f"chat_context.auto_select_bool: {chat_context.auto_select_bool}")
    if ENABLE_CHAT_AUTO_SELECT and chat_context.auto_select_bool:
        filtered_messages: List[Dict[str, Any]] = []
        for message in messages:
            if message["role"] in ["user", "assistant"]:
                filtered_messages.append(message)
        if (
            len(filtered_messages) >= 2
            and filtered_messages[-2]["role"] == "user"
            and filtered_messages[-1]["role"] == "user"
            and filtered_messages[-2]["content"] == filtered_messages[-1]["content"]
        ):
            filtered_messages = filtered_messages[:-1]

        query = filtered_messages[-1]["content"]
        conversation_history = filtered_messages

        # Track newly added conversations for displaying in the frontend
        conversations_added: list[ConversationModel] = []

        # Check if this is a follow-up question (only if we have locked conversations)
        should_reuse_locked = False
        if locked_conversation_id_list:
            is_followup = await is_followup_question(conversation_history, language)
            if is_followup:
                logger.info("Detected follow-up question - reusing locked conversations")
                should_reuse_locked = True
            else:
                logger.info("New independent question - running auto-select")

        if should_reuse_locked:
            # Reuse existing locked conversations for follow-up questions
            updated_conversation_id_list = locked_conversation_id_list

            system_messages = await create_system_messages_for_chat(
                updated_conversation_id_list, db, language, project_id
            )

            formatted_messages = []
            if isinstance(system_messages, list):
                for msg in system_messages:
                    formatted_messages.append({"role": "system", "content": msg["text"]})
                formatted_messages.extend(conversation_history)
            else:
                formatted_messages = [
                    {"role": "system", "content": system_messages}
                ] + conversation_history

            # Check context length
            prompt_len = token_counter(
                model=LIGHTRAG_LITELLM_INFERENCE_MODEL, messages=formatted_messages
            )

            if prompt_len > MAX_CHAT_CONTEXT_LENGTH:
                raise HTTPException(
                    status_code=400,
                    detail="The conversation context with the new message exceeds the maximum context length.",
                )
        else:
            # Run auto-select for first query or new independent questions
            user_query_inputs = [query]

            logger.info(f"Calling auto_select_conversations with query: {query}")
            auto_select_result = await auto_select_conversations(
                user_query_inputs=user_query_inputs,
                project_id_list=[project_id],
                db=db,
                language=language,
            )

            logger.info(f"Auto-select result: {auto_select_result}")

            # Extract selected conversation IDs
            selected_conversation_ids = []
            if "results" in auto_select_result:
                for proj_result in auto_select_result["results"].values():
                    if "conversation_id_list" in proj_result:
                        selected_conversation_ids.extend(proj_result["conversation_id_list"])

            # Add selected conversations to chat context
            conversations_added = []
            for conversation_id in selected_conversation_ids:
                conversation = db.get(ConversationModel, conversation_id)
                if conversation and conversation not in chat.used_conversations:
                    chat.used_conversations.append(conversation)
                    conversations_added.append(conversation)

            # Create a message to lock the auto-selected conversations
            if conversations_added:
                auto_select_message = ProjectChatMessageModel(
                    id=generate_uuid(),
                    date_created=get_utc_timestamp(),
                    message_from="dembrane",
                    text=f"Auto-selected and added {len(conversations_added)} conversations as context to the chat.",
                    project_chat_id=chat_id,
                    used_conversations=conversations_added,
                )
                db.add(auto_select_message)
                db.commit()
                logger.info(f"Added {len(conversations_added)} conversations via auto-select")

            # Get updated chat context
            updated_chat_context = await get_chat_context(chat_id, db, auth)
            updated_conversation_id_list = updated_chat_context.conversation_id_list

            # Build system messages from the selected conversations
            system_messages = await create_system_messages_for_chat(
                updated_conversation_id_list, db, language, project_id
            )

            # Build messages to send
            formatted_messages = []
            if isinstance(system_messages, list):
                for msg in system_messages:
                    formatted_messages.append({"role": "system", "content": msg["text"]})
                formatted_messages.extend(conversation_history)
            else:
                formatted_messages = [
                    {"role": "system", "content": system_messages}
                ] + conversation_history

            # Check context length
            prompt_len = token_counter(
                model=LIGHTRAG_LITELLM_INFERENCE_MODEL, messages=formatted_messages
            )

            if prompt_len > MAX_CHAT_CONTEXT_LENGTH:
                raise HTTPException(
                    status_code=400,
                    detail="Auto select returned too many conversations. The selected conversations exceed the maximum context length.",
                )

        # Build references list from ONLY newly added conversations (not all conversations)
        conversation_references: dict[str, list[dict[str, str]]] = {"references": []}
        # Only include conversations that were just added via auto-select
        for conv in conversations_added:
            conversation_references["references"].append(
                {
                    "conversation": conv.id,
                    "conversation_title": conv.participant_name,
                }
            )

        logger.info(f"Newly added conversations for frontend: {conversation_references}")

        async def stream_response_async_autoselect() -> AsyncGenerator[str, None]:
            # Send conversation references (selected conversations)
            conversation_references_yeild = f"h:{json.dumps([conversation_references])}\n"
            yield conversation_references_yeild

            accumulated_response = ""
            try:
                response = await litellm.acompletion(
                    model=LIGHTRAG_LITELLM_INFERENCE_MODEL,
                    api_key=LIGHTRAG_LITELLM_INFERENCE_API_KEY,
                    api_version=LIGHTRAG_LITELLM_INFERENCE_API_VERSION,
                    api_base=LIGHTRAG_LITELLM_INFERENCE_API_BASE,
                    messages=formatted_messages,
                    stream=True,
                    timeout=300,  # 5 minute timeout for response
                    stream_timeout=180,  # 3 minute timeout for streaming
                    # mock_response="It's simple to use and easy to get started",
                )
                async for chunk in response:
                    if chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        accumulated_response += content
                        if protocol == "text":
                            yield content
                        elif protocol == "data":
                            yield f"0:{json.dumps(content)}\n"
            except Exception as e:
                logger.error(f"Error in litellm stream response: {str(e)}")
                # delete user message if stream fails
                with DatabaseSession() as error_db:
                    error_db.delete(user_message)
                    error_db.commit()

                if protocol == "data":
                    yield '3:"An error occurred while processing the chat response."\n'
                else:
                    yield "Error: An error occurred while processing the chat response."
                return  # Stop generation on error

        headers = {"Content-Type": "text/event-stream"}
        if protocol == "data":
            headers["x-vercel-ai-data-stream"] = "v1"
        response = StreamingResponse(stream_response_async_autoselect(), headers=headers)
        return response
    else:
        system_messages = await create_system_messages_for_chat(
            locked_conversation_id_list, db, language, project_id
        )

        async def stream_response_async_manualselect() -> AsyncGenerator[str, None]:
            """
            Asynchronously stream a model-generated assistant response for the manual-selection chat path.

            Builds the outgoing message sequence by combining provided system messages (list or string) with recent user/assistant messages, removes a duplicated trailing user message if present, then calls the Litellm streaming completion API and yields text chunks as they arrive.

            Yields:
                - If protocol == "text": successive raw text fragments from the model.
                - If protocol == "data": framed data lines of the form `0:<json>` for each fragment.
                - On generation error: a single error payload matching the active protocol (`"Error: ..." ` for text, or `3:"..."` for data).

            Side effects:
                - On an exception during generation, deletes the in-flight `user_message` from the database and commits the change.

            Notes:
                - Expects surrounding scope variables: `messages`, `system_messages`, `litellm`, model/API constants, `protocol`, `user_message`, and `logger`.
                - Returns when the stream completes.
            """
            with DatabaseSession() as db:
                filtered_messages: List[Dict[str, Any]] = []

                for message in messages:
                    if message["role"] in ["user", "assistant"]:
                        filtered_messages.append(message)

                # Remove duplicate consecutive user messages but preserve conversation flow
                if (
                    len(filtered_messages) >= 2
                    and filtered_messages[-2]["role"] == "user"
                    and filtered_messages[-1]["role"] == "user"
                    and filtered_messages[-2]["content"] == filtered_messages[-1]["content"]
                ):
                    filtered_messages = filtered_messages[:-1]

                try:
                    accumulated_response = ""

                    # Check message token count and add padding if needed
                    # Handle system_messages whether it's a list or string
                    if isinstance(system_messages, list):
                        messages_to_send = []
                        for msg in system_messages:
                            messages_to_send.append({"role": "system", "content": msg["text"]})
                        messages_to_send.extend(filtered_messages)
                    else:
                        messages_to_send = [
                            {"role": "system", "content": system_messages}
                        ] + filtered_messages

                    logger.debug(f"messages_to_send: {messages_to_send}")
                    response = await litellm.acompletion(
                        model=LIGHTRAG_LITELLM_INFERENCE_MODEL,
                        api_key=LIGHTRAG_LITELLM_INFERENCE_API_KEY,
                        api_version=LIGHTRAG_LITELLM_INFERENCE_API_VERSION,
                        api_base=LIGHTRAG_LITELLM_INFERENCE_API_BASE,
                        messages=messages_to_send,
                        stream=True,
                        timeout=300,  # 5 minute timeout for response
                        stream_timeout=180,  # 3 minute timeout for streaming
                    )
                    async for chunk in response:
                        if chunk.choices[0].delta.content:
                            content = chunk.choices[0].delta.content
                            accumulated_response += content
                            if protocol == "text":
                                yield content
                            elif protocol == "data":
                                yield f"0:{json.dumps(content)}\n"
                except Exception as e:
                    logger.error(f"Error in litellm stream response: {str(e)}")

                    # delete user message
                    db.delete(user_message)
                    db.commit()

                    if protocol == "data":
                        yield '3:"An error occurred while processing the chat response."\n'
                    else:
                        yield "Error: An error occurred while processing the chat response."

            return

        headers = {"Content-Type": "text/event-stream"}
        if protocol == "data":
            headers["x-vercel-ai-data-stream"] = "v1"

        response = StreamingResponse(stream_response_async_manualselect(), headers=headers)

        return response
