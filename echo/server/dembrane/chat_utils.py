import logging
from typing import Any, Dict, List, Optional

from pydantic import BaseModel
from litellm.utils import token_counter

from dembrane.llms import MODELS, arouter_completion, get_completion_kwargs
from dembrane.prompts import render_prompt
from dembrane.service import chat_service, conversation_service
from dembrane.directus import directus
from dembrane.settings import get_settings
from dembrane.llm_router import get_min_context_length
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.conversation import get_conversation_transcript
from dembrane.api.dependency_auth import DirectusSession

logger = logging.getLogger("chat_utils")

# Global LLM model for chat operations
CHAT_LLM = MODELS.MULTI_MODAL_PRO

# Get the minimum context length across all MULTI_MODAL_PRO deployments
# This ensures we don't exceed limits when router picks any deployment
MAX_CHAT_CONTEXT_LENGTH = get_min_context_length("multi_modal_pro")


settings = get_settings()
DISABLE_CHAT_TITLE_GENERATION = settings.feature_flags.disable_chat_title_generation


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


async def get_project_chat_history(chat_id: str) -> List[Dict[str, Any]]:
    messages_raw = await run_in_thread_pool(
        chat_service.list_messages,
        chat_id,
        include_relationships=False,
        order="asc",
    )

    messages: List[Dict[str, Any]] = []
    for message in messages_raw:
        message_from = message.get("message_from")
        if message_from is None:
            continue
        messages.append(
            {
                "role": message_from,
                "content": message.get("text", ""),
                "id": message.get("id"),
                "tokens_count": message.get("tokens_count"),
            }
        )

    return messages


