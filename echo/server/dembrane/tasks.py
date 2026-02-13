# ruff: noqa: E402
import logging
from typing import Optional
from logging import getLogger

import dramatiq
import nest_asyncio

# Apply nest_asyncio to allow nested event loops in Dramatiq workers.
# This is required because workers run async code via run_async_in_new_loop(),
# which may contain nested async operations like run_in_thread_pool().
nest_asyncio.apply()

import lz4.frame
from dramatiq import group
from dramatiq.encoder import JSONEncoder, MessageData
from dramatiq.results import Results
from dramatiq_workflow import WorkflowMiddleware
from dramatiq.middleware import GroupCallbacks
from dramatiq.brokers.redis import RedisBroker
from dramatiq.rate_limits.backends import RedisBackend as RateLimitRedisBackend
from dramatiq.results.backends.redis import RedisBackend as ResultsRedisBackend

from dembrane.utils import generate_uuid, get_utc_timestamp
from dembrane.sentry import init_sentry
from dembrane.directus import (
    DirectusBadRequest,
    DirectusServerError,
    directus_client_context,
)
from dembrane.settings import get_settings
from dembrane.transcribe import transcribe_conversation_chunk
from dembrane.async_helpers import run_async_in_new_loop
from dembrane.conversation_utils import (
    collect_unfinished_conversations,
    collect_unsummarized_conversations,
    collect_conversations_needing_transcribed_flag,
)
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.processing_status_utils import (
    ProcessingStatusContext,
)

settings = get_settings()
REDIS_URL = settings.cache.redis_url

init_sentry()

logger = getLogger("dembrane.tasks")


class DramatiqLz4JSONEncoder(JSONEncoder):
    """
    Add compression to JSON data using lz4
    """

    def encode(self, data: MessageData) -> bytes:
        return lz4.frame.compress(super().encode(data))

    def decode(self, data: bytes) -> MessageData:
        try:
            decompressed = lz4.frame.decompress(data)
        except RuntimeError:
            # Uncompressed data from before the switch to lz4
            decompressed = data
        return super().decode(decompressed)


dramatiq.set_encoder(DramatiqLz4JSONEncoder())

# Setup Broker and Results Backend
assert REDIS_URL, "REDIS_URL environment variable is not set"

# FIXME: remove this once we have a proper SSL certificate, for the time we atleast isolate using vpc
ssl_params = ""
if REDIS_URL.startswith("rediss://") and "?ssl_cert_reqs=" not in REDIS_URL:
    ssl_params = "?ssl_cert_reqs=none"

redis_connection_string = REDIS_URL + "/1" + ssl_params


broker = RedisBroker(
    url=redis_connection_string,
    # this is to disable Prometheus (https://groups.io/g/dramatiq-users/topic/disabling_prometheus/80745532)
    # middleware=[
    #     AgeLimit,
    #     TimeLimit,
    #     ShutdownNotifications,
    #     Callbacks,
    #     Pipelines,
    #     Retries,
    # ],
)

# results backend
results_backend = ResultsRedisBackend(url=redis_connection_string)
broker.add_middleware(Results(backend=results_backend, result_ttl=60 * 60 * 1000))  # 1 hour

# workflow backend
workflow_backend = RateLimitRedisBackend(url=redis_connection_string)
broker.add_middleware(GroupCallbacks(workflow_backend))
broker.add_middleware(WorkflowMiddleware(workflow_backend))

dramatiq.set_broker(broker)


