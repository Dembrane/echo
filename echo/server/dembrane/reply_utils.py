from typing import Optional, AsyncGenerator
from logging import getLogger
from datetime import datetime

import sentry_sdk
from pydantic import BaseModel
from litellm.utils import token_counter
from litellm.exceptions import ContentPolicyViolationError

from dembrane.llms import MODELS, arouter_completion, get_completion_kwargs
from dembrane.prompts import render_prompt
from dembrane.directus import directus
from dembrane.transcribe import _get_audio_file_object
from dembrane.async_helpers import run_in_thread_pool

logger = getLogger("reply_utils")

# Constants for token limits and conversation sizing
GET_REPLY_TOKEN_LIMIT = 80000
GET_REPLY_TARGET_TOKENS_PER_CONV = 4000


class Conversation(BaseModel):
    id: str
    transcript: str
    name: str
    tags: list[str]


def format_conversation(conversation: Conversation) -> str:
    """Format a single conversation into XML-like string format."""
    return (
        "<conversation>\n"
        f"	<name>{conversation.name}</name>\n"
        f"	<tags>{', '.join(conversation.tags)}</tags>\n"
        f"	<transcript>{conversation.transcript}</transcript>\n"
        "</conversation>\n"
    )


def build_conversation_transcript(conversation: dict) -> str:
    # Create a list of all content (chunks and replies) with timestamps
    conversation_content = []
    for chunk in conversation["chunks"]:
        if chunk["transcript"] is not None:
            conversation_content.append(
                {
                    "timestamp": chunk["timestamp"],
                    "content": str(chunk["transcript"]),
                    "type": "transcript",
                }
            )

    if "replies" in conversation:
        for reply in conversation["replies"]:
            conversation_content.append(
                {
                    "timestamp": reply["date_created"],
                    "content": str(reply["content_text"]),
                    "type": "reply",
                }
            )

    # Sort all content by timestamp
    conversation_content.sort(key=lambda x: x["timestamp"])

    # Build the transcript with interleaved replies
    transcript = ""
    for item in conversation_content:
        if item["type"] == "transcript":
            transcript += f"{item['content']}\n"
        elif item["type"] == "reply":
            transcript += f"[Assistant Reply at this point in time: {item['content']}]\n"
        else:
            logger.error(f"Unknown item type: {item['type']}")
            transcript += f"[Unknown item type: {item['type']}]\n"

    logger.debug(f"The Transcript: {transcript}")

    return transcript


def _parse_directus_datetime(value: Optional[str]) -> Optional[datetime]:
    if value is None:
        return None
    try:
        # Directus returns ISO strings that may end with 'Z'
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        logger.warning("Unable to parse datetime value '%s'", value)
        return None


def select_audio_chunks_for_reply(
    chunks: list[dict],
    last_reply_time: Optional[datetime] = None,
) -> list[dict]:
    """
    Select audio chunks that don't have transcripts and are newer than last_reply_time.
    Similar to _select_audio_chunks in verify.py.
    """
    selected = []
    for chunk in chunks:
        transcript = (chunk.get("transcript") or "").strip()
        # Only include chunks without transcripts
        if transcript:
            continue

        timestamp = chunk.get("timestamp")
        if last_reply_time and timestamp:
            chunk_time = (
                _parse_directus_datetime(timestamp) if isinstance(timestamp, str) else timestamp
            )
            if isinstance(chunk_time, datetime) and chunk_time <= last_reply_time:
                continue

        # Only include chunks with audio path
        if chunk.get("path"):
            selected.append(chunk)

    return selected


async def generate_reply_for_conversation(
    conversation_id: str, language: str
) -> AsyncGenerator[str, None]:
    conversation = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"id": conversation_id},
                "limit": 1,
                "fields": [
                    "id",
                    "project_id",
                    "chunks.id",
                    "chunks.timestamp",
                    "chunks.transcript",
                    "chunks.path",
                    "project_id.id",
                    "project_id.name",
                    "project_id.is_get_reply_enabled",
                    "project_id.get_reply_prompt",
                    "project_id.get_reply_mode",
                    "project_id.context",
                    "project_id.default_conversation_title",
                    "project_id.default_conversation_description",
                    "project_id.default_conversation_transcript_prompt",
                    "tags.project_tag_id.text",
                    "participant_name",
                    "replies.id",
                    "replies.date_created",
                    "replies.content_text",
                    "replies.type",
                ],
                "deep": {
                    # actual order
                    "chunks": {"_sort": ["timestamp"], "_limit": 10000},
                    "replies": {"_sort": ["date_created"], "_limit": 1000},
                },
            },
        },
    )

    if len(conversation) == 0:
        raise ValueError(f"Conversation {conversation_id} not found")

    logger.info(f"Conversation: {conversation}")

    conversation = conversation[0]

    if conversation["project_id"]["is_get_reply_enabled"] is False:
        raise ValueError(f"Echo is not enabled for project {conversation['project_id']['id']}")

    current_conversation = Conversation(
        id=conversation["id"],
        name=conversation["participant_name"],
        transcript=build_conversation_transcript(conversation),
        tags=[
            tag["project_tag_id"]["text"]
            for tag in conversation["tags"]
            if tag["project_tag_id"]["text"] is not None
        ],
    )

    last_reply_time = None
    if conversation.get("replies"):
        last_reply = conversation["replies"][-1]
        last_reply_time = _parse_directus_datetime(last_reply.get("date_created"))

    audio_chunks = select_audio_chunks_for_reply(conversation["chunks"], last_reply_time)

    current_project = {
        "id": conversation["project_id"]["id"],
        "name": conversation["project_id"]["name"],
        "description": conversation["project_id"]["context"],
        "get_reply_prompt": conversation["project_id"]["get_reply_prompt"],
        "get_reply_mode": conversation["project_id"]["get_reply_mode"],
        "default_conversation_title": conversation["project_id"]["default_conversation_title"],
        "default_conversation_description": conversation["project_id"][
            "default_conversation_description"
        ],
        "default_conversation_transcript_prompt": conversation["project_id"][
            "default_conversation_transcript_prompt"
        ],
    }

    # Check if we should use summaries for adjacent conversations
    get_reply_mode = current_project.get("get_reply_mode")
    use_summaries = get_reply_mode in ["summarize", "brainstorm", "custom"]

    # Determine fields to fetch based on mode
    adjacent_fields = [
        "id",
        "participant_name",
        "tags.project_tag_id.text",
    ]

    if use_summaries:
        adjacent_fields.append("summary")
    else:
        adjacent_fields.extend(
            [
                "chunks.id",
                "chunks.timestamp",
                "chunks.transcript",
                "replies.id",
                "replies.date_created",
                "replies.content_text",
                "replies.type",
            ]
        )

    adjacent_conversations = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "id": {"_neq": current_conversation.id},
                    "project_id": {"_eq": conversation["project_id"]["id"]},
                },
                "fields": adjacent_fields,
                "deep": {
                    # reverse chronological order
                    "chunks": {"_sort": ["-timestamp"], "_limit": 1000},
                    "replies": {"_sort": ["-date_created"], "_limit": 1000},
                }
                if not use_summaries
                else {},
            }
        },
    )

    total_tokens = 0
    token_limit = GET_REPLY_TOKEN_LIMIT
    target_tokens_per_conv = GET_REPLY_TARGET_TOKENS_PER_CONV  # Target size for each conversation

    candidate_conversations = []
    if use_summaries:
        # Use summaries for adjacent conversations
        for conversation in adjacent_conversations:
            if conversation["summary"] is None:
                logger.info(f"Conversation {conversation['id']} has no summary, skipping")
                continue

            # Create conversation with tags
            tags = (
                [
                    tag["project_tag_id"]["text"]
                    for tag in conversation["tags"]
                    if tag["project_tag_id"]["text"] is not None
                ]
                if conversation["tags"]
                else []
            )

            c = Conversation(
                id=conversation["id"],
                name=conversation["participant_name"],
                transcript=conversation["summary"],  # Use summary instead of full transcript
                tags=tags,
            )

            # Check tokens for this conversation
            formatted_conv = format_conversation(c)
            tokens = token_counter(
                messages=[{"role": "user", "content": formatted_conv}],
                model=get_completion_kwargs(MODELS.TEXT_FAST)["model"],
            )

            candidate_conversations.append((formatted_conv, tokens))
    else:
        # Use full transcripts for adjacent conversations (original logic)
        for conversation in adjacent_conversations:
            # Create conversation with tags
            c = Conversation(
                id=conversation["id"],
                name=conversation["participant_name"],
                transcript=build_conversation_transcript(conversation),
                tags=[
                    tag["project_tag_id"]["text"]
                    for tag in conversation["tags"]
                    if tag["project_tag_id"]["text"] is not None
                ],
            )

            # First check tokens for this conversation
            formatted_conv = format_conversation(c)
            tokens = token_counter(
                messages=[{"role": "user", "content": formatted_conv}],
                model=get_completion_kwargs(MODELS.TEXT_FAST)["model"],
            )

            # If conversation is too large, truncate it
            if tokens > target_tokens_per_conv:
                # Rough approximation: truncate based on token ratio
                truncation_ratio = target_tokens_per_conv / tokens
                truncated_transcript = c.transcript[: int(len(c.transcript) * truncation_ratio)]
                c.transcript = truncated_transcript + "\n[Truncated for brevity...]"
                formatted_conv = format_conversation(c)
                tokens = token_counter(
                    messages=[{"role": "user", "content": formatted_conv}],
                    model=get_completion_kwargs(MODELS.TEXT_FAST)["model"],
                )

            candidate_conversations.append((formatted_conv, tokens))

    # Second pass: add as many conversations as possible
    formatted_conversations = []
    for formatted_conv, tokens in candidate_conversations:
        if total_tokens + tokens <= token_limit:
            formatted_conversations.append(formatted_conv)
            total_tokens += tokens
        else:
            break

    logger.debug(f"Total tokens for adjacent conversations: {total_tokens}")
    logger.debug(f"Number of adjacent conversations included: {len(formatted_conversations)}")
    logger.debug(f"Using summaries for adjacent conversations: {use_summaries}")

    formatted_adjacent_conversation = ""
    for formatted_conv in formatted_conversations:
        formatted_adjacent_conversation += formatted_conv

    formatted_current_conversation = format_conversation(current_conversation)

    # Build PROJECT_DESCRIPTION by combining context and additional project fields
    project_description_parts = []

    if current_project["description"] is not None:
        project_description_parts.append(current_project["description"])

    if current_project["default_conversation_title"] is not None:
        project_description_parts.append(
            f"Default Conversation Title: {current_project['default_conversation_title']}"
        )

    if current_project["default_conversation_description"] is not None:
        project_description_parts.append(
            f"Default Conversation Description: {current_project['default_conversation_description']}"
        )

    if current_project["default_conversation_transcript_prompt"] is not None:
        project_description_parts.append(
            f"Default Conversation Transcript Prompt: {current_project['default_conversation_transcript_prompt']}"
        )

    project_description = "\n\n".join(project_description_parts)

    # Determine which prompt to use based on mode
    if get_reply_mode == "summarize":
        # Load global prompt from summary template
        global_prompt = render_prompt("get_reply_summarize", language, {})
        logger.debug(f"Using get_reply_summarize template for global prompt: {get_reply_mode}")
    elif get_reply_mode == "brainstorm":
        # Load global prompt from brainstorm template
        global_prompt = render_prompt("get_reply_brainstorm", language, {})
        logger.debug(f"Using get_reply_brainstorm template for global prompt: {get_reply_mode}")
    elif get_reply_mode == "custom":
        # Use project prompt if available, otherwise fall back to summarize
        if current_project["get_reply_prompt"] and current_project["get_reply_prompt"].strip():
            global_prompt = current_project["get_reply_prompt"]
            logger.debug(f"Using project global prompt for custom mode: {get_reply_mode}")
        else:
            # If custom prompt is empty, use summarize prompt
            global_prompt = render_prompt("get_reply_summarize", language, {})
            logger.debug("Custom prompt is empty, falling back to get_reply_summarize template")
    else:
        global_prompt = (
            current_project["get_reply_prompt"]
            if current_project["get_reply_prompt"] is not None
            else ""
        )
        logger.debug(f"Using project global prompt for mode: {get_reply_mode}")

    prompt = render_prompt(
        "get_reply_system",
        language,
        {
            "PROJECT_DESCRIPTION": project_description,
            "GLOBAL_PROMPT": global_prompt,
            "OTHER_TRANSCRIPTS": formatted_adjacent_conversation,
            "MAIN_USER_TRANSCRIPT": formatted_current_conversation,
        },
    )

    # Build multimodal message content
    message_content = [{"type": "text", "text": prompt}]

    # Add audio chunks without transcripts
    for chunk in audio_chunks:
        chunk_id = chunk.get("id")
        timestamp = chunk.get("timestamp")
        message_content.append(
            {
                "type": "text",
                "text": f"Audio chunk {chunk_id} captured at {timestamp}",
            }
        )
        path = chunk.get("path")
        if path:
            try:
                audio_obj = await run_in_thread_pool(_get_audio_file_object, path)
                message_content.append(audio_obj)
            except Exception as exc:
                logger.warning("Failed to attach audio chunk %s: %s", chunk_id, exc)

    # Store the complete response
    accumulated_response = ""

    # Stream the response via router for load balancing and failover
    try:
        response = await arouter_completion(
            MODELS.MULTI_MODAL_PRO,
            messages=[
                {"role": "user", "content": message_content},
            ],
            stream=True,
            thinking={"type": "enabled", "budget_tokens": 500},
        )
    except ContentPolicyViolationError as e:
        logger.error(
            f"Content policy violation for conversation {conversation_id}. Error: {str(e)}"
        )
        sentry_sdk.capture_exception(e)
        raise
    except Exception as e:
        logger.error(f"LiteLLM completion failed for {conversation_id}: {str(e)}")
        sentry_sdk.capture_exception(e)
        raise

    try:
        async for chunk in response:
            if chunk.choices[0].delta.content:
                content = chunk.choices[0].delta.content
                accumulated_response += content
                yield content
    except Exception as e:
        logger.error(f"Streaming failed for conversation {current_conversation.id}: {e}")
        sentry_sdk.capture_exception(e)
        raise

    try:
        response_content = accumulated_response.strip()

        directus.create_item(
            "conversation_reply",
            item_data={
                "conversation_id": current_conversation.id,
                "content_text": response_content,
                "type": "assistant_reply",
            },
        )
    except Exception as e:
        logger.error(f"Failed to store reply in Directus: {e}")
        sentry_sdk.capture_exception(e)
        raise


if __name__ == "__main__":
    print(generate_reply_for_conversation("96e43879-17eb-40db-95a5-5247f7d7759e", "en"))
