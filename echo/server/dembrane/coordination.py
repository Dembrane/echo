"""
Coordination utilities for tracking conversation processing state.

This module provides Redis-based counters to track pending chunks for a conversation,
enabling reliable coordination between async Dramatiq tasks.

Key pattern:
1. When chunks are created for transcription, increment the pending counter
2. When a chunk finishes (success or recoverable error), decrement the counter
3. When counter reaches 0, trigger finalization (merge, summary, set flags)

This solves the race condition where summary/merge would start before all
transcriptions completed.
"""

import json
from typing import Any
from logging import getLogger

import redis

from dembrane.settings import get_settings

logger = getLogger("dembrane.coordination")

settings = get_settings()
REDIS_URL = settings.cache.redis_url

# Use a different DB than Dramatiq (which uses /1) to avoid conflicts
# Using /2 for coordination data
_COORDINATION_DB = 2

# Key prefix for coordination data
_KEY_PREFIX = "coord"

# TTL for coordination keys (24 hours) - cleanup stale data
_KEY_TTL_SECONDS = 60 * 60 * 24


def _get_sync_redis_client() -> Any:
    """
    Get a sync Redis client for use in Dramatiq tasks.
    Creates a new connection each time (simple, thread-safe).

    Returns redis.Redis but typed as Any to avoid mypy issues with redis library.
    """
    # Handle SSL for managed Redis
    url = REDIS_URL
    ssl_params = ""
    if url.startswith("rediss://") and "?ssl_cert_reqs=" not in url:
        ssl_params = "?ssl_cert_reqs=none"

    connection_string = f"{url}/{_COORDINATION_DB}{ssl_params}"
    return redis.from_url(connection_string, decode_responses=True)


def _pending_chunks_key(conversation_id: str) -> str:
    """Redis key for tracking pending chunks count."""
    return f"{_KEY_PREFIX}:pending_chunks:{conversation_id}"


def _processing_started_key(conversation_id: str) -> str:
    """Redis key for tracking if processing has started."""
    return f"{_KEY_PREFIX}:processing_started:{conversation_id}"


# ------------------------------------------------------------------------------
# Pending Chunks Counter
# ------------------------------------------------------------------------------


def increment_pending_chunks(conversation_id: str, count: int = 1) -> int:
    """
    Increment the pending chunks counter for a conversation.

    Call this when creating transcription tasks for chunks.

    Args:
        conversation_id: The conversation ID
        count: Number of chunks to add (default 1)

    Returns:
        The new count after incrementing
    """
    client = _get_sync_redis_client()
    key = _pending_chunks_key(conversation_id)

    try:
        new_count = int(client.incrby(key, count))
        client.expire(key, _KEY_TTL_SECONDS)
        logger.debug(f"Incremented pending chunks for {conversation_id}: {new_count}")
        return new_count
    finally:
        client.close()


def decrement_pending_chunks(conversation_id: str) -> int:
    """
    Decrement the pending chunks counter for a conversation.

    Call this when a chunk transcription completes (success OR recoverable error).

    Args:
        conversation_id: The conversation ID

    Returns:
        The new count after decrementing (0 means all chunks are done)
    """
    client = _get_sync_redis_client()
    key = _pending_chunks_key(conversation_id)

    try:
        new_count = int(client.decr(key))

        # Clamp to 0 (shouldn't go negative, but be safe)
        if new_count < 0:
            logger.warning(
                f"Pending chunks for {conversation_id} went negative ({new_count}), "
                "clamping to 0. This may indicate a bug in increment/decrement calls."
            )
            client.set(key, 0)
            new_count = 0

        logger.debug(f"Decremented pending chunks for {conversation_id}: {new_count}")
        return new_count
    finally:
        client.close()


def get_pending_chunks(conversation_id: str) -> int:
    """
    Get the current pending chunks count for a conversation.

    Args:
        conversation_id: The conversation ID

    Returns:
        The current count (0 if key doesn't exist)
    """
    client = _get_sync_redis_client()
    key = _pending_chunks_key(conversation_id)

    try:
        count = client.get(key)
        return int(count) if count else 0
    finally:
        client.close()


