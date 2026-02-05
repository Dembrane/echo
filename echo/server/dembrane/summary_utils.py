"""
Utility functions for conversation summarization.
This module provides reusable summarization functionality that can be used by
various parts of the application (reports, chat overview mode, etc.).
"""

import asyncio
import logging
from typing import List, Optional
from dataclasses import field, dataclass

from dembrane.directus import directus
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.dependency_auth import DirectusSession

logger = logging.getLogger("dembrane.summary_utils")


@dataclass
class SummarizationResult:
    """Result of a single conversation summarization attempt."""

    conversation_id: str
    success: bool
    error: Optional[str] = None
    summary: Optional[str] = None


@dataclass
class BatchSummarizationResult:
    """Result of batch summarization for multiple conversations."""

    succeeded: List[str] = field(default_factory=list)
    failed: List[str] = field(default_factory=list)
    errors: dict = field(default_factory=dict)  # conversation_id -> error message

    @property
    def total_processed(self) -> int:
        return len(self.succeeded) + len(self.failed)

    @property
    def success_rate(self) -> float:
        if self.total_processed == 0:
            return 0.0
        return len(self.succeeded) / self.total_processed


async def safe_summarize_conversation(conversation_id: str) -> SummarizationResult:
    """
    Safely summarize a single conversation, catching and logging errors.

    This function wraps the conversation summarization API endpoint and handles
    all exceptions gracefully.

    Args:
        conversation_id: The ID of the conversation to summarize.

    Returns:
        SummarizationResult with success status and any error details.
    """
    # Import here to avoid circular imports
    from dembrane.api.conversation import summarize_conversation

    try:
        result = await summarize_conversation(
            conversation_id, auth=DirectusSession(user_id="none", is_admin=True)
        )
        summary = result.get("summary") if isinstance(result, dict) else None
        return SummarizationResult(
            conversation_id=conversation_id,
            success=True,
            summary=summary,
        )
    except Exception as e:
        logger.warning(
            f"Failed to summarize conversation {conversation_id}: {type(e).__name__}: {e}"
        )
        return SummarizationResult(
            conversation_id=conversation_id,
            success=False,
            error=str(e),
        )


async def ensure_conversation_summaries(
    conversation_ids: List[str],
    batch_size: int = 5,
    skip_existing: bool = True,
) -> BatchSummarizationResult:
    """
    Ensure all specified conversations have summaries, generating missing ones.

    This function checks which conversations already have summaries and only
    generates summaries for those that don't (unless skip_existing is False).

    Args:
        conversation_ids: List of conversation IDs to process.
        batch_size: Number of conversations to summarize concurrently.
        skip_existing: If True, skip conversations that already have summaries.

    Returns:
        BatchSummarizationResult with details about successes and failures.
    """
    if not conversation_ids:
        return BatchSummarizationResult()

    result = BatchSummarizationResult()

    # Determine which conversations need summarization
    ids_to_summarize = conversation_ids

    if skip_existing:
        # Fetch conversations to check for existing summaries
        try:
            conversations = await run_in_thread_pool(
                directus.get_items,
                "conversation",
                {
                    "query": {
                        "filter": {"id": {"_in": conversation_ids}},
                        "fields": ["id", "summary"],
                    },
                },
            )

            if conversations:
                # Filter to only those without summaries
                ids_with_summary = {
                    conv["id"]
                    for conv in conversations
                    if conv.get("summary") and len(str(conv["summary"]).strip()) > 0
                }
                ids_to_summarize = [cid for cid in conversation_ids if cid not in ids_with_summary]

                # Mark existing summaries as succeeded
                result.succeeded.extend(list(ids_with_summary))

                logger.info(
                    f"Skipping {len(ids_with_summary)} conversations with existing summaries, "
                    f"will summarize {len(ids_to_summarize)} conversations"
                )
        except Exception as e:
            logger.warning(f"Failed to check existing summaries: {e}. Will try all.")

    if not ids_to_summarize:
        logger.info("All conversations already have summaries")
        return result

    logger.info(f"Generating summaries for {len(ids_to_summarize)} conversations")

    # Process in batches
    for i in range(0, len(ids_to_summarize), batch_size):
        batch = ids_to_summarize[i : i + batch_size]
        tasks = [safe_summarize_conversation(conv_id) for conv_id in batch]

        # Use return_exceptions=True to prevent one failure from canceling others
        batch_results = await asyncio.gather(*tasks, return_exceptions=True)

        for batch_result in batch_results:
            if isinstance(batch_result, Exception):
                # This shouldn't happen since safe_summarize_conversation catches exceptions
                logger.error(f"Unexpected exception during batch summarization: {batch_result}")
                # We don't know which conversation failed, so we can't track it
            elif isinstance(batch_result, SummarizationResult):
                if batch_result.success:
                    result.succeeded.append(batch_result.conversation_id)
                else:
                    result.failed.append(batch_result.conversation_id)
                    if batch_result.error:
                        result.errors[batch_result.conversation_id] = batch_result.error

    logger.info(
        f"Summarization complete: {len(result.succeeded)} succeeded, "
        f"{len(result.failed)} failed out of {len(conversation_ids)} total"
    )

    return result


async def get_conversations_with_summaries(
    project_id: str,
    limit: Optional[int] = None,
) -> List[dict]:
    """
    Fetch conversations for a project that have summaries, ordered by recency.

    Args:
        project_id: The project ID to fetch conversations for.
        limit: Optional limit on number of conversations to return.

    Returns:
        List of conversation dicts with id, participant_name, summary, etc.
    """
    query: dict = {
        "query": {
            "filter": {
                "_and": [
                    {"project_id": {"_eq": project_id}},
                    {"summary": {"_nnull": True}},
                    {"summary": {"_nempty": True}},
                ]
            },
            "fields": [
                "id",
                "participant_name",
                "participant_email",
                "summary",
                "created_at",
                "updated_at",
                "duration",
                "count(chunks)",
            ],
            "sort": "-updated_at",
        },
    }

    if limit:
        query["query"]["limit"] = limit

    try:
        conversations = await run_in_thread_pool(
            directus.get_items,
            "conversation",
            query,
        )
        return conversations if conversations else []
    except Exception as e:
        logger.error(f"Failed to fetch conversations with summaries for project {project_id}: {e}")
        return []


async def get_all_conversations_for_overview(
    project_id: str,
) -> List[dict]:
    """
    Fetch all conversations for a project for overview mode, ordered by recency.

    This includes conversations with or without summaries.

    Args:
        project_id: The project ID to fetch conversations for.

    Returns:
        List of conversation dicts with id, participant_name, summary, chunks_count, etc.
    """
    try:
        conversations = await run_in_thread_pool(
            directus.get_items,
            "conversation",
            {
                "query": {
                    "filter": {"project_id": {"_eq": project_id}},
                    "fields": [
                        "id",
                        "participant_name",
                        "participant_email",
                        "summary",
                        "created_at",
                        "updated_at",
                        "duration",
                        "count(chunks)",
                    ],
                    "sort": "-updated_at",
                    "limit": 1000,  # Reasonable upper limit
                },
            },
        )
        return conversations if conversations else []
    except Exception as e:
        logger.error(f"Failed to fetch conversations for project {project_id}: {e}")
        return []
