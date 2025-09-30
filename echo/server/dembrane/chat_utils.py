import json
import logging
from typing import Any, Dict, List, Optional

from litellm import completion, acompletion
from pydantic import BaseModel
from sqlalchemy.orm import Session

from dembrane.config import (
    SMALL_LITELLM_MODEL,
    SMALL_LITELLM_API_KEY,
    SMALL_LITELLM_API_BASE,
    DISABLE_CHAT_TITLE_GENERATION,
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
    get_project_id_from_conversation_id,
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
        project_query = {
            "query": {
                "fields": [
                    "name",
                    "language",
                    "context",
                    "default_conversation_title",
                    "default_conversation_description",
                ],
                "limit": 1,
                "filter": {"id": {"_in": [project_id]}},
            }
        }
        project = directus.get_items("project", project_query)[0]
        project_context = "\n".join([str(k) + " : " + str(v) for k, v in project.items()])
    except KeyError as e:
        raise ValueError(f"Invalid project id: {project_id}") from e
    except Exception:
        raise

    project_message = {
        "type": "text",
        "text": render_prompt("context_project", language, {"project_context": project_context}),
    }

    conversation_data_list = []
    for conversation in conversations:
        conversation_data_list.append(
            {
                "name": conversation.participant_name,
                "tags": ", ".join([tag.text for tag in conversation.tags]),
                "created_at": conversation.created_at.isoformat()
                if conversation.created_at
                else None,
                "duration": conversation.duration,
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


async def get_lightrag_prompt_by_params(
    top_k: int,
    query: str,
    conversation_history: list[dict[str, str]],
    echo_conversation_ids: list[str],
    echo_project_ids: list[str],
    auto_select_bool: bool,
    get_transcripts: bool,
) -> str:
    payload = GetLightragQueryRequest(
        query=query,
        conversation_history=conversation_history,
        echo_conversation_ids=echo_conversation_ids,
        echo_project_ids=echo_project_ids,
        auto_select_bool=auto_select_bool,
        get_transcripts=get_transcripts,
        top_k=top_k,
    )
    session = DirectusSession(user_id="none", is_admin=True)  # fake session
    rag_prompt = await get_lightrag_prompt(payload, session)
    return rag_prompt


async def get_conversation_references(
    rag_prompt: str, project_ids: List[str]
) -> List[Dict[str, Any]]:
    try:
        references = await get_conversation_details_for_rag_query(rag_prompt, project_ids)
        conversation_references = {"references": references}
    except Exception as e:
        logger.warning(f"No references found. Error: {str(e)}")
        conversation_references = {"references": []}
    return [conversation_references]


class CitationSingleSchema(BaseModel):
    segment_id: int
    verbatim_reference_text_chunk: str


class CitationsSchema(BaseModel):
    citations: List[CitationSingleSchema]


async def generate_title(
    user_query: str,
    language: str,
) -> str | None:
    """
    Generate a short chat title from a user's query using a small LLM.
    
    If title generation is disabled via configuration or the trimmed query is shorter than 2 characters, the function returns None. The function builds a prompt (using the English prompt template) and asynchronously calls a configured small LLM; it returns the generated title string or None if the model returns no content.
    
    Parameters:
        user_query (str): The user's chat message or query to generate a title from.
        language (str): Target language for the generated title (affects prompt content; the prompt template used is English).
    
    Returns:
        str | None: The generated title, or None if generation is disabled, the query is too short, or the model produced no content.
    """
    if DISABLE_CHAT_TITLE_GENERATION:
        logger.debug("Skipping title generation because DISABLE_CHAT_TITLE_GENERATION is set")
        return None

    if len(user_query.strip()) < 2:
        logger.debug("Skipping title generation because user query is too short (<2 chars)")
        return None

    # here we use the english prompt template, but the language is passed in to make it simple
    title_prompt = render_prompt(
        "generate_chat_title", "en", {"user_query": user_query, "language": language}
    )

    response = await acompletion(
        model=SMALL_LITELLM_MODEL,
        messages=[{"role": "user", "content": title_prompt}],
        api_base=SMALL_LITELLM_API_BASE,
        api_key=SMALL_LITELLM_API_KEY,
    )

    if response.choices[0].message.content is None:
        logger.warning(f"No title generated for user query: {user_query}")
        return None

    return response.choices[0].message.content


async def auto_select_conversations(
    user_query_inputs: List[str],
    project_id_list: List[str],
    db: Session,
) -> Dict[str, Any]:
    """
    Dummy function for auto-selecting conversations based on user queries.

    This is a placeholder implementation that randomly selects up to 3 conversations
    from the given project. In the future, this will use RAG/semantic search to find
    the most relevant conversations for the given queries.

    Args:
        user_query_inputs: List of user query strings (currently up to 3)
        project_id_list: List containing a single project ID
        db: Database session

    Returns:
        Dictionary with structure:
        {
            "results": {
                "<project_id>": {
                    "conversation_id_list": [<conversation_ids>]
                }
            }
        }
    """
    import random

    logger.info(f"Auto-select called with queries: {user_query_inputs}")
    logger.info(f"Auto-select called for project(s): {project_id_list}")

    results = {}

    for project_id in project_id_list:
        # Get all conversations for this project
        conversations = (
            db.query(ConversationModel).filter(ConversationModel.project_id == project_id).all()
        )

        if not conversations:
            logger.warning(f"No conversations found for project {project_id}")
            results[project_id] = {"conversation_id_list": []}
            continue

        # Randomly select up to 3 conversations
        num_to_select = min(3, len(conversations))
        selected_conversations = random.sample(conversations, num_to_select)
        conversation_ids = [conv.id for conv in selected_conversations]

        logger.info(f"Selected {len(conversation_ids)} conversations: {conversation_ids}")

        results[project_id] = {"conversation_id_list": conversation_ids}

    return {"results": results}


async def get_conversation_citations(
    rag_prompt: str,
    accumulated_response: str,
    project_ids: List[str],
    language: str = "en",
) -> List[Dict[str, Any]]:
    """
    Extract structured conversation citations from an accumulated assistant response using a text-structuring model, map those citations to conversations, and return only citations that belong to the given project IDs.
    
    This function:
    - Renders a text-structuring prompt using `rag_prompt` and `accumulated_response` and sends it to the configured text-structure LLM.
    - Parses the model's JSON response (expected to follow `CitationsSchema`) to obtain citation entries that include `segment_id` and `verbatim_reference_text_chunk`.
    - For each citation, resolves `segment_id` to a (conversation_id, conversation_name) pair and derives the citation's project id.
    - Filters citations to include only those whose project id is present in `project_ids`.
    - Returns a single-item list containing a dict with the key "citations", where each item is a dict with keys:
      - "conversation": conversation id (str)
      - "reference_text": verbatim reference text chunk (str)
      - "conversation_title": conversation name/title (str)
    
    If the model output cannot be parsed or a segment-to-conversation mapping fails for an individual citation, that citation is skipped; parsing errors do not raise but are logged and result in an empty citations list in the returned structure.
    """
    text_structuring_model_message = render_prompt(
        "text_structuring_model_message",
        language,
        {"accumulated_response": accumulated_response, "rag_prompt": rag_prompt},
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
        response_format=CitationsSchema,
    )
    try:
        citations_by_segment_dict = json.loads(
            text_structuring_model_generation.choices[0].message.content
        )
        logger.debug(f"Citations by segment dict: {citations_by_segment_dict}")
        citations_list = citations_by_segment_dict["citations"]
        logger.debug(f"Citations list: {citations_list}")
        citations_by_conversation_dict: Dict[str, List[Dict[str, Any]]] = {"citations": []}
        if len(citations_list) > 0:
            for _, citation in enumerate(citations_list):
                try:
                    (conversation_id, conversation_name) = await run_segment_id_to_conversation_id(
                        citation["segment_id"]
                    )
                    citation_project_id = get_project_id_from_conversation_id(conversation_id)
                except Exception as e:
                    logger.warning(
                        f"WARNING: Error in citation extraction for segment {citation['segment_id']}. Skipping citations: {str(e)}"
                    )
                    continue
                if citation_project_id in project_ids:
                    current_citation_dict = {
                        "conversation": conversation_id,
                        "reference_text": citation["verbatim_reference_text_chunk"],
                        "conversation_title": conversation_name,
                    }
                    citations_by_conversation_dict["citations"].append(current_citation_dict)
        else:
            logger.warning("WARNING: No citations found")
    except Exception as e:
        logger.warning(f"WARNING: Error in citation extraction. Skipping citations: {str(e)}")
    return [citations_by_conversation_dict]
