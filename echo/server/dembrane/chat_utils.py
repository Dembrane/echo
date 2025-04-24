import json
import logging
from typing import Any, Dict, List, Optional

from litellm import completion
from pydantic import BaseModel
from sqlalchemy.orm import Session

from dembrane.config import (
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL,
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY,
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE,
    LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION,
)
from dembrane.prompts import render_prompt
from dembrane.database import ConversationModel, ProjectChatMessageModel
from dembrane.directus import directus
from dembrane.api.stateless import GetLightragQueryRequest, get_lightrag_prompt
from dembrane.api.conversation import get_conversation_transcript
from dembrane.api.dependency_auth import DirectusSession
from dembrane.audio_lightrag.utils.lightrag_utils import (
    run_segment_id_to_conversation_id,
    get_conversation_details_for_rag_query,
)

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
    locked_conversation_id_list: List[str], db: Session, language: str, project_id: str
) -> List[Dict[str, Any]]:
    conversations = (
        db.query(ConversationModel)
        .filter(ConversationModel.id.in_(locked_conversation_id_list))
        .all()
    )
    try:
        project_query = {'query': {'fields': ['name', 'language', 'context', 'default_conversation_title', 'default_conversation_description'], 
        'limit': 1, 'filter': {'id': {'_in': [project_id]}}}}
        project = directus.get_items("project", project_query)[0]
        project_context = '\n'.join([str(k) + ' : ' + str(v) for k, v in project.items()])
    except KeyError as e:
        raise ValueError(f"Invalid project id: {project_id}") from e
    except Exception:
        raise

    project_message = {"type": "text", "text": render_prompt("context_project", language, {"project_context": project_context})}

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

    return [prompt_message, project_message, context_message]


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


async def get_conversation_references(rag_prompt: str) -> List[Dict[str, Any]]:
    try:
        conversation_references = await get_conversation_details_for_rag_query(rag_prompt)
        conversation_references = {'references': conversation_references}
    except Exception as e:
        logger.warning(f"No references found. Error: {str(e)}")
        conversation_references = {'references':{}}
    return [conversation_references]

class CitationSingleSchema(BaseModel):
    segment_id: int
    verbatim_reference_text_chunk: str

class CitationsSchema(BaseModel):
    citations: List[CitationSingleSchema]

async def get_conversation_citations(rag_prompt: str, accumulated_response: str, language: str = "en") -> List[Dict[str, Any]]:
    text_structuring_model_message = render_prompt("text_structuring_model_message", language, 
        {
        'accumulated_response': accumulated_response, 
        'rag_prompt':rag_prompt
        }
        )
    text_structuring_model_messages = [
        {"role": "system", "content": text_structuring_model_message},
    ]
    text_structuring_model_generation = completion(
        model=f"{LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_MODEL}",
        messages=text_structuring_model_messages,
        api_base=LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_BASE,
        api_version=LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_VERSION,
        api_key=LIGHTRAG_LITELLM_TEXTSTRUCTUREMODEL_API_KEY,
        response_format=CitationsSchema)
    try: 
        citations_by_segment_dict = json.loads(text_structuring_model_generation.choices[0].message.content) #type: ignore
        logger.debug(f"Citations by segment dict: {citations_by_segment_dict}")
        citations_list = citations_by_segment_dict["citations"]
        logger.debug(f"Citations list: {citations_list}")
        citations_by_conversation_dict: Dict[str, List[Dict[str, Any]]] = {"citations": []}
        if len(citations_list) > 0:
            for _, citation in enumerate(citations_list):
                try: 
                    conversation_id = await run_segment_id_to_conversation_id(citation['segment_id'])
                except Exception as e:
                    logger.warning(f"WARNING: Error in citation extraction for segment {citation['segment_id']}. Skipping citations: {str(e)}")
                    continue
                current_citation_dict = {"conversation_id": conversation_id, "reference_text": citation['verbatim_reference_text_chunk']}
                citations_by_conversation_dict["citations"].append(current_citation_dict)
        else:
            logger.warning("WARNING: No citations found")
    except Exception as e:
        logger.warning(f"WARNING: Error in citation extraction. Skipping citations: {str(e)}")
    return [citations_by_conversation_dict]