def reset_pending_chunks(conversation_id: str) -> None:
    """
    Reset/delete the pending chunks counter for a conversation.

    Call this when a conversation is fully finalized or abandoned.

    Args:
        conversation_id: The conversation ID
    """
    client = _get_sync_redis_client()
    key = _pending_chunks_key(conversation_id)

    try:
        client.delete(key)
        logger.debug(f"Reset pending chunks for {conversation_id}")
    finally:
        client.close()


# ------------------------------------------------------------------------------
# Processing Started Flag
# ------------------------------------------------------------------------------


def mark_processing_started(conversation_id: str) -> bool:
    """
    Mark that processing has started for a conversation (set-if-not-exists).

    This is used for idempotency - to prevent duplicate processing triggers.

    Args:
        conversation_id: The conversation ID

    Returns:
        True if this is the first call (flag was set), False if already set
    """
    client = _get_sync_redis_client()
    key = _processing_started_key(conversation_id)

    try:
        # SETNX returns True if key was set, False if it already existed
        was_set = client.setnx(key, "1")
        if was_set:
            client.expire(key, _KEY_TTL_SECONDS)
            logger.debug(f"Marked processing started for {conversation_id}")
        return bool(was_set)
    finally:
        client.close()


def is_processing_started(conversation_id: str) -> bool:
    """
    Check if processing has started for a conversation.

    Args:
        conversation_id: The conversation ID

    Returns:
        True if processing has started, False otherwise
    """
    client = _get_sync_redis_client()
    key = _processing_started_key(conversation_id)

    try:
        exists_count = int(client.exists(key))
        return exists_count > 0
    finally:
        client.close()


def clear_processing_started(conversation_id: str) -> None:
    """
    Clear the processing started flag for a conversation.

    Call this when a conversation is fully finalized.

    Args:
        conversation_id: The conversation ID
    """
    client = _get_sync_redis_client()
    key = _processing_started_key(conversation_id)

    try:
        client.delete(key)
        logger.debug(f"Cleared processing started flag for {conversation_id}")
    finally:
        client.close()


# ------------------------------------------------------------------------------
# Finish In Progress Flag (prevents scheduler duplicate processing)
# ------------------------------------------------------------------------------


def _finish_in_progress_key(conversation_id: str) -> str:
    """Redis key for tracking if finish is in progress."""
    return f"{_KEY_PREFIX}:finish_in_progress:{conversation_id}"


def _finalize_in_progress_key(conversation_id: str) -> str:
    """Redis key for tracking if finalization is in progress."""
    return f"{_KEY_PREFIX}:finalize_in_progress:{conversation_id}"


def _chunk_decremented_key(conversation_id: str, chunk_id: str) -> str:
    """Redis key for tracking if a chunk has already been decremented."""
    return f"{_KEY_PREFIX}:chunk_decremented:{conversation_id}:{chunk_id}"


# Short TTL for locks - 5 minutes should be enough for task to complete
_FINISH_LOCK_TTL_SECONDS = 60 * 5
_FINALIZE_LOCK_TTL_SECONDS = 60 * 5
_CHUNK_DECREMENT_TTL_SECONDS = 60 * 60  # 1 hour - longer since retries can be delayed


def mark_finish_in_progress(conversation_id: str) -> bool:
    """
    Mark that finish processing is in progress for a conversation.

    This prevents duplicate task_finish_conversation_hook from running
    when scheduler queues the same conversation multiple times.

    Args:
        conversation_id: The conversation ID

    Returns:
        True if this is the first call (lock acquired), False if already in progress
    """
    client = _get_sync_redis_client()
    key = _finish_in_progress_key(conversation_id)

    try:
        # SETNX returns True if key was set, False if it already existed
        was_set = client.setnx(key, "1")
        if was_set:
            client.expire(key, _FINISH_LOCK_TTL_SECONDS)
            logger.debug(f"Acquired finish lock for {conversation_id}")
        return bool(was_set)
    finally:
        client.close()


def clear_finish_in_progress(conversation_id: str) -> None:
    """
    Clear the finish-in-progress flag for a conversation.

    Called after finish processing completes.

    Args:
        conversation_id: The conversation ID
    """
    client = _get_sync_redis_client()
    key = _finish_in_progress_key(conversation_id)

    try:
        client.delete(key)
        logger.debug(f"Cleared finish lock for {conversation_id}")
    finally:
        client.close()