# Transcription Task
@dramatiq.actor(queue_name="network", priority=0)
def task_transcribe_chunk(
    conversation_chunk_id: str, conversation_id: str, use_pii_redaction: bool = False, anonymize_transcripts: bool = False
) -> None:
    """
    Transcribe a conversation chunk.

    After transcription (success or recoverable error), decrements the pending
    chunk counter. If counter reaches 0 and conversation is_finished, triggers
    finalization.
    """
    logger = getLogger("dembrane.tasks.task_transcribe_chunk")

    try:
        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_transcribe_chunk",
            message=f"for chunk {conversation_chunk_id}",
        ):
            transcribe_conversation_chunk(conversation_chunk_id, use_pii_redaction, anonymize_transcripts)

        # Transcription succeeded - decrement counter and check for finalization
        _on_chunk_transcription_done(conversation_id, conversation_chunk_id, logger)
        return

    except Exception as e:
        logger.error(f"Error transcribing chunk {conversation_chunk_id}: {e}")

        # Check if this was a recoverable error (chunk was marked as failed but
        # didn't raise). If transcribe_conversation_chunk raised, we need to
        # still decrement if it's a recoverable error type.
        from dembrane.transcribe import _is_recoverable_error

        if _is_recoverable_error(e):
            # Recoverable error - chunk is done (just with an error), decrement counter
            logger.info(
                f"Recoverable error for chunk {conversation_chunk_id}, "
                f"marking as done and checking finalization"
            )
            _on_chunk_transcription_done(conversation_id, conversation_chunk_id, logger)
            return  # Don't re-raise for recoverable errors

        # Non-recoverable error - still decrement counter but also raise
        # so Dramatiq can retry
        _on_chunk_transcription_done(conversation_id, conversation_chunk_id, logger)
        raise


def _on_chunk_transcription_done(
    conversation_id: str, chunk_id: str, logger: "logging.Logger"
) -> None:
    """
    Called when a chunk transcription is done (success or error).
    Decrements pending counter and triggers finalization if ready.

    Uses mark_chunk_decremented to prevent double-decrement on Dramatiq retry.
    """
    from dembrane.service import conversation_service
    from dembrane.coordination import mark_chunk_decremented, decrement_pending_chunks

    # Prevent double-decrement on retry
    if not mark_chunk_decremented(conversation_id, chunk_id):
        logger.info(f"Chunk {chunk_id} already decremented (likely a retry), skipping decrement")
        return

    # Decrement the pending counter
    remaining = decrement_pending_chunks(conversation_id)
    logger.info(
        f"Chunk {chunk_id} done. Remaining pending chunks for {conversation_id}: {remaining}"
    )

    if remaining == 0:
        # All chunks done - check if conversation is finished (user clicked finish)
        try:
            conversation = conversation_service.get_by_id_or_raise(conversation_id)

            if conversation.get("is_finished"):
                logger.info(
                    f"All chunks done and conversation {conversation_id} is_finished=True, "
                    f"triggering finalization"
                )
                task_finalize_conversation.send(conversation_id)
            else:
                logger.info(
                    f"All chunks done for {conversation_id} but is_finished=False, "
                    f"waiting for user to finish conversation"
                )
        except Exception as e:
            logger.error(f"Error checking conversation state for {conversation_id}: {e}")


