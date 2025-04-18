import logging
from typing import Any, Dict, List, Optional

from pydantic import BaseModel
from sqlalchemy.orm import Session

from dembrane.prompts import render_prompt
from dembrane.database import ConversationModel, ProjectChatMessageModel
from dembrane.api.stateless import GetLightragQueryRequest, get_lightrag_prompt
from dembrane.api.conversation import get_conversation_transcript
from dembrane.api.dependency_auth import DirectusSession

MAX_CHAT_CONTEXT_LENGTH = 100000

logger = logging.getLogger("chat_utils")


class ClientAttachment(BaseModel):
    name: str
    contentType: str
    url: str


class ToolInvocation(BaseModel):
    toolCallId: str
    toolName: str
    args: dict
    result: dict


class ClientMessage(BaseModel):
    role: str
    content: str
    experimental_attachments: Optional[List[ClientAttachment]] = None
    toolInvocations: Optional[List[ToolInvocation]] = None


def convert_to_openai_messages(messages: List[ClientMessage]) -> List[Dict[str, Any]]:
    openai_messages = []

    for message in messages:
        parts = []

        parts.append({"type": "text", "text": message.content})

        openai_messages.append({"role": message.role, "content": parts})

    return openai_messages


def get_project_chat_history(chat_id: str, db: Session) -> List[Dict[str, Any]]:
    db_messages = (
        db.query(ProjectChatMessageModel)
        .filter(ProjectChatMessageModel.project_chat_id == chat_id)
        .order_by(ProjectChatMessageModel.date_created.asc())
        .all()
    )

    messages = []
    for i in db_messages:
        messages.append(
            {
                "role": i.message_from,
                "content": i.text,
            }
        )

    return messages


async def create_system_messages_for_chat(
    locked_conversation_id_list: List[str], db: Session, language: str
) -> List[Dict[str, Any]]:
    conversations = (
        db.query(ConversationModel)
        .filter(ConversationModel.id.in_(locked_conversation_id_list))
        .all()
    )

    conversation_data_list = []
    for conversation in conversations:
        conversation_data_list.append(
            {
                "name": conversation.participant_name,
                "tags": ", ".join([tag.text for tag in conversation.tags]),
                "transcript": get_conversation_transcript(
                    conversation.id,
                    # fake auth to get this fn call
                    DirectusSession(user_id="none", is_admin=True),
                ),
            }
        )

    prompt_message = {"type": "text", "text": render_prompt("system_chat", language, {})}

    logger.info(f"using system prompt in language: {language}")
    logger.info(f"prompt: {prompt_message['text'][:20]}...{prompt_message['text'][-20:]}")

    context_message = {
        "type": "text",
        "text": render_prompt(
            "context_conversations", language, {"conversations": conversation_data_list}
        ),
        # Anthropic/Claude Prompt Caching
        "cache_control": {"type": "ephemeral"},
    }

    return [prompt_message, context_message]


async def get_lightrag_prompt_by_params(top_k: int,
                                        query: str,
                                        conversation_history: list[dict[str, str]],
                                        echo_conversation_ids: list[str],
                                        echo_project_ids: list[str],
                                        auto_select_bool: bool,
                                        get_transcripts: bool) -> str:
    payload = GetLightragQueryRequest(
        query=query,
        conversation_history=conversation_history,
        echo_conversation_ids=echo_conversation_ids,
        echo_project_ids=echo_project_ids,
        auto_select_bool=auto_select_bool,
        get_transcripts=get_transcripts,
        top_k=top_k
    )
    session = DirectusSession(user_id="none", is_admin=True)#fake session
    rag_prompt = await get_lightrag_prompt(payload, session)
    return rag_prompt