# ------------------------------------------------------------------------------
# Finalize In Progress Flag (prevents duplicate finalization)
# ------------------------------------------------------------------------------


def mark_finalize_in_progress(conversation_id: str) -> bool:
    """
    Mark that finalization is in progress for a conversation.

    Prevents duplicate task_finalize_conversation from running.

    Args:
        conversation_id: The conversation ID

    Returns:
        True if this is the first call (lock acquired), False if already in progress
    """
    client = _get_sync_redis_client()
    key = _finalize_in_progress_key(conversation_id)

    try:
        was_set = client.setnx(key, "1")
        if was_set:
            client.expire(key, _FINALIZE_LOCK_TTL_SECONDS)
            logger.debug(f"Acquired finalize lock for {conversation_id}")
        return bool(was_set)
    finally:
        client.close()


def clear_finalize_in_progress(conversation_id: str) -> None:
    """Clear the finalize-in-progress flag."""
    client = _get_sync_redis_client()
    key = _finalize_in_progress_key(conversation_id)

    try:
        client.delete(key)
        logger.debug(f"Cleared finalize lock for {conversation_id}")
    finally:
        client.close()


# ------------------------------------------------------------------------------
# Chunk Decrement Tracking (prevents double-decrement on retry)
# ------------------------------------------------------------------------------


def mark_chunk_decremented(conversation_id: str, chunk_id: str) -> bool:
    """
    Mark that a chunk's pending count has been decremented.

    Prevents double-decrement when Dramatiq retries a failed task.

    Args:
        conversation_id: The conversation ID
        chunk_id: The chunk ID

    Returns:
        True if this is the first decrement (should proceed), False if already decremented
    """
    client = _get_sync_redis_client()
    key = _chunk_decremented_key(conversation_id, chunk_id)

    try:
        was_set = client.setnx(key, "1")
        if was_set:
            client.expire(key, _CHUNK_DECREMENT_TTL_SECONDS)
            logger.debug(f"Marked chunk {chunk_id} as decremented for {conversation_id}")
        return bool(was_set)
    finally:
        client.close()


# ------------------------------------------------------------------------------
# Summarization In Progress Flag (prevents duplicate summarization)
# ------------------------------------------------------------------------------


def _summarize_in_progress_key(conversation_id: str) -> str:
    """Redis key for tracking if summarization is in progress."""
    return f"{_KEY_PREFIX}:summarize_in_progress:{conversation_id}"


# 10 minute TTL - summarization can take a while with LLM calls
_SUMMARIZE_LOCK_TTL_SECONDS = 60 * 10


def mark_summarize_in_progress(conversation_id: str) -> bool:
    """
    Mark that summarization is in progress for a conversation.

    Prevents duplicate task_summarize_conversation from running concurrently,
    which would cause duplicate LLM calls.

    Args:
        conversation_id: The conversation ID

    Returns:
        True if this is the first call (lock acquired), False if already in progress
    """
    client = _get_sync_redis_client()
    key = _summarize_in_progress_key(conversation_id)

    try:
        was_set = client.setnx(key, "1")
        if was_set:
            client.expire(key, _SUMMARIZE_LOCK_TTL_SECONDS)
            logger.debug(f"Acquired summarize lock for {conversation_id}")
        return bool(was_set)
    finally:
        client.close()


def clear_summarize_in_progress(conversation_id: str) -> None:
    """Clear the summarize-in-progress flag."""
    client = _get_sync_redis_client()
    key = _summarize_in_progress_key(conversation_id)

    try:
        client.delete(key)
        logger.debug(f"Cleared summarize lock for {conversation_id}")
    finally:
        client.close()


# ------------------------------------------------------------------------------
# Cleanup
# ------------------------------------------------------------------------------


