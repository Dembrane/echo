"""
Synchronous report generation pipeline for Dramatiq workers.

Uses native concurrency primitives for the dramatiq-gevent environment:
- dramatiq.group() + GroupCallbacks for summarization fan-out
- gevent.pool.Pool for concurrent transcript I/O
- router_completion() (sync litellm) for the LLM call

This makes the entire pipeline synchronous — no asyncio, no event loops,
no "Event loop is closed" corruption from greenlet interleaving.
"""

import re
import logging
from typing import Callable, Optional

import backoff
import sentry_sdk
from litellm.utils import token_counter
from litellm.exceptions import (
    Timeout,
    APIError,
    RateLimitError,
    BadRequestError,
    ContextWindowExceededError,
    ContentPolicyViolationError,
)

from dembrane.llms import MODELS, router_completion, get_completion_kwargs
from dembrane.prompts import render_prompt
from dembrane.directus import DirectusGenericException, directus_client_context
from dembrane.llm_router import get_min_context_length
from dembrane.report_utils import (
    REPORT_LLM,
    MAX_REPORT_CONTEXT_LENGTH,
    REPORT_GENERATION_TIMEOUT,
    ReportGenerationError,
)

logger = logging.getLogger("dembrane.report_generation")

# Redis key prefix for summarization completion signals
_SUMMARIES_DONE_KEY = "report:{report_id}:summaries_done"

# How long to wait for summaries before proceeding without them
_SUMMARY_WAIT_TIMEOUT = 10 * 60  # 10 minutes

# Poll interval for checking summary completion
_SUMMARY_POLL_INTERVAL = 3  # seconds


