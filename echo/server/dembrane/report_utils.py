import re
import asyncio
import logging
from typing import Optional

import backoff
import sentry_sdk
from litellm import acompletion
from litellm.utils import token_counter, get_model_info
from litellm.exceptions import (
    Timeout,
    APIError,
    RateLimitError,
    BadRequestError,
    ContextWindowExceededError,
    ContentPolicyViolationError,
)

from dembrane.llms import MODELS, get_completion_kwargs
from dembrane.prompts import render_prompt
from dembrane.directus import DirectusGenericException, directus
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.conversation import summarize_conversation, get_conversation_transcript
from dembrane.api.dependency_auth import DirectusSession

logger = logging.getLogger("report_utils")

TEXT_PROVIDER_KWARGS = get_completion_kwargs(MODELS.TEXT_FAST)
TEXT_PROVIDER_MODEL = TEXT_PROVIDER_KWARGS["model"]

_model_info = get_model_info(TEXT_PROVIDER_MODEL)
_max_input_tokens = _model_info["max_input_tokens"] if _model_info else None

if _max_input_tokens is None:
    logger.warning(f"Could not get max tokens for model {TEXT_PROVIDER_MODEL}")
    MAX_REPORT_CONTEXT_LENGTH = 128000  # good default
else:
    MAX_REPORT_CONTEXT_LENGTH = int(_max_input_tokens * 0.8)

logger.info(
    f"Using {TEXT_PROVIDER_MODEL} for report generation with context length {MAX_REPORT_CONTEXT_LENGTH}"
)

# Default timeout for LLM report generation (5 minutes)
REPORT_GENERATION_TIMEOUT = 5 * 60


class ContextTooLongException(Exception):
    """Exception raised when the context length exceeds the maximum allowed."""

    pass


class ReportGenerationError(Exception):
    """Exception raised when report generation fails after retries."""

    def __init__(self, message: str, cause: Optional[Exception] = None):
        super().__init__(message)
        self.cause = cause


@backoff.on_exception(
    backoff.expo,
    (RateLimitError, Timeout, APIError),
    max_tries=3,
    max_time=REPORT_GENERATION_TIMEOUT,
    on_backoff=lambda details: logger.warning(
        f"Retrying LLM call for report generation (attempt {details['tries']}): {details.get('exception')}"
    ),
)
async def _call_llm_for_report(prompt: str) -> str:
    """Call LLM with automatic retry for transient errors."""
    logger.debug("Calling LLM for report generation")
    response = await acompletion(
        messages=[{"role": "user", "content": prompt}],
        timeout=REPORT_GENERATION_TIMEOUT,
        **get_completion_kwargs(MODELS.TEXT_FAST),
    )
    return response.choices[0].message.content


async def _safe_summarize_conversation(conversation_id: str) -> dict:
    """
    Safely summarize a single conversation, catching and logging errors.
    Returns a dict with 'success' and optionally 'error' fields.
    """
    try:
        await summarize_conversation(
            conversation_id, auth=DirectusSession(user_id="none", is_admin=True)
        )
        return {"success": True, "conversation_id": conversation_id}
    except Exception as e:
        logger.warning(
            f"Failed to summarize conversation {conversation_id}: {type(e).__name__}: {e}"
        )
        return {"success": False, "conversation_id": conversation_id, "error": str(e)}


async def _safe_get_transcript(conversation_id: str) -> Optional[str]:
    """
    Safely get transcript for a conversation, returning None on error.
    """
    try:
        transcript = await get_conversation_transcript(
            conversation_id,
            DirectusSession(user_id="none", is_admin=True),
        )
        return transcript or ""
    except Exception as e:
        logger.warning(
            f"Failed to get transcript for conversation {conversation_id}: {type(e).__name__}: {e}"
        )
        return None