@dramatiq.actor(queue_name="network", priority=20)
def task_finalize_conversation(conversation_id: str) -> None:
    """
    Finalize a conversation after all chunks are transcribed.

    This task is triggered when:
    1. All pending chunks have been transcribed (counter == 0)
    2. The conversation is_finished (user clicked finish or scheduler triggered)

    It performs:
    1. Sets is_all_chunks_transcribed = True
    2. Triggers merge task
    3. Triggers summary task
    4. Cleans up coordination data
    """
    logger = getLogger("dembrane.tasks.task_finalize_conversation")

    from dembrane.service import conversation_service
    from dembrane.coordination import (
        get_pending_chunks,
        mark_finalize_in_progress,
        cleanup_conversation_coordination,
    )

    try:
        logger.info(f"Finalizing conversation: {conversation_id}")

        # Double-check conditions (idempotency)
        conversation = conversation_service.get_by_id_or_raise(conversation_id)

        if conversation.get("is_all_chunks_transcribed"):
            logger.info(f"Conversation {conversation_id} already finalized, skipping")
            return

        # Atomic lock - only one finalization task proceeds
        if not mark_finalize_in_progress(conversation_id):
            logger.info(
                f"Conversation {conversation_id} finalization already in progress, skipping"
            )
            return

        pending = get_pending_chunks(conversation_id)
        counts = conversation_service.get_chunk_counts(conversation_id)

        if pending > 0 or counts["pending"] > 0:
            logger.warning(
                f"Finalization triggered but chunks still pending for {conversation_id}: "
                f"redis_pending={pending}, db_pending={counts['pending']}, "
                f"skipping (will be triggered again when chunks complete)"
            )
            # Clear lock so next attempt can proceed
            from dembrane.coordination import clear_finalize_in_progress

            clear_finalize_in_progress(conversation_id)
            return

        if not conversation.get("is_finished"):
            logger.warning(
                f"Finalization triggered but conversation {conversation_id} is_finished=False, "
                f"skipping (will be triggered when user finishes)"
            )
            # Clear lock so next attempt can proceed
            from dembrane.coordination import clear_finalize_in_progress

            clear_finalize_in_progress(conversation_id)
            return

        # All conditions met - finalize
        logger.info(f"All conditions met, finalizing conversation {conversation_id}")

        # Set the flag
        conversation_service.update(
            conversation_id=conversation_id,
            is_all_chunks_transcribed=True,
        )

        # Dispatch webhook for conversation.transcribed event
        try:
            from dembrane.service.webhook import dispatch_webhooks_for_event

            project_id = conversation.get("project_id")
            if project_id:
                dispatch_webhooks_for_event(
                    project_id=project_id,
                    conversation_id=conversation_id,
                    event="conversation.transcribed",
                )
        except Exception as e:
            logger.warning(f"Failed to dispatch conversation.transcribed webhook: {e}")

        # Trigger downstream tasks
        task_merge_conversation_chunks.send(conversation_id)
        task_summarize_conversation.send(conversation_id)

        # Clean up coordination data
        cleanup_conversation_coordination(conversation_id)

        logger.info(f"Conversation {conversation_id} finalization complete")
        return

    except Exception as e:
        logger.error(f"Error finalizing conversation {conversation_id}: {e}")
        raise


@dramatiq.actor(queue_name="network", priority=30)
def task_summarize_conversation(conversation_id: str) -> None:
    """
    Summarize a conversation. The results are not returned. You can find it in
    conversation["summary"] after the task is finished.

    This task is resilient to partial data - it will generate a summary from
    whatever transcripts are available, logging any chunks that were skipped.

    Uses mark_summarize_in_progress to prevent duplicate LLM calls when multiple
    triggers (finalization + catch-up scheduler) fire concurrently.
    """
    logger = getLogger("dembrane.tasks.task_summarize_conversation")

    from dembrane.coordination import mark_summarize_in_progress, clear_summarize_in_progress
    from dembrane.service.conversation import ConversationNotFoundException

    try:
        from dembrane.service import conversation_service

        conversation = conversation_service.get_by_id_or_raise(conversation_id)

        if conversation["is_finished"] and conversation["summary"] is not None:
            logger.info(f"Conversation {conversation_id} already summarized, skipping")
            return

        # Atomic lock - prevent duplicate summarization (expensive LLM calls)
        if not mark_summarize_in_progress(conversation_id):
            logger.info(
                f"Conversation {conversation_id} summarization already in progress, skipping"
            )
            return

        # Log chunk status before summarizing
        try:
            counts = conversation_service.get_chunk_counts(conversation_id)
            if counts["error"] > 0:
                logger.info(
                    f"Summarizing conversation {conversation_id} with partial data: "
                    f"{counts['ok']}/{counts['total']} chunks have transcripts, "
                    f"{counts['error']} chunks have errors"
                )
            else:
                logger.info(
                    f"Summarizing conversation {conversation_id}: "
                    f"{counts['ok']}/{counts['total']} chunks with transcripts"
                )
        except Exception as e:
            logger.warning(f"Could not get chunk counts for logging: {e}")

        from dembrane.api.conversation import summarize_conversation

        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_summarize_conversation",
        ):
            run_async_in_new_loop(
                summarize_conversation(
                    conversation_id=conversation_id,
                    auth=DependencyDirectusSession(user_id="none", is_admin=True),
                )
            )

        # Dispatch webhook for conversation.summarized event
        try:
            from dembrane.service.webhook import dispatch_webhooks_for_event

            project_id = conversation.get("project_id")
            if project_id:
                dispatch_webhooks_for_event(
                    project_id=project_id,
                    conversation_id=conversation_id,
                    event="conversation.summarized",
                )
        except Exception as e:
            logger.warning(f"Failed to dispatch conversation.summarized webhook: {e}")

        # Success - clear the lock
        clear_summarize_in_progress(conversation_id)
        return
    except ConversationNotFoundException:
        logger.error(f"Conversation not found: {conversation_id}")
        # Non-retriable error - clear lock
        clear_summarize_in_progress(conversation_id)
        return
    except Exception as e:
        logger.error(f"Error: {e}")
        # Retriable error - don't clear lock, let TTL handle it
        # This prevents catch-up task from starting duplicate work during retry window
        raise e from e


