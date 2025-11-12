import json
import math
import asyncio
import logging
from typing import Any, Dict, List, Optional

import backoff
from litellm import acompletion
from pydantic import BaseModel
from litellm.utils import token_counter
from litellm.exceptions import (
    Timeout,
    APIError,
    RateLimitError,
    BadRequestError,
    ContextWindowExceededError,
)

from dembrane.llms import MODELS, get_completion_kwargs
from dembrane.prompts import render_prompt
from dembrane.service import chat_service, conversation_service
from dembrane.directus import directus
from dembrane.settings import get_settings
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.conversation import get_conversation_transcript
from dembrane.api.dependency_auth import DirectusSession

MAX_CHAT_CONTEXT_LENGTH = 100000

logger = logging.getLogger("chat_utils")

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
    locked_conversation_id_list: List[str], language: str, project_id: str
) -> List[Dict[str, Any]]:
    conversations = await run_in_thread_pool(
        conversation_service.list_by_ids,
        locked_conversation_id_list,
        with_chunks=False,
        with_tags=True,
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
        tag_text_list: List[str] = []
        for tag_entry in conversation.get("tags", []) or []:
            if isinstance(tag_entry, dict):
                project_tag = tag_entry.get("project_tag_id")
                if isinstance(project_tag, dict):
                    tag_text = project_tag.get("text")
                    if tag_text:
                        tag_text_list.append(str(tag_text))
        conversation_data_list.append(
            {
                "name": conversation.get("participant_name"),
                "tags": ", ".join(tag_text_list),
                "created_at": conversation.get("created_at"),
                "duration": conversation.get("duration"),
                "transcript": await get_conversation_transcript(
                    conversation.get("id", ""),
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
        messages=[{"role": "user", "content": title_prompt}],
        **get_completion_kwargs(MODELS.TEXT_FAST),
    )

    if response.choices[0].message.content is None:
        logger.warning(f"No title generated for user query: {user_query}")
        return None

    return response.choices[0].message.content


async def auto_select_conversations(
    user_query_inputs: List[str],
    project_id_list: List[str],
    language: str = "en",
    batch_size: int = 20,
) -> Dict[str, Any]:
    """
    Auto-select conversations based on user queries using LLM-based relevance assessment.

    This function fetches conversation summaries from the database and uses an LLM
    to select the most relevant conversations for the given queries. It handles
    batching to stay within LLM context limits and processes batches in parallel
    for optimal performance.

    Args:
        user_query_inputs: List of user query strings (currently up to 3)
        project_id_list: List containing a single project ID
        db: Database session
        language: Language code for the prompt template (default: "en")
        batch_size: Number of conversations to process in each LLM call (default: 20)

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
    logger.info(f"Auto-select called with queries: {user_query_inputs}")
    logger.info(f"Auto-select called for project(s): {project_id_list}")

    results: Dict[str, Any] = {}
    # Batch size: number of conversations to process in each LLM call
    # Can be adjusted per-chat via the auto_select_batch_size field
    BATCH_SIZE = batch_size

    for project_id in project_id_list:
        # Get all conversations for this project
        conversations = await run_in_thread_pool(
            conversation_service.list_by_project,
            project_id,
            with_chunks=False,
            with_tags=True,
        )

        if not conversations:
            logger.warning(f"No conversations found for project {project_id}")
            results[project_id] = {"conversation_id_list": []}
            continue

        logger.info(f"Found {len(conversations)} total conversations for project {project_id}")

        # Calculate expected number of LLM calls for observability
        expected_llm_calls = math.ceil(len(conversations) / BATCH_SIZE)
        logger.info(
            f"Auto-select will make {expected_llm_calls} parallel LLM call(s) "
            f"for {len(conversations)} conversations (batch size: {BATCH_SIZE})"
        )

        # Create batches and prepare parallel tasks
        tasks = []
        for i in range(0, len(conversations), BATCH_SIZE):
            batch = conversations[i : i + BATCH_SIZE]
            batch_num = i // BATCH_SIZE + 1
            tasks.append(
                _process_single_batch(
                    batch=batch,
                    batch_num=batch_num,
                    user_query_inputs=user_query_inputs,
                    language=language,
                )
            )

        # Execute all batches in parallel
        logger.info(f"Executing {len(tasks)} batches in parallel...")
        batch_results = await asyncio.gather(*tasks, return_exceptions=True)

        # Aggregate results from all batches
        all_selected_ids = []
        successful_batches = 0
        failed_batches = 0

        for i, batch_result in enumerate(batch_results):
            # Handle exceptions from gather
            if isinstance(batch_result, Exception):
                logger.error(f"Batch {i + 1} failed with exception: {str(batch_result)}")
                failed_batches += 1
                continue

            # Type check: ensure batch_result is a dict, not an exception
            if not isinstance(batch_result, dict):
                logger.error(f"Batch {i + 1} returned unexpected type: {type(batch_result)}")
                failed_batches += 1
                continue

            # Handle batch results
            if "error" in batch_result:
                failed_batches += 1
            else:
                successful_batches += 1

            selected_ids = batch_result.get("selected_ids", [])
            all_selected_ids.extend(selected_ids)

        # Remove duplicates while preserving order
        unique_selected_ids = list(dict.fromkeys(all_selected_ids))

        logger.info(
            f"Auto-select completed: {successful_batches}/{len(tasks)} batches successful "
            f"({failed_batches} failed), selected {len(unique_selected_ids)} unique conversations "
            f"for project {project_id}: {unique_selected_ids}"
        )

        results[project_id] = {"conversation_id_list": unique_selected_ids}

    return {"results": results}


@backoff.on_exception(
    backoff.expo,
    (RateLimitError, Timeout, APIError),
    max_tries=3,
    max_time=5 * 60,  # 5 minutes
)
async def _call_llm_with_backoff(prompt: str, batch_num: int) -> Any:
    """Call LLM with automatic retry for transient errors."""
    logger.debug(f"Calling LLM for batch {batch_num}")
    return await acompletion(
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        timeout=5 * 60,  # 5 minutes
        **get_completion_kwargs(MODELS.TEXT_FAST),
    )


async def _process_single_batch(
    batch: List[dict],
    batch_num: int,
    user_query_inputs: List[str],
    language: str,
) -> Dict[str, Any]:
    """
    Process a single batch of conversations and return selected IDs.

    Args:
        batch: List of conversation dictionaries to process
        batch_num: Batch number for logging
        user_query_inputs: User queries to match against
        language: Language code for the prompt template

    Returns:
        Dictionary with:
        - "selected_ids": List of selected conversation IDs
        - "batch_num": The batch number
        - "error": Error message if processing failed (optional)
    """
    logger.info(f"Processing batch {batch_num} ({len(batch)} conversations, parallel execution)")

    # Prepare conversation data for the prompt
    conversation_data: List[Dict[str, Any]] = []
    for conv in batch:
        conv_id = conv.get("id")
        if not conv_id:
            continue

        summary_text: Optional[str] = None
        conv_summary = conv.get("summary")
        if isinstance(conv_summary, str) and conv_summary.strip():
            summary_text = conv_summary
        else:
            # Use transcript as fallback
            try:
                transcript = await get_conversation_transcript(
                    conv_id,
                    DirectusSession(user_id="none", is_admin=True),
                )
                # Limit transcript to first 500 characters for context
                if transcript and len(transcript) > 500:
                    summary_text = transcript[:500] + "..."
                elif transcript:
                    summary_text = transcript
            except Exception as e:
                logger.warning(f"Could not get transcript for conversation {conv_id}: {e}")

        # Skip conversations with no content at all
        if not summary_text:
            logger.debug(f"Skipping conversation {conv_id} - no summary or transcript")
            continue

        tag_values: List[str] = []
        for tag_entry in conv.get("tags", []) or []:
            if isinstance(tag_entry, dict):
                project_tag = tag_entry.get("project_tag_id")
                if isinstance(project_tag, dict):
                    tag_text = project_tag.get("text")
                    if tag_text:
                        tag_values.append(str(tag_text))

        conversation_entry: Dict[str, Any] = {
            "id": conv_id,
            "participant_name": conv.get("participant_name") or "Unknown",
            "summary": summary_text,
        }
        if tag_values:
            conversation_entry["tags"] = ", ".join(tag_values)
        created_at_value = conv.get("created_at")
        if created_at_value:
            conversation_entry["created_at"] = created_at_value

        conversation_data.append(conversation_entry)

    # Skip batch if no valid conversations
    if not conversation_data:
        logger.warning(f"Batch {batch_num} has no valid conversations with content. Skipping.")
        return {"selected_ids": [], "batch_num": batch_num}

    # Render the prompt
    prompt = render_prompt(
        "auto_select_conversations",
        language,
        {
            "user_queries": user_query_inputs,
            "conversations": conversation_data,
        },
    )

    # Validate prompt size before sending
    try:
        prompt_tokens = token_counter(
            messages=[{"role": "user", "content": prompt}],
            model=get_completion_kwargs(MODELS.TEXT_FAST)["model"],
        )
        MAX_BATCH_CONTEXT = 100000  # Leave headroom for response

        if prompt_tokens > MAX_BATCH_CONTEXT:
            # If batch has only 1 conversation, we can't split further
            if len(batch) == 1:
                conversation_identifier = batch[0].get("id")
                logger.error(
                    f"Batch {batch_num} single conversation exceeds context limit: "
                    f"{prompt_tokens} tokens. Skipping conversation {conversation_identifier}."
                )
                return {
                    "selected_ids": [],
                    "batch_num": batch_num,
                    "error": "single_conversation_too_large",
                }

            # Split batch in half and process recursively
            mid = len(batch) // 2
            batch_1 = batch[:mid]
            batch_2 = batch[mid:]

            logger.warning(
                f"Batch {batch_num} prompt too large ({prompt_tokens} tokens). "
                f"Splitting into 2 sub-batches: {len(batch_1)} and {len(batch_2)} conversations."
            )

            # Process both halves recursively
            result_1 = await _process_single_batch(batch_1, batch_num, user_query_inputs, language)
            result_2 = await _process_single_batch(batch_2, batch_num, user_query_inputs, language)

            # Combine results from both sub-batches
            combined_ids = result_1.get("selected_ids", []) + result_2.get("selected_ids", [])

            logger.info(
                f"Batch {batch_num} split processing complete: "
                f"{len(combined_ids)} conversations selected from sub-batches."
            )

            return {"selected_ids": combined_ids, "batch_num": batch_num}
    except Exception as e:
        logger.warning(f"Could not count tokens for batch {batch_num}: {e}")

    # Call the LLM with retry logic for transient errors
    try:
        response = await _call_llm_with_backoff(
            prompt=prompt,
            batch_num=batch_num,
        )

        if response.choices[0].message.content:
            result = json.loads(response.choices[0].message.content)
            raw_selected_ids = result.get("selected_conversation_ids", [])

            # Validate LLM response: ensure all returned IDs are from this batch
            valid_ids = {conv.get("id") for conv in batch if conv.get("id") is not None}
            batch_selected_ids = [
                selected_id
                for selected_id in raw_selected_ids
                if isinstance(selected_id, (int, str)) and selected_id in valid_ids
            ]

            # Log warning if LLM returned invalid IDs
            if len(batch_selected_ids) != len(raw_selected_ids):
                filtered_count = len(raw_selected_ids) - len(batch_selected_ids)
                invalid_ids = [id for id in raw_selected_ids if id not in valid_ids]
                logger.warning(
                    f"Batch {batch_num}: LLM returned {filtered_count} invalid ID(s), "
                    f"filtered from {len(raw_selected_ids)} to {len(batch_selected_ids)}. "
                    f"Invalid IDs: {invalid_ids}"
                )

            logger.info(
                f"Batch {batch_num} selected {len(batch_selected_ids)} "
                f"conversations: {batch_selected_ids}"
            )
            return {"selected_ids": batch_selected_ids, "batch_num": batch_num}
        else:
            logger.warning(f"No response from LLM for batch {batch_num}")
            return {"selected_ids": [], "batch_num": batch_num}

    except ContextWindowExceededError as e:
        logger.error(
            f"Batch {batch_num} exceeded context window ({len(batch)} conversations). "
            f"Error: {str(e)}"
        )
        return {"selected_ids": [], "batch_num": batch_num, "error": "context_exceeded"}

    except (RateLimitError, Timeout) as e:
        # These are already retried by backoff, so if we get here, all retries failed
        logger.error(f"Batch {batch_num} failed after retries: {type(e).__name__}")
        return {"selected_ids": [], "batch_num": batch_num, "error": str(e)}

    except (APIError, BadRequestError) as e:
        logger.error(f"Batch {batch_num} API error: {str(e)}")
        return {"selected_ids": [], "batch_num": batch_num, "error": "api_error"}

    except Exception as e:
        logger.error(f"Batch {batch_num} unexpected error: {str(e)}")
        return {"selected_ids": [], "batch_num": batch_num, "error": "unknown"}