async def create_system_messages_for_chat(
    locked_conversation_id_list: List[str],
    language: str,
    project_id: str,
    chat_mode: Optional[str] = None,  # "overview" | "deep_dive" | "agentic" | None
) -> List[Dict[str, Any]]:
    """
    Create system messages for chat context.

    In overview mode: Uses summaries for ALL project conversations (dynamically fetched).
    In deep_dive mode: Uses full transcripts for selected conversations only.
    """
    from dembrane.summary_utils import (
        ensure_conversation_summaries,
        get_all_conversations_for_overview,
    )

    is_overview_mode = chat_mode == "overview"

    # Fetch conversations based on mode
    if is_overview_mode:
        # Overview mode: Get ALL conversations for the project, use summaries
        logger.info(f"Overview mode: Fetching all conversations for project {project_id}")
        conversations = await get_all_conversations_for_overview(project_id)

        # Filter to conversations with content
        conversations = [
            conv for conv in conversations if int(conv.get("chunks_count", 0) or 0) > 0
        ]

        if conversations:
            # Ensure all conversations have summaries (generate if missing)
            conv_ids = [c["id"] for c in conversations]
            await ensure_conversation_summaries(conv_ids)

            # Re-fetch to get updated summaries
            conversations = await get_all_conversations_for_overview(project_id)
            conversations = [
                conv for conv in conversations if int(conv.get("chunks_count", 0) or 0) > 0
            ]
    else:
        # Deep dive mode: Use the selected conversations
        conversations = await run_in_thread_pool(
            conversation_service.list_by_ids,
            locked_conversation_id_list,
            with_chunks=False,
            with_tags=True,
        )

    # Fetch artifacts for deep dive mode (not needed for overview)
    artifacts_by_conv: Dict[str, List[Dict[str, Any]]] = {}
    if not is_overview_mode and conversations:
        conv_ids = [c["id"] for c in conversations if c.get("id")]
        if conv_ids:
            try:
                artifacts_query = {
                    "query": {
                        "filter": {
                            "_and": [
                                {"conversation_id": {"_in": conv_ids}},
                                {"approved_at": {"_nnull": True}},
                            ]
                        },
                        "fields": ["conversation_id", "key", "content"],
                    }
                }
                artifacts = await run_in_thread_pool(
                    directus.get_items, "conversation_artifact", artifacts_query
                )
                for art in artifacts:
                    cid = art.get("conversation_id")
                    if cid:
                        if cid not in artifacts_by_conv:
                            artifacts_by_conv[cid] = []
                        artifacts_by_conv[cid].append(art)
            except Exception as e:
                logger.warning(f"Failed to fetch artifacts for conversations: {e}")

    # Fetch project info
    try:
        project_query = {
            "query": {
                "fields": [
                    "name",
                    "language",
                    "context",
                    "default_conversation_title",
                    "default_conversation_description",
                    "default_conversation_transcript_prompt",
                ],
                "limit": 1,
                "filter": {"id": {"_in": [project_id]}},
            }
        }
        project_list = await run_in_thread_pool(directus.get_items, "project", project_query)
        project = project_list[0]

        # Build project context with meaningful labels
        context_parts = []
        if project.get("name"):
            context_parts.append(f"name: {project['name']}")
        if project.get("language"):
            context_parts.append(f"language: {project['language']}")
        if project.get("context"):
            context_parts.append(f"context: {project['context']}")
        if project.get("default_conversation_transcript_prompt"):
            context_parts.append(
                f"hotwords (important terms): {project['default_conversation_transcript_prompt']}"
            )
        if project.get("default_conversation_title"):
            context_parts.append(
                f"default conversation title: {project['default_conversation_title']}"
            )
        if project.get("default_conversation_description"):
            context_parts.append(
                f"default conversation description: {project['default_conversation_description']}"
            )
        project_context = "\n".join(context_parts)
    except KeyError as e:
        raise ValueError(f"Invalid project id: {project_id}") from e
    except Exception:
        raise

    project_message = {
        "type": "text",
        "text": render_prompt("context_project", language, {"project_context": project_context}),
    }

    # Build conversation data based on mode
    conversation_data_list: list[dict[str, Any]] = []
    total_summary_tokens = 0
    max_summary_tokens = int(MAX_CHAT_CONTEXT_LENGTH * 0.7)  # Reserve 30% for messages

    for conversation in conversations:
        tag_text_list: List[str] = []
        for tag_entry in conversation.get("tags", []) or []:
            if isinstance(tag_entry, dict):
                project_tag = tag_entry.get("project_tag_id")
                if isinstance(project_tag, dict):
                    tag_text = project_tag.get("text")
                    if tag_text:
                        tag_text_list.append(str(tag_text))

        if is_overview_mode:
            # Use summary for overview mode
            content = conversation.get("summary", "")
            if not content or len(content.strip()) == 0:
                logger.warning(f"Conversation {conversation.get('id')} has no summary, skipping")
                continue

            # Check if adding this summary would exceed context limit
            try:
                summary_tokens = token_counter(
                    messages=[{"role": "user", "content": content}],
                    model=get_completion_kwargs(CHAT_LLM)["model"],
                )
            except Exception:
                summary_tokens = len(content) // 4  # Rough estimate

            if total_summary_tokens + summary_tokens > max_summary_tokens:
                logger.info(
                    f"Overview mode: Stopping at {len(conversation_data_list)} conversations "
                    f"({total_summary_tokens}/{max_summary_tokens} tokens)"
                )
                break

            total_summary_tokens += summary_tokens
            conversation_data_list.append(
                {
                    "name": conversation.get("participant_name"),
                    "tags": ", ".join(tag_text_list),
                    "created_at": conversation.get("created_at"),
                    "duration": conversation.get("duration"),
                    "summary": content,  # Use summary key for overview mode
                    "artifacts": [],  # No artifacts in overview mode
                }
            )
        else:
            # Use full transcript for deep dive mode
            conversation_data_list.append(
                {
                    "name": conversation.get("participant_name"),
                    "tags": ", ".join(tag_text_list),
                    "created_at": conversation.get("created_at"),
                    "duration": conversation.get("duration"),
                    "transcript": await get_conversation_transcript(
                        conversation.get("id", ""),
                        DirectusSession(user_id="none", is_admin=True),
                    ),
                    "artifacts": artifacts_by_conv.get(conversation.get("id", ""), []),
                }
            )

    prompt_message = {
        "type": "text",
        "text": render_prompt("system_chat", language, {"is_overview_mode": is_overview_mode}),
    }

    if is_overview_mode:
        logger.info(
            f"Overview mode: Using {len(conversation_data_list)} conversation summaries "
            f"({total_summary_tokens} tokens) in {language}"
        )
    else:
        logger.info(
            f"Deep dive mode: Using {len(conversation_data_list)} conversations "
            f"with full transcripts in {language}"
        )

    context_message = {
        "type": "text",
        "text": render_prompt(
            "context_conversations",
            language,
            {"conversations": conversation_data_list, "is_overview_mode": is_overview_mode},
        ),
        # Anthropic/Claude Prompt Caching
        "cache_control": {"type": "ephemeral"},
    }

    return [prompt_message, project_message, context_message]


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

    response = await arouter_completion(
        MODELS.MULTI_MODAL_FAST,
        messages=[{"role": "user", "content": title_prompt}],
    )

    if response.choices[0].message.content is None:
        logger.warning(f"No title generated for user query: {user_query}")
        return None

    return response.choices[0].message.content