@dramatiq.actor(store_results=True, queue_name="cpu", priority=10)
def task_merge_conversation_chunks(conversation_id: str) -> None:
    """
    Merge conversation chunks.
    """
    logger = getLogger("dembrane.tasks.task_merge_conversation_chunks")

    from dembrane.service import conversation_service

    try:
        counts = conversation_service.get_chunk_counts(conversation_id)
        if counts["total"] == 0:
            logger.info(
                f"Conversation {conversation_id} has no chunks (total=0); skipping merge task."
            )
            return
    except Exception as e:
        # If we can't determine counts, proceed with existing logic (may retry if still failing)
        logger.debug(f"Could not fetch chunk counts before merge: {e}")

    try:
        try:
            conversation = conversation_service.get_by_id_or_raise(conversation_id)

            if conversation["is_finished"] and conversation["merged_audio_path"] is not None:
                logger.info(f"Conversation {conversation_id} already merged, skipping")
                return

        except Exception:
            logger.error(f"Conversation not found: {conversation_id}")
            return

        # local import to avoid circular imports
        from dembrane.api.exceptions import NoContentFoundException
        from dembrane.api.conversation import get_conversation_content

        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_merge_conversation_chunks",
        ):
            try:
                # Run async function in new event loop (CPU worker context)
                run_async_in_new_loop(
                    get_conversation_content(
                        conversation_id,
                        auth=DependencyDirectusSession(user_id="none", is_admin=True),
                        force_merge=True,
                        return_url=True,
                    )
                )
            except NoContentFoundException:
                logger.info(
                    f"No valid content found for conversation {conversation_id}; skipping merge task."
                )
                return

        return
    except Exception as e:
        logger.error(f"Error: {e}")
        raise e from e