def _fetch_conversations_sync(project_id: str, fields: list) -> list:
    """Fetch conversations for a project (sync Directus call)."""
    try:
        with directus_client_context() as client:
            conversations = client.get_items(
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
        raise ReportGenerationError(
            f"Unexpected error fetching conversations: {e}", cause=e
        ) from e


def _fan_out_summarization(
    conversation_ids: list[str],
    report_id: int,
    progress_callback: Optional[Callable] = None,
) -> None:
    """
    Dispatch summarization for all conversations via dramatiq.group + GroupCallbacks.

    GroupCallbacks fires task_report_summarization_done when all messages in the
    group are acknowledged (success or failure). That callback sets a Redis key.
    """
    from dramatiq import group
    from dembrane.tasks import task_summarize_conversation, task_report_summarization_done

    if not conversation_ids:
        return

    if progress_callback:
        progress_callback(
            "summarizing",
            f"Summarizing {len(conversation_ids)} conversations...",
            {"total": len(conversation_ids)},
        )

    g = group(
        [task_summarize_conversation.message(cid) for cid in conversation_ids]
    )
    g.add_completion_callback(task_report_summarization_done.message(report_id))
    g.run()

    logger.info(
        f"Dispatched summarization group for {len(conversation_ids)} conversations, "
        f"report {report_id}"
    )


def _wait_for_summaries(
    report_id: int,
    progress_callback: Optional[Callable] = None,
    timeout: int = _SUMMARY_WAIT_TIMEOUT,
) -> bool:
    """
    Poll Redis for the summarization completion signal.

    Uses gevent.sleep() to yield to other greenlets while waiting.

    Returns True if summaries completed, False on timeout.
    """
    import gevent
    from dembrane.coordination import _get_sync_redis_client

    key = _SUMMARIES_DONE_KEY.format(report_id=report_id)
    elapsed = 0

    if progress_callback:
        progress_callback(
            "waiting_for_summaries",
            "Waiting for conversation summaries...",
            None,
        )

    while elapsed < timeout:
        client = _get_sync_redis_client()
        try:
            value = client.get(key)
            if value:
                # Clean up the signal key
                client.delete(key)
                logger.info(f"Summaries done for report {report_id} after {elapsed}s")
                return True
        finally:
            client.close()

        gevent.sleep(_SUMMARY_POLL_INTERVAL)
        elapsed += _SUMMARY_POLL_INTERVAL

        if progress_callback and elapsed % 15 == 0:
            progress_callback(
                "waiting_for_summaries",
                f"Still waiting for summaries ({elapsed}s)...",
                None,
            )

    logger.warning(
        f"Timed out waiting for summaries for report {report_id} after {timeout}s. "
        "Proceeding with available summaries."
    )
    return False


def _fetch_transcript_sync(conversation_id: str) -> Optional[str]:
    """
    Fetch the transcript for a single conversation (sync Directus call).

    Returns concatenated transcript string, or None on error.
    """
    try:
        with directus_client_context() as client:
            chunks = client.get_items(
                "conversation_chunk",
                {
                    "query": {
                        "filter": {"conversation_id": {"_eq": conversation_id}},
                        "fields": ["id", "transcript", "error"],
                        "sort": "timestamp",
                        "limit": 1500,
                    },
                },
            )

        if not chunks:
            return ""

        transcripts = []
        for chunk in chunks:
            if chunk.get("transcript"):
                transcripts.append(chunk["transcript"])

        return "\n".join(transcripts)
    except Exception as e:
        logger.warning(
            f"Failed to get transcript for conversation {conversation_id}: "
            f"{type(e).__name__}: {e}"
        )
        return None


def _fetch_transcripts_concurrent(
    conversation_ids: list[str],
    pool_size: int = 10,
) -> dict[str, Optional[str]]:
    """
    Fetch transcripts for multiple conversations concurrently using gevent.pool.Pool.

    Returns a dict mapping conversation_id -> transcript (or None on error).
    """
    import gevent.pool

    result: dict[str, Optional[str]] = {}

    if not conversation_ids:
        return result

    pool = gevent.pool.Pool(size=pool_size)

    def _fetch_one(cid: str) -> tuple[str, Optional[str]]:
        return cid, _fetch_transcript_sync(cid)

    for cid, transcript in pool.imap_unordered(_fetch_one, conversation_ids):
        result[cid] = transcript

    return result


@backoff.on_exception(
    backoff.expo,
    (RateLimitError, Timeout, APIError),
    max_tries=3,
    max_time=REPORT_GENERATION_TIMEOUT,
    on_backoff=lambda details: logger.warning(
        f"Retrying LLM call for report generation (attempt {details['tries']}): "
        f"{details.get('exception')}"
    ),
)
def _call_llm_for_report(prompt: str) -> str:
    """Call LLM synchronously with automatic retry for transient errors."""
    logger.debug("Calling LLM for report generation (sync)")
    response = router_completion(
        REPORT_LLM,
        messages=[{"role": "user", "content": prompt}],
        timeout=REPORT_GENERATION_TIMEOUT,
    )
    return response.choices[0].message.content


def generate_report_content(
    project_id: str,
    language: str,
    report_id: int,
    progress_callback: Optional[Callable[[str, str, Optional[dict]], None]] = None,
    user_instructions: str = "",
) -> str:
    """
    Generate a report for a project. Fully synchronous — safe for dramatiq-gevent workers.

    Pipeline:
    1. Fetch conversations (sync Directus)
    2. Fan out summarization via dramatiq.group()
    3. Poll Redis for completion signal (gevent.sleep)
    4. Refetch conversations with summaries
    5. Fetch transcripts via gevent.pool.Pool
    6. Build prompt with token budget
    7. Call LLM via router_completion() (sync litellm)

    Args:
        project_id: The project to generate a report for
        language: Language code for the report
        report_id: The report ID (used for Redis coordination keys)
        progress_callback: Optional callback for progress events

    Returns:
        The generated report content as a string

    Raises:
        ReportGenerationError: If the report cannot be generated
    """
    # 1. Initial fetch to get conversations with chunk counts
    conversations = _fetch_conversations_sync(
        project_id,
        fields=["id", "summary", "count(chunks)"],
    )

    logger.debug(f"Found {len(conversations)} conversations for project {project_id}")

    if not conversations:
        logger.info(f"No conversations found for project {project_id}")
        return "No conversations found for project"

    # Filter to conversations with chunks
    conversations_with_chunks = []
    for conv in conversations:
        try:
            chunks_count = int(conv.get("chunks_count", 0))
            if chunks_count > 0:
                conversations_with_chunks.append(conv)
        except (ValueError, TypeError):
            continue

    if not conversations_with_chunks:
        logger.info(f"No conversations with chunks found for project {project_id}")
        return "No conversations with content found for project"

    # Identify conversations that need summarization
    needs_summary = [
        conv["id"] for conv in conversations_with_chunks
        if not conv.get("summary")
    ]

    # 2. Fan out summarization if needed
    if needs_summary:
        logger.info(
            f"Dispatching summarization for {len(needs_summary)}/{len(conversations_with_chunks)} "
            f"conversations"
        )
        _fan_out_summarization(needs_summary, report_id, progress_callback)

        # 3. Wait for summaries to complete
        _wait_for_summaries(report_id, progress_callback)
    else:
        logger.info("All conversations already have summaries, skipping summarization fan-out")
        if progress_callback:
            progress_callback(
                "summarizing",
                "All conversations already summarized.",
                {"total": len(conversations_with_chunks)},
            )

    # 4. Refetch conversations with all needed fields
    try:
        conversations = _fetch_conversations_sync(
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
            continue

        try:
            chunks_count = int(conversation.get("chunks_count", 0))
        except (ValueError, TypeError):
            chunks_count = 0

        if chunks_count == 0:
            skipped_no_chunks += 1
            continue

        summary = conversation.get("summary")
        if not summary:
            skipped_no_summary += 1
            continue

        # Count tokens before adding
        try:
            summary_tokens = token_counter(
                messages=[{"role": "user", "content": summary}],
                model=get_completion_kwargs(REPORT_LLM)["model"],
            )
        except Exception:
            summary_tokens = len(summary) // 4

        if token_count + summary_tokens >= MAX_REPORT_CONTEXT_LENGTH:
            logger.info(
                f"Reached context limit. Added {len(conversation_data_dict)} conversations. "
                f"Token count: {token_count}, attempted to add: {summary_tokens}"
            )
            skipped_token_limit += 1
            break

        # Extract tags
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
        except (KeyError, TypeError, AttributeError):
            pass

        conversation_data_dict[conv_id] = {
            "name": conversation.get("participant_name"),
            "tags": tags_text.rstrip(", "),
            "transcript": summary,
            "created_at": conversation.get("created_at"),
            "updated_at": conversation.get("updated_at"),
        }
        token_count += summary_tokens

    # 5. Fetch transcripts concurrently via gevent.pool.Pool
    conv_ids_for_transcripts = [
        conv.get("id")
        for conv in conversations
        if conv.get("id") and conv.get("id") in conversation_data_dict
    ]

    if progress_callback:
        progress_callback("fetching_transcripts", "Fetching transcripts...", None)

    transcript_map = _fetch_transcripts_concurrent(conv_ids_for_transcripts)

    transcripts_added = 0
    transcripts_skipped = 0

    for conv_id in conv_ids_for_transcripts:
        transcript = transcript_map.get(conv_id)
        if transcript is None:
            transcripts_skipped += 1
            continue

        if transcript == "":
            continue

        try:
            transcript_tokens = token_counter(
                messages=[{"role": "user", "content": transcript}],
                model=get_completion_kwargs(REPORT_LLM)["model"],
            )
        except Exception:
            transcript_tokens = len(transcript) // 4

        if token_count + transcript_tokens < MAX_REPORT_CONTEXT_LENGTH:
            conversation_data_dict[conv_id]["transcript"] += "\n" + transcript
            token_count += transcript_tokens
            transcripts_added += 1
        else:
            break

    conversation_data_list = list(conversation_data_dict.values())

    if not conversation_data_list:
        logger.warning(f"No usable conversations for report in project {project_id}")
        return "No conversations with sufficient content available for report generation"

    logger.info(
        f"Report for project {project_id}: {len(conversation_data_list)} conversations "
        f"(skipped: {skipped_no_chunks} no chunks, {skipped_no_summary} no summary, "
        f"{skipped_token_limit} token limit). "
        f"Transcripts: {transcripts_added} added, {transcripts_skipped} failed. "
        f"Total tokens: {token_count}/{MAX_REPORT_CONTEXT_LENGTH}."
    )

    # 6. Build prompt
    prompt_message = render_prompt(
        "system_report", language, {
            "conversations": conversation_data_list,
            "user_instructions": user_instructions,
        }
    )

    if progress_callback:
        progress_callback("generating", "Generating report...", None)

    # 7. Call LLM synchronously
    try:
        response_content = _call_llm_for_report(prompt_message)
    except ContextWindowExceededError as e:
        logger.error(f"Context window exceeded for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(
            "Report content too large for the language model", cause=e
        ) from e
    except ContentPolicyViolationError as e:
        logger.error(f"Content policy violation for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(
            "Report content violates content policy", cause=e
        ) from e
    except BadRequestError as e:
        logger.error(f"Bad request error for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(
            f"Invalid request to language model: {e}", cause=e
        ) from e
    except (RateLimitError, Timeout, APIError) as e:
        logger.error(f"LLM call failed after retries for project {project_id}: {e}")
        sentry_sdk.capture_exception(e)
        raise ReportGenerationError(
            f"Report generation failed after multiple retries: {type(e).__name__}",
            cause=e,
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
        response_content = (
            response_content.replace("<article>", "").replace("</article>", "").strip()
        )

    return response_content