def cleanup_conversation_coordination(conversation_id: str) -> None:
    """
    Clean up all coordination data for a conversation.

    Call this when a conversation is fully finalized or abandoned.

    Args:
        conversation_id: The conversation ID
    """
    client = _get_sync_redis_client()

    try:
        keys = [
            _pending_chunks_key(conversation_id),
            _processing_started_key(conversation_id),
            _finish_in_progress_key(conversation_id),
            _finalize_in_progress_key(conversation_id),
            _summarize_in_progress_key(conversation_id),
        ]
        deleted = client.delete(*keys)

        # Also clean up any chunk_decremented keys for this conversation
        # Use SCAN to find keys matching the pattern
        pattern = f"{_KEY_PREFIX}:chunk_decremented:{conversation_id}:*"
        cursor = 0
        chunk_keys = []
        while True:
            cursor, found_keys = client.scan(cursor, match=pattern, count=100)
            chunk_keys.extend(found_keys)
            if cursor == 0:
                break

        if chunk_keys:
            client.delete(*chunk_keys)
            deleted += len(chunk_keys)

        logger.debug(f"Cleaned up {deleted} coordination keys for {conversation_id}")
    finally:
        client.close()


# ------------------------------------------------------------------------------
# AssemblyAI Webhook Coordination
# ------------------------------------------------------------------------------

_AAI_WEBHOOK_TTL_SECONDS = 60 * 60 * 24  # 24 hours
_AAI_WEBHOOK_PROCESSING_TTL_SECONDS = 60 * 10  # 10 minutes


def _assemblyai_webhook_key(transcript_id: str) -> str:
    return f"{_KEY_PREFIX}:aai_transcript:{transcript_id}"


def _assemblyai_webhook_processing_key(transcript_id: str) -> str:
    return f"{_KEY_PREFIX}:aai_transcript_processing:{transcript_id}"


def store_assemblyai_webhook_metadata(
    transcript_id: str,
    chunk_id: str,
    conversation_id: str,
    audio_file_uri: str,
    language: str | None,
    hotwords: list[str] | None,
    use_pii_redaction: bool,
    custom_guidance_prompt: str | None,
    anonymize_transcripts: bool,
) -> None:
    """Store metadata for webhook callback processing."""
    client = _get_sync_redis_client()
    key = _assemblyai_webhook_key(transcript_id)
    payload = {
        "chunk_id": chunk_id,
        "conversation_id": conversation_id,
        "audio_file_uri": audio_file_uri,
        "language": language,
        "hotwords": hotwords or [],
        "use_pii_redaction": use_pii_redaction,
        "custom_guidance_prompt": custom_guidance_prompt,
        "anonymize_transcripts": anonymize_transcripts,
    }

    try:
        client.set(key, json.dumps(payload))
        client.expire(key, _AAI_WEBHOOK_TTL_SECONDS)
        logger.debug(
            "Stored AssemblyAI webhook metadata for transcript %s chunk %s",
            transcript_id,
            chunk_id,
        )
    finally:
        client.close()


def get_assemblyai_webhook_metadata(transcript_id: str) -> dict[str, Any] | None:
    """Fetch AssemblyAI webhook metadata by transcript ID."""
    client = _get_sync_redis_client()
    key = _assemblyai_webhook_key(transcript_id)

    try:
        raw = client.get(key)
        if not raw:
            return None
        return json.loads(raw)
    finally:
        client.close()


def delete_assemblyai_webhook_metadata(transcript_id: str) -> None:
    """Delete webhook metadata after terminal handling."""
    client = _get_sync_redis_client()
    key = _assemblyai_webhook_key(transcript_id)

    try:
        client.delete(key)
    finally:
        client.close()


def mark_assemblyai_webhook_processing(transcript_id: str) -> bool:
    """Acquire a per-transcript webhook processing lock."""
    client = _get_sync_redis_client()
    key = _assemblyai_webhook_processing_key(transcript_id)

    try:
        was_set = client.setnx(key, "1")
        if was_set:
            client.expire(key, _AAI_WEBHOOK_PROCESSING_TTL_SECONDS)
        return bool(was_set)
    finally:
        client.close()


def clear_assemblyai_webhook_processing(transcript_id: str) -> None:
    """Release a per-transcript webhook processing lock."""
    client = _get_sync_redis_client()
    key = _assemblyai_webhook_processing_key(transcript_id)

    try:
        client.delete(key)
    finally:
        client.close()