@dramatiq.actor(queue_name="network", priority=30)
def task_finish_conversation_hook(conversation_id: str) -> None:
    """
    Handle user/scheduler signal that a conversation is finished.

    This task:
    1. Sets is_finished = True
    2. Checks if all chunks are already transcribed
    3. If yes, triggers finalization immediately
    4. If no, finalization will be triggered by the last transcription task

    This ensures merge/summary only run after ALL transcriptions complete.

    Uses mark_finish_in_progress to prevent duplicate processing from scheduler.
    """
    logger = getLogger("dembrane.tasks.task_finish_conversation_hook")

    from dembrane.service import conversation_service
    from dembrane.coordination import get_pending_chunks, mark_finish_in_progress
    from dembrane.service.conversation import ConversationNotFoundException

    try:
        logger.info(f"Finishing conversation: {conversation_id}")

        conversation_obj = conversation_service.get_by_id_or_raise(conversation_id)

        if conversation_obj["is_finished"]:
            logger.info(f"Conversation {conversation_id} already finished, skipping")
            return

        # Prevent duplicate processing - only first task proceeds
        if not mark_finish_in_progress(conversation_id):
            logger.info(
                f"Conversation {conversation_id} finish already in progress by another task, skipping"
            )
            return

        # Mark as finished (user intent)
        conversation_service.update(conversation_id=conversation_id, is_finished=True)
        logger.info(f"Marked conversation {conversation_id} as is_finished=True")

        # Check if all chunks are already transcribed
        pending = get_pending_chunks(conversation_id)
        counts = conversation_service.get_chunk_counts(conversation_id)

        logger.info(
            f"Conversation {conversation_id} state: "
            f"pending_redis={pending}, "
            f"db_counts={{total={counts['total']}, ok={counts['ok']}, "
            f"error={counts['error']}, pending={counts['pending']}}}"
        )

        if pending == 0 and counts["pending"] == 0 and counts["total"] > 0:
            # All chunks are fully processed (have transcript or error)
            # AND no chunks are actively being transcribed in Redis
            # Trigger finalization
            logger.info(
                f"All chunks already transcribed for {conversation_id}, triggering finalization"
            )
            task_finalize_conversation.send(conversation_id)
        elif counts["total"] == 0:
            # No chunks at all - still trigger finalization to set flags
            # (handles edge case of empty conversations)
            logger.info(
                f"No chunks for conversation {conversation_id}, "
                f"triggering finalization for empty conversation"
            )
            task_finalize_conversation.send(conversation_id)
        else:
            # Chunks still pending - finalization will be triggered by
            # the last task_transcribe_chunk when it completes
            logger.info(
                f"Waiting for {pending} pending chunks to complete for {conversation_id}, "
                f"finalization will be triggered automatically"
            )

        # Clear finish lock - we're done processing
        from dembrane.coordination import clear_finish_in_progress

        clear_finish_in_progress(conversation_id)
        return

    except ConversationNotFoundException:
        logger.error(f"NO RETRY: Conversation not found: {conversation_id}")
        # Clear lock on non-retriable error
        try:
            from dembrane.coordination import clear_finish_in_progress

            clear_finish_in_progress(conversation_id)
        except Exception:
            pass
        return

    except Exception as e:
        logger.error(f"Error: {e}")
        # Don't clear lock on retriable error - let retry proceed
        # Lock has 5 min TTL as safety net
        raise e from e