async def _fetch_conversations(project_id: str, fields: list) -> list:
    """
    Fetch conversations for a project with error handling.
    """
    try:
        conversations = await run_in_thread_pool(
            directus.get_items,
            "conversation",
            {
                "query": {
                    "filter": {"project_id": {"_eq": project_id}},
                    "fields": fields,
                    "sort": "-updated_at",
                },
            },
        )
        return conversations if conversations else []
    except DirectusGenericException as e:
        logger.error(f"Directus error fetching conversations for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(
            f"Failed to fetch conversations from database: {e}", cause=e
        ) from e
    except Exception as e:
        logger.error(f"Unexpected error fetching conversations for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(f"Unexpected error fetching conversations: {e}", cause=e) from e


async def get_report_content_for_project(project_id: str, language: str) -> str:
    """
    Generate a report for a project based on conversation summaries and transcripts.

    This function is fault-tolerant and will:
    - Continue processing if individual conversation summaries fail
    - Skip conversations that cannot be fetched
    - Retry LLM calls on transient failures
    - Return partial results if some data is unavailable

    Args:
        project_id: The ID of the project to generate a report for
        language: The language code for the report

    Returns:
        The generated report content as a string

    Raises:
        ReportGenerationError: If the report cannot be generated due to critical failures
    """
    # Initial fetch to get conversations with chunk counts
    conversations = await _fetch_conversations(
        project_id,
        fields=["id", "summary", "count(chunks)"],
    )

    logger.debug(f"Initially found {len(conversations)} conversations for project {project_id}")

    if len(conversations) == 0:
        logger.info(f"No conversations found for project {project_id}")
        return "No conversations found for project"

    # Filter to conversations with chunks that need summarization
    conversation_with_chunks = []
    for conversation in conversations:
        try:
            chunks_count = int(conversation.get("chunks_count", 0))
            if chunks_count > 0:
                conversation_with_chunks.append(conversation)
                logger.debug(f"Conversation {conversation['id']} has {chunks_count} chunks")
        except (ValueError, TypeError) as e:
            logger.warning(f"Invalid chunks_count for conversation {conversation.get('id')}: {e}")
            continue

    if not conversation_with_chunks:
        logger.info(f"No conversations with chunks found for project {project_id}")
        return "No conversations with content found for project"

    logger.info(f"Generating summaries for {len(conversation_with_chunks)} conversations")

    # Batch summarization with fault tolerance
    batch_size = 5
    total_summary_failures = 0

    for i in range(0, len(conversation_with_chunks), batch_size):
        batch = conversation_with_chunks[i : i + batch_size]
        tasks = [_safe_summarize_conversation(conv["id"]) for conv in batch]

        # Use return_exceptions=True to prevent one failure from canceling others
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for result in results:
            if isinstance(result, Exception):
                logger.error(f"Unexpected exception during batch summarization: {result}")
                total_summary_failures += 1
            elif isinstance(result, dict) and not result.get("success"):
                total_summary_failures += 1

    if total_summary_failures > 0:
        logger.warning(
            f"Failed to summarize {total_summary_failures}/{len(conversation_with_chunks)} conversations"
        )

    # Refetch conversations with all needed fields
    try:
        conversations = await _fetch_conversations(
            project_id,
            fields=[
                "id",
                "participant_name",
                "tags.project_tag_id.text",
                "summary",
                "created_at",
                "updated_at",
                "count(chunks)",
            ],
        )
    except ReportGenerationError:
        # If refetch fails, we can't proceed
        raise

    if not conversations:
        logger.warning(f"No conversations found on refetch for project {project_id}")
        return "No conversations available for report"

    # Build conversation data with token budget management
    conversation_data_dict: dict = {}
    token_count = 0
    skipped_no_chunks = 0
    skipped_no_summary = 0
    skipped_token_limit = 0

    for conversation in conversations:
        conv_id = conversation.get("id")
        if not conv_id:
            logger.warning("Conversation missing 'id' field, skipping")
            continue

        try:
            chunks_count = int(conversation.get("chunks_count", 0))
        except (ValueError, TypeError):
            chunks_count = 0

        if chunks_count == 0:
            logger.debug(f"Conversation {conv_id} has no chunks, skipping")
            skipped_no_chunks += 1
            continue

        summary = conversation.get("summary")
        if not summary:
            logger.debug(f"Conversation {conv_id} has no summary, skipping")
            skipped_no_summary += 1
            continue

        # Count tokens before adding
        try:
            summary_tokens = token_counter(
                messages=[{"role": "user", "content": summary}],
                model=TEXT_PROVIDER_MODEL,
            )
        except Exception as e:
            logger.warning(f"Failed to count tokens for conversation {conv_id}: {e}")
            # Use a rough estimate: ~4 chars per token
            summary_tokens = len(summary) // 4

        # Check if adding this conversation would exceed the limit
        if token_count + summary_tokens >= MAX_REPORT_CONTEXT_LENGTH:
            logger.info(
                f"Reached context limit. Added {len(conversation_data_dict)} conversations. "
                f"Token count: {token_count}, attempted to add: {summary_tokens}"
            )
            skipped_token_limit += 1
            break

        # Guard against missing or null tags coming back from the API
        tags_text = ""
        try:
            tags = conversation.get("tags") or []
            for tag in tags:
                if tag and isinstance(tag, dict):
                    project_tag = tag.get("project_tag_id")
                    if project_tag and isinstance(project_tag, dict):
                        tag_text = project_tag.get("text")
                        if tag_text:
                            tags_text += tag_text + ", "
        except (KeyError, TypeError, AttributeError) as e:
            logger.debug(f"Error processing tags for conversation {conv_id}: {e}")

        # Add the conversation after confirming it fits
        conversation_data_dict[conv_id] = {
            "name": conversation.get("participant_name"),
            "tags": tags_text.rstrip(", "),
            "transcript": summary,
            "created_at": conversation.get("created_at"),
            "updated_at": conversation.get("updated_at"),
        }
        token_count += summary_tokens

    # Now try to add full transcripts for conversations that have summaries
    # Process in the same order (most recent first)
    transcripts_added = 0
    transcripts_skipped = 0

    for conversation in conversations:
        conv_id = conversation.get("id")
        if not conv_id or conv_id not in conversation_data_dict:
            continue

        transcript = await _safe_get_transcript(conv_id)
        if transcript is None:
            # Error already logged in _safe_get_transcript
            transcripts_skipped += 1
            continue

        if transcript == "":
            logger.debug(f"Conversation {conv_id} has empty transcript – skipping")
            continue

        # Calculate token count for the transcript
        try:
            transcript_tokens = token_counter(
                messages=[{"role": "user", "content": transcript}],
                model=TEXT_PROVIDER_MODEL,
            )
        except Exception as e:
            logger.warning(f"Failed to count transcript tokens for {conv_id}: {e}")
            transcript_tokens = len(transcript) // 4

        if token_count + transcript_tokens < MAX_REPORT_CONTEXT_LENGTH:
            # Append with a newline to keep paragraphs separated
            conversation_data_dict[conv_id]["transcript"] += "\n" + transcript
            token_count += transcript_tokens
            transcripts_added += 1
            logger.debug(
                f"Added transcript for conversation {conv_id}. Total tokens: {token_count}"
            )
        else:
            logger.debug(
                f"Cannot add transcript for conversation {conv_id}. "
                f"Would exceed limit: {token_count} + {transcript_tokens} > {MAX_REPORT_CONTEXT_LENGTH}"
            )
            # Since conversations are sorted by recency, if we can't fit this one,
            # we likely can't fit any subsequent ones either
            break

    conversation_data_list = list(conversation_data_dict.values())

    if not conversation_data_list:
        logger.warning(f"No usable conversations for report in project {project_id}")
        return "No conversations with sufficient content available for report generation"

    logger.info(
        f"Report for project {project_id} will include {len(conversation_data_list)} conversations "
        f"(skipped: {skipped_no_chunks} no chunks, {skipped_no_summary} no summary, "
        f"{skipped_token_limit} token limit). "
        f"Transcripts: {transcripts_added} added, {transcripts_skipped} failed. "
        f"Total token count: {token_count} of {MAX_REPORT_CONTEXT_LENGTH} allowed."
    )

    prompt_message = render_prompt(
        "system_report", language, {"conversations": conversation_data_list}
    )

    # Use the configured Litellm provider for report generation with retry
    try:
        response_content = await _call_llm_for_report(prompt_message)
    except ContextWindowExceededError as e:
        logger.error(f"Context window exceeded for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(
            "Report content too large for the language model", cause=e
        ) from e
    except ContentPolicyViolationError as e:
        logger.error(f"Content policy violation for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError("Report content violates content policy", cause=e) from e
    except BadRequestError as e:
        logger.error(f"Bad request error for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(f"Invalid request to language model: {e}", cause=e) from e
    except (RateLimitError, Timeout, APIError) as e:
        # These are retried by backoff, so if we get here, all retries failed
        logger.error(f"LLM call failed after retries for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(
            f"Report generation failed after multiple retries: {type(e).__name__}", cause=e
        ) from e
    except Exception as e:
        logger.error(f"Unexpected error during LLM call for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(
            f"Unexpected error during report generation: {e}", cause=e
        ) from e

    if not response_content:
        logger.warning(f"Empty response from LLM for project {project_id}")
        return "Report generation returned empty content"

    # Extract content between <article> tags
    article_pattern = r"<article>(.*?)</article>"
    match = re.search(article_pattern, response_content, re.DOTALL)

    if match:
        response_content = match.group(1).strip()
    else:
        # If no <article> tags found, keep original content but remove any existing tags
        response_content = (
            response_content.replace("<article>", "").replace("</article>", "").strip()
        )

    logger.debug(f"Report content for project {project_id}: {response_content[:200]}...")

    return response_content
