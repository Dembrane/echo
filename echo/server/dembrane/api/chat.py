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
    ENABLE_CHAT_AUTO_SELECT,
    AUDIO_LIGHTRAG_TOP_K_PROMPT,
    LIGHTRAG_LITELLM_INFERENCE_MODEL,
    LIGHTRAG_LITELLM_INFERENCE_API_KEY,
    LIGHTRAG_LITELLM_INFERENCE_API_BASE,
    LIGHTRAG_LITELLM_INFERENCE_API_VERSION,
)
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
    get_project_chat_history,
    get_conversation_citations,
    get_conversation_references,
    get_lightrag_prompt_by_params,
    create_system_messages_for_chat,
)
from dembrane.quote_utils import count_tokens
from dembrane.api.conversation import get_conversation_token_count
from dembrane.api.dependency_auth import DirectusSession, DependencyDirectusSession
from dembrane.audio_lightrag.utils.lightrag_utils import (
    get_project_id,
)

ChatRouter = APIRouter(tags=["chat"])

logger = logging.getLogger("dembrane.chat")


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


@ChatRouter.post("/{chat_id}")
async def post_chat(
    chat_id: str,
    body: ChatBodySchema,
    db: DependencyInjectDatabase,
    auth: DependencyDirectusSession,
    protocol: str = Query("data"),
    language: str = Query("en"),
) -> StreamingResponse:  # ignore: type
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
        top_k = AUDIO_LIGHTRAG_TOP_K_PROMPT
        prompt_len = float("inf")
        while MAX_CHAT_CONTEXT_LENGTH < prompt_len:
            formatted_messages = []
            top_k = max(5, top_k - 10)
            query = filtered_messages[-1]["content"]
            conversation_history = filtered_messages
            rag_prompt = await get_lightrag_prompt_by_params(
                query=query,
                conversation_history=conversation_history,
                echo_conversation_ids=chat_context.conversation_id_list,
                echo_project_ids=[project_id],
                auto_select_bool=chat_context.auto_select_bool,
                get_transcripts=True,
                top_k=top_k,
            )
            logger.info(f"***rag_prompt: {rag_prompt}")
            formatted_messages.append({"role": "system", "content": rag_prompt})
            formatted_messages.append({"role": "user", "content": filtered_messages[-1]["content"]})
            prompt_len = token_counter(
                model=LIGHTRAG_LITELLM_INFERENCE_MODEL, messages=formatted_messages
            )
            if top_k <= 5:
                raise HTTPException(
                    status_code=400,
                    detail="Auto select is not possible with the current context length",
                )

        conversation_references = await get_conversation_references(rag_prompt, [project_id])

        async def stream_response_async_autoselect() -> AsyncGenerator[str, None]:
            conversation_references_yeild = f"h:{json.dumps(conversation_references)}\n"
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

            citations_list = await get_conversation_citations(
                rag_prompt, accumulated_response, [project_id]
            )
            citations_yeild = f"h:{json.dumps(citations_list)}\n"
            yield citations_yeild

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
                        messages_to_send = [{"role": "system", "content": system_messages}] + filtered_messages
                    
                    token_count = token_counter(model=LIGHTRAG_LITELLM_INFERENCE_MODEL, messages=messages_to_send)
                    
                    # If token count is too low, pad the system message with whitespace or additional context
                    if token_count < 2048:
                        logger.info(f"Token count too low ({token_count}), adding padding to reach minimum")
                        # Add padding to the system message to reach minimum token count
                        padding = " " * ((2048 - token_count) * 4)  # Roughly 4 chars per token
                        
                        if isinstance(system_messages, list) and len(system_messages) > 0:
                            messages_to_send[0]["content"] += "\n\n" + padding
                        else:
                            # Handle the case where system_messages is a string
                            if isinstance(system_messages, str):
                                padded_system = system_messages + "\n\n" + padding
                                messages_to_send = [{"role": "system", "content": padded_system}] + filtered_messages
                            else:
                                # This should never happen, but just in case
                                logger.warning("system_messages is neither a list nor a string")
                    
                    logger.debug(f"messages_to_send: {messages_to_send}")
                    response = await litellm.acompletion(
                        model=LIGHTRAG_LITELLM_INFERENCE_MODEL,
                        api_key=LIGHTRAG_LITELLM_INFERENCE_API_KEY,
                        api_version=LIGHTRAG_LITELLM_INFERENCE_API_VERSION,
                        api_base=LIGHTRAG_LITELLM_INFERENCE_API_BASE,
                        messages=messages_to_send,
                        stream=True,
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