# cpu because it is also bottlenecked by the cpu queue due to the split_audio_chunk task
@dramatiq.actor(queue_name="cpu", priority=0)
def task_process_conversation_chunk(
    chunk_id: str,
    use_pii_redaction: bool = False,
) -> None:
    """
    Process a conversation chunk.

    Flow:
    1. Split large audio files into smaller chunks
    2. Register pending chunk count with coordination module
    3. Spawn transcription tasks for each split chunk
    """

    logger = getLogger("dembrane.tasks.task_process_conversation_chunk")
    try:
        from dembrane.service import conversation_service
        from dembrane.coordination import increment_pending_chunks

        chunk = conversation_service.get_chunk_by_id_or_raise(chunk_id)
        conversation_id = chunk["conversation_id"]
        logger.debug(f"Chunk {chunk_id} found in conversation: {conversation_id}")

        # Read is_anonymized from the conversation itself
        conversation = conversation_service.get_by_id_or_raise(conversation_id)
        anonymize_transcripts = bool(conversation.get("is_anonymized", False))
        logger.debug(f"Conversation {conversation_id} is_anonymized: {anonymize_transcripts}")

        # critical section
        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_process_conversation_chunk.split_audio_chunk",
            message=f"for chunk {chunk_id}",
        ):
            from dembrane.audio_utils import split_audio_chunk

            split_chunk_ids = split_audio_chunk(chunk_id, "mp3", delete_original=True)

        if split_chunk_ids is None:
            logger.error(f"Split audio chunk result is None for chunk: {chunk_id}")
            raise ValueError(f"Split audio chunk result is None for chunk: {chunk_id}")

        # Filter out None values
        valid_chunk_ids = [cid for cid in split_chunk_ids if cid is not None]

        if not valid_chunk_ids:
            logger.warning(f"No valid chunks after splitting for chunk: {chunk_id}")
            return

        logger.info(f"Split audio chunk result: {len(valid_chunk_ids)} chunks: {valid_chunk_ids}")

        # Register pending chunks BEFORE spawning transcription tasks
        # This ensures the counter is set before any transcription can complete
        pending_count = increment_pending_chunks(conversation_id, len(valid_chunk_ids))
        logger.info(
            f"Registered {len(valid_chunk_ids)} pending chunks for conversation {conversation_id}, "
            f"total pending: {pending_count}"
        )

        group(
            [
                task_transcribe_chunk.message(cid, conversation_id, use_pii_redaction, anonymize_transcripts)
                for cid in valid_chunk_ids
            ]
        ).run()

        return

    except Exception as e:
        from dembrane.audio_utils import FileTooSmallError

        # Handle FileTooSmallError gracefully - mark chunk with error, don't retry
        if isinstance(e, FileTooSmallError):
            logger.warning(
                f"Chunk {chunk_id} has audio file too small to process. "
                f"Marking with error instead of retrying. Error: {e}"
            )
            try:
                from dembrane.service import conversation_service

                conversation_service.update_chunk(chunk_id, error="Audio not playable")
                logger.info(f"Chunk {chunk_id} marked with error 'Audio not playable'")
            except Exception as update_error:
                logger.error(f"Failed to update chunk {chunk_id} with error: {update_error}")
            # Don't re-raise - this is a non-retriable error
            return

        logger.error(f"Error processing conversation chunk@[{chunk_id}]: {e}")
        raise e from e


@dramatiq.actor(queue_name="network")
def task_collect_and_finish_unfinished_conversations() -> None:
    logger = getLogger("dembrane.tasks.task_collect_and_finish_unfinished_conversations")

    try:
        logger.info(
            "running task_collect_and_finish_unfinished_conversations @ %s", get_utc_timestamp()
        )

        unfinished_conversation_ids = collect_unfinished_conversations()
        logger.info(f"Unfinished conversation ids: {unfinished_conversation_ids}")

        group(
            [
                task_finish_conversation_hook.message(conversation_id)
                for conversation_id in unfinished_conversation_ids
                if conversation_id is not None
            ]
        ).run()

        return
    except Exception as e:
        logger.error(f"Error collecting and finishing unfinished conversations: {e}")
        raise e from e


@dramatiq.actor(queue_name="network")
def task_reconcile_transcribed_flag() -> None:
    """
    Reconcile the is_all_chunks_transcribed flag for conversations that should have it set.

    This catches conversations where the normal finalization flow failed:
    - Audio conversations where task_finalize_conversation didn't run
    - TEXT conversations where chunks have transcripts from direct input

    For each conversation found, triggers task_finalize_conversation which will:
    1. Set is_all_chunks_transcribed = True
    2. Trigger merge and summarization tasks

    Runs periodically via the scheduler (every 3 minutes).
    """
    logger = getLogger("dembrane.tasks.task_reconcile_transcribed_flag")

    try:
        logger.info("running task_reconcile_transcribed_flag @ %s", get_utc_timestamp())

        conversation_ids = collect_conversations_needing_transcribed_flag()

        if not conversation_ids:
            logger.debug("No conversations need transcribed flag reconciliation")
            return

        logger.info(
            f"Found {len(conversation_ids)} conversations needing transcribed flag: "
            f"{conversation_ids}"
        )

        # Trigger finalization for each - it will set the flag and downstream tasks
        group(
            [
                task_finalize_conversation.message(conversation_id)
                for conversation_id in conversation_ids
                if conversation_id is not None
            ]
        ).run()

        return
    except Exception as e:
        logger.error(f"Error reconciling transcribed flags: {e}")
        raise e from e


@dramatiq.actor(queue_name="network")
def task_catch_up_unsummarized_conversations() -> None:
    """
    Catch-up task for conversations that are transcribed but missing summaries.

    Simple check: is_all_chunks_transcribed = True AND summary = null.
    The transcribed flag is the source of truth - set by task_reconcile_transcribed_flag
    or the normal finalization flow.

    Runs periodically via the scheduler as a safety net.
    """
    logger = getLogger("dembrane.tasks.task_catch_up_unsummarized_conversations")

    try:
        logger.info("running task_catch_up_unsummarized_conversations @ %s", get_utc_timestamp())

        unsummarized_conversation_ids = collect_unsummarized_conversations()

        if not unsummarized_conversation_ids:
            logger.debug("No unsummarized conversations found")
            return

        logger.info(
            f"Found {len(unsummarized_conversation_ids)} unsummarized conversations: {unsummarized_conversation_ids}"
        )

        group(
            [
                task_summarize_conversation.message(conversation_id)
                for conversation_id in unsummarized_conversation_ids
                if conversation_id is not None
            ]
        ).run()

        return
    except Exception as e:
        logger.error(f"Error catching up unsummarized conversations: {e}")
        raise e from e


@dramatiq.actor(queue_name="network", priority=50)
def task_create_view(
    project_analysis_run_id: str,
    user_query: str,
    user_query_context: Optional[str],
    language: str,
) -> None:
    logger = getLogger("dembrane.tasks.task_create_view")
    logger.info(f"Creating view for project_analysis_run_id: {project_analysis_run_id}")

    if not project_analysis_run_id or not user_query:
        logger.error(
            f"Invalid project_analysis_run_id: {project_analysis_run_id} or user_query: {user_query}"
        )
        return

    logger.info(f"User query: {user_query}")
    if user_query_context:
        logger.info("User query context provided (%d characters).", len(user_query_context))
    else:
        logger.info("No additional user query context provided.")
    logger.info("Requested language for view generation: %s", language or "unspecified")

    project_id: Optional[str] = None

    try:
        with directus_client_context() as client:
            project_analysis_run = client.get_item("project_analysis_run", project_analysis_run_id)

            if not project_analysis_run:
                logger.error(f"Project analysis run not found: {project_analysis_run_id}")
                return

            project_id = project_analysis_run["project_id"]
    except DirectusBadRequest as e:
        logger.error(
            f"Bad Directus request. Something item might be missing? analysis_run_id: {project_analysis_run_id} {e}"
        )
        return
    except DirectusServerError as e:
        logger.error(
            f"Can retry. Directus server down? analysis_run_id: {project_analysis_run_id} {e}"
        )
        raise e from e
    except Exception as e:
        logger.error(
            f"Can retry. Failed to get project_analysis_run: analysis_run_id: {project_analysis_run_id} {e}"
        )
        raise e from e

    with ProcessingStatusContext(
        project_analysis_run_id=project_analysis_run_id,
        project_id=project_id,
        event_prefix="task_create_view",
    ) as status_ctx:
        status_ctx.set_exit_message(
            "Topic modeler integration has been removed; skipping view creation."
        )
        logger.info(
            "Skipping task_create_view for project_analysis_run_id %s because external topic "
            "modeler support has been removed.",
            project_analysis_run_id,
        )
        return


@dramatiq.actor(queue_name="network", priority=50)
def task_create_project_library(project_id: str, language: str) -> None:
    logger = getLogger("dembrane.tasks.task_create_project_library")
    logger.info("Requested language for project library creation: %s", language or "unspecified")

    with ProcessingStatusContext(
        project_id=project_id,
        event_prefix="task_create_project_library",
    ) as status_ctx:
        logger.info(f"Creating project library for project: {project_id}")

        try:
            with directus_client_context() as client:
                project = client.get_item("project", project_id)

                if not project:
                    status_ctx.set_exit_message(f"Project not found: {project_id}")
                    logger.error(f"Project not found: {project_id}")
                    return

                new_run_id = client.create_item(
                    "project_analysis_run",
                    {
                        "id": generate_uuid(),
                        "project_id": project_id,
                    },
                )["data"]["id"]

                status_ctx.set_exit_message(f"Successfully created library: {new_run_id}")
                logger.info(f"Successfully created library: {new_run_id}")
        except DirectusBadRequest as e:
            status_ctx.set_exit_message(f"Bad Directus request: {str(e)}")
            logger.error(f"Bad Directus request: {str(e)}")
            return
        except DirectusServerError as e:
            status_ctx.set_exit_message(f"Can retry. Directus server down? {e}")
            logger.error(f"Can retry. Directus server down? {e}")
            raise e from e
        except Exception as e:
            status_ctx.set_exit_message(f"Can retry. Failed to create project analysis run: {e}")
            logger.error(f"Can retry. Failed to create project analysis run: {e}")
            raise e from e

        logger.info(
            "Skipping default view generation for project %s; JSON templates have been removed.",
            project_id,
        )
        return


@dramatiq.actor(
    queue_name="network",
    priority=40,
    max_retries=3,
    min_backoff=5000,
    max_backoff=60000,
)
def task_dispatch_webhook(webhook_id: str, payload: dict) -> None:
    """
    Dispatch a single webhook HTTP request.

    Uses Dramatiq's built-in retry mechanism for failures.
    Retries up to 3 times with exponential backoff (5s to 60s).

    Args:
        webhook_id: The webhook ID to dispatch
        payload: The pre-built payload to send
    """
    logger = getLogger("dembrane.tasks.task_dispatch_webhook")

    from dembrane.service.webhook import WebhookService, WebhookServiceException

    service = WebhookService()

    # Fetch webhook configuration
    try:
        with directus_client_context() as client:
            webhooks = client.get_items(
                "project_webhook",
                {
                    "query": {
                        "filter": {"id": {"_eq": webhook_id}},
                        "fields": ["id", "name", "url", "secret", "status"],
                    }
                },
            )
    except Exception as e:
        logger.error(f"Failed to fetch webhook {webhook_id}: {e}")
        raise  # Retry

    if not webhooks:
        logger.warning(f"Webhook {webhook_id} not found, skipping")
        return

    webhook = webhooks[0]

    # Check if webhook is still enabled
    if webhook.get("status") != "published":
        logger.info(f"Webhook {webhook_id} is not published, skipping")
        return

    # Dispatch the webhook
    try:
        status_code, response_text = service.dispatch_webhook_sync(webhook, payload)

        # Consider 2xx as success
        if 200 <= status_code < 300:
            logger.info(f"Webhook {webhook_id} dispatched successfully (status: {status_code})")
            return
        elif 400 <= status_code < 500:
            # Client errors (4xx) - don't retry, log and exit
            logger.warning(
                f"Webhook {webhook_id} returned client error {status_code}: {response_text[:200]}"
            )
            return
        else:
            # Server errors (5xx) or other - retry
            logger.warning(f"Webhook {webhook_id} returned error {status_code}, will retry")
            raise WebhookServiceException(f"Webhook returned status {status_code}")

    except WebhookServiceException:
        raise  # Re-raise for Dramatiq retry
    except Exception as e:
        logger.error(f"Webhook {webhook_id} dispatch failed: {e}")
        raise  # Retry on network errors etc.
