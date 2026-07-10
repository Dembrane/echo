# ruff: noqa: E402
import logging
from typing import Any, Optional
from logging import getLogger
from datetime import datetime, timezone, timedelta

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
    # Managed Redis closes idle connections; without health checks the
    # scheduler's pooled broker connection goes stale between cron firings and
    # enqueue() raises ConnectionError("Connection closed by server"), so the
    # dispatched task is silently dropped. health_check_interval revives idle
    # connections before use; keepalive keeps the socket warm. (passed through
    # to the underlying redis-py client)
    health_check_interval=25,
    socket_keepalive=True,
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


# ── Middleware: skip retries for unrecoverable errors ──────────────────


class SkipRetryOnUnrecoverableError(dramatiq.Middleware):
    """
    Prevents Dramatiq from retrying messages that failed with clearly
    unrecoverable errors (e.g. TypeError from a signature mismatch,
    or AttributeError from a missing method).

    Registered after the default Retries middleware. Since
    after_process_message runs in *reverse* registration order, this
    middleware's hook fires BEFORE Retries sees the failure. By setting
    the retry counter above max_retries, the Retries middleware will
    route the message to the dead-letter queue instead of re-enqueuing.
    """

    UNRECOVERABLE = (
        TypeError,
        SyntaxError,
        AttributeError,
        ImportError,
        NotImplementedError,
    )

    # Domain exceptions that should also skip retries — the missing
    # resource will not reappear on retry.
    UNRECOVERABLE_DOMAIN: tuple[type[Exception], ...] = ()

    @classmethod
    def _load_domain_exceptions(cls) -> None:
        if cls.UNRECOVERABLE_DOMAIN:
            return
        from dembrane.service.project import ProjectNotFoundException
        from dembrane.service.conversation import (
            ConversationNotFoundException,
            ConversationChunkNotFoundException,
        )

        cls.UNRECOVERABLE_DOMAIN = (
            ConversationChunkNotFoundException,
            ConversationNotFoundException,
            ProjectNotFoundException,
        )

    def after_process_message(
        # Dramatiq calls this hook with result= and exception= by keyword;
        # the parameter names are the contract and must not be renamed.
        self,
        broker: Any,  # noqa: ARG002
        message: Any,
        *,
        result: Any = None,  # noqa: ARG002
        exception: Any = None,
    ) -> None:
        if exception is None:
            return
        if isinstance(exception, self.UNRECOVERABLE):
            logger.warning(
                "Unrecoverable %s in %s — skipping retries: %s",
                type(exception).__name__,
                message.actor_name,
                exception,
            )
            message.options["retries"] = 99999
            return
        try:
            self._load_domain_exceptions()
        except ImportError:
            return
        if isinstance(exception, self.UNRECOVERABLE_DOMAIN):
            logger.warning(
                "Unrecoverable domain error %s in %s — skipping retries: %s",
                type(exception).__name__,
                message.actor_name,
                exception,
            )
            message.options["retries"] = 99999


broker.add_middleware(SkipRetryOnUnrecoverableError())


# Transcription Task
@dramatiq.actor(queue_name="network", priority=0)
def task_transcribe_chunk(
    conversation_chunk_id: str,
    conversation_id: str,
    use_pii_redaction: bool = False,
    anonymize_transcripts: bool = False,
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
            from dembrane.s3 import get_signed_url
            from dembrane.transcribe import (
                ASSEMBLYAI_WEBHOOK_URL,
                TRANSCRIPTION_PROVIDER,
                ASSEMBLYAI_WEBHOOK_SECRET,
                _fetch_chunk,
                _build_hotwords,
                _fetch_conversation,
                transcribe_audio_assemblyai,
            )
            from dembrane.coordination import store_assemblyai_webhook_metadata

            if TRANSCRIPTION_PROVIDER == "Dembrane-25-09" and ASSEMBLYAI_WEBHOOK_URL:
                chunk = _fetch_chunk(conversation_chunk_id)
                conversation = _fetch_conversation(chunk["conversation_id"])
                language = conversation["project_id"]["language"] or "en"
                hotwords = _build_hotwords(conversation)
                custom_guidance_prompt = conversation["project_id"].get(
                    "default_conversation_transcript_prompt"
                )
                signed_url = get_signed_url(chunk["path"], expires_in_seconds=3 * 24 * 60 * 60)

                _, response = transcribe_audio_assemblyai(
                    signed_url,
                    language=language,
                    hotwords=hotwords,
                    webhook_url=ASSEMBLYAI_WEBHOOK_URL,
                    webhook_secret=ASSEMBLYAI_WEBHOOK_SECRET,
                )

                transcript_id = response.get("transcript_id")
                if not transcript_id:
                    raise ValueError(
                        "AssemblyAI webhook submission succeeded but transcript_id was missing."
                    )

                store_assemblyai_webhook_metadata(
                    transcript_id=transcript_id,
                    chunk_id=conversation_chunk_id,
                    conversation_id=conversation_id,
                    audio_file_uri=signed_url,
                    language=language,
                    hotwords=hotwords,
                    use_pii_redaction=use_pii_redaction,
                    custom_guidance_prompt=custom_guidance_prompt,
                    anonymize_transcripts=anonymize_transcripts,
                )

                logger.info(
                    "Webhook mode: submitted transcript %s for chunk %s and freed worker",
                    transcript_id,
                    conversation_chunk_id,
                )
                return

            transcribe_conversation_chunk(
                conversation_chunk_id, use_pii_redaction, anonymize_transcripts
            )

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


@dramatiq.actor(queue_name="network", priority=0)
def task_correct_transcript(
    chunk_id: str,
    conversation_id: str,
    audio_file_uri: str,
    candidate_transcript: str,
    hotwords: list[str] | None,
    use_pii_redaction: bool,
    custom_guidance_prompt: str | None,
    assemblyai_response: dict[str, Any],
    anonymize_transcripts: bool = False,
) -> None:
    """Run transcript correction and persist the final transcript for webhook mode."""
    task_logger = getLogger("dembrane.tasks.task_correct_transcript")

    from dembrane.transcribe import (
        _save_transcript,
        _save_chunk_error,
        _transcript_correction_workflow,
    )

    fallback_transcript = candidate_transcript or "[Nothing to transcribe]"

    try:
        if anonymize_transcripts:
            from dembrane.pii_regex import regex_redact_pii

            fallback_transcript = regex_redact_pii(fallback_transcript) or "[Nothing to transcribe]"

        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_correct_transcript",
            message=f"for chunk {chunk_id}",
        ):
            corrected_transcript, note = _transcript_correction_workflow(
                audio_file_uri=audio_file_uri,
                candidate_transcript=fallback_transcript,
                hotwords=hotwords,
                use_pii_redaction=True if anonymize_transcripts else use_pii_redaction,
                custom_guidance_prompt=custom_guidance_prompt,
            )

        final_transcript = corrected_transcript or "[Nothing to transcribe]"
        if anonymize_transcripts:
            diarization = {
                "schema": "Dembrane-26-01-redaction",
                "data": {
                    "note": note,
                    "raw": {},
                    "error": None,
                },
            }
        else:
            diarization = {
                "schema": "Dembrane-25-09",
                "data": {
                    "note": note,
                    "raw": assemblyai_response,
                    "error": None,
                },
            }

        _save_transcript(chunk_id, final_transcript, diarization=diarization)
    except Exception as e:
        task_logger.error("Gemini correction failed for chunk %s: %s", chunk_id, e)

        try:
            if anonymize_transcripts:
                fallback_diarization = {
                    "schema": "Dembrane-26-01-redaction",
                    "data": {
                        "note": None,
                        "raw": {},
                        "error": str(e),
                    },
                }
            else:
                fallback_diarization = {
                    "schema": "Dembrane-25-09",
                    "data": {
                        "note": None,
                        "raw": assemblyai_response,
                        "error": str(e),
                    },
                }

            _save_transcript(
                chunk_id,
                fallback_transcript or "[Nothing to transcribe]",
                diarization=fallback_diarization,
            )
        except Exception as save_error:
            task_logger.error(
                "Failed to save fallback transcript for chunk %s: %s",
                chunk_id,
                save_error,
            )
            _save_chunk_error(chunk_id, f"Failed to save fallback transcript: {save_error}")
    finally:
        _on_chunk_transcription_done(conversation_id, chunk_id, task_logger)


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

    from dembrane.coordination import (
        mark_summarize_in_progress,
        clear_summarize_in_progress,
    )
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

        def _run_summary() -> None:
            with ProcessingStatusContext(
                conversation_id=conversation_id,
                event_prefix="task_summarize_conversation",
            ):
                run_async_in_new_loop(
                    lambda: summarize_conversation(
                        conversation_id=conversation_id,
                        auth=DependencyDirectusSession(user_id="none", is_admin=True),
                    )
                )

        _run_summary()

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
        # Tier-locked (free tier): summarize_conversation raises HTTPException 402
        # when the conversation is locked. Retrying is pointless — the lock only
        # lifts on upgrade, and dramatiq retries would just churn and eventually
        # dead-letter the message (lost). Skip retries and CLEAR the lock so the
        # catch-up scheduler (task_catch_up_unsummarized_conversations) can
        # re-attempt cleanly: summary stays null, so the conversation remains in
        # the catch-up set and gets summarized automatically once they upgrade.
        if getattr(e, "status_code", None) == 402:
            logger.info(
                f"Conversation {conversation_id} is tier-locked (402); skipping summary "
                "until the workspace upgrades (catch-up will retry)."
            )
            clear_summarize_in_progress(conversation_id)
            return
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
            conversation_service.get_by_id_or_raise(conversation_id)
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
                    lambda: get_conversation_content(
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


def _stamp_over_cap(conversation_id: str, logger: Any) -> None:
    """Compute and persist the is_over_cap stamp for a just-finished conversation.

    ADR 0001 soft-edge formula:
        is_over_cap = NOT tier_allows_overage(tier)
            AND (workspace.audio_hours - this_conversation.duration) >= included_hours

    Only fires on free + pilot; pioneer+ always evaluates to False.
    """
    from dembrane.service import project_service, conversation_service
    from dembrane.directus import directus, directus_client_context
    from dembrane.tier_capacity import compute_is_over_cap

    conversation = conversation_service.get_by_id_or_raise(conversation_id)
    project_id = conversation.get("project_id")
    if not project_id:
        logger.warning(f"Conversation {conversation_id} has no project_id, skipping stamp")
        return

    project = project_service.get_by_id_or_raise(project_id)
    workspace_id = project.get("workspace_id")
    if not workspace_id:
        logger.warning(f"Project {project_id} has no workspace_id, skipping stamp")
        return

    # Tier lives on the billing account. Fetch the workspace's account tier.
    with directus_client_context(directus) as client:
        workspace = client.get_item("workspace", workspace_id)
        account_id = (workspace or {}).get("billing_account_id")
        account = client.get_item("billing_account", account_id) if account_id else None
    tier = (account or {}).get("tier", "") if account else ""

    # Sum all conversation durations in this workspace (includes deleted rows
    # because deletions preserve billable duration).
    with directus_client_context(directus) as client:
        projects = client.get_items(
            "project",
            {
                "query": {
                    "filter": {"workspace_id": {"_eq": workspace_id}},
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
    if not isinstance(projects, list) or not projects:
        return
    project_ids = [p["id"] for p in projects]

    with directus_client_context(directus) as client:
        conversations = client.get_items(
            "conversation",
            {
                "query": {
                    "filter": {"project_id": {"_in": project_ids}},
                    "fields": ["duration"],
                    "limit": -1,
                }
            },
        )
    if not isinstance(conversations, list):
        conversations = []
    total_seconds = sum(c.get("duration") or 0 for c in conversations)
    workspace_audio_hours = total_seconds / 3600

    conversation_duration_hours = (conversation.get("duration") or 0) / 3600

    over_cap = compute_is_over_cap(tier, workspace_audio_hours, conversation_duration_hours)
    conversation_service.update(conversation_id=conversation_id, is_over_cap=over_cap)
    logger.info(
        f"Stamped is_over_cap={over_cap} on conversation {conversation_id} "
        f"(tier={tier}, ws_hours={workspace_audio_hours:.2f}, "
        f"conv_hours={conversation_duration_hours:.2f})"
    )


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

        # Stamp is_over_cap (ADR 0001) — must run after is_finished is set.
        # Let errors propagate so Dramatiq retries the stamp.
        _stamp_over_cap(conversation_id, logger)

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
                task_transcribe_chunk.message(
                    cid, conversation_id, use_pii_redaction, anonymize_transcripts
                )
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


@dramatiq.actor(queue_name="network", priority=50)
def task_report_summarization_done(report_id: int) -> None:
    """
    GroupCallbacks completion callback for report summarization.

    Fired automatically when all task_summarize_conversation messages in a
    dramatiq.group() are acknowledged. Retrieves the stored report parameters
    from Redis and dispatches task_create_report_continue (phase 2).
    """
    logger = getLogger("dembrane.tasks.task_report_summarization_done")
    import json

    from dembrane.coordination import _get_sync_redis_client

    client = _get_sync_redis_client()
    try:
        # Retrieve report generation params stored by task_create_report (phase 1)
        params_key = f"report:{report_id}:params"
        params_raw = client.get(params_key)
        if not params_raw:
            logger.error(
                f"No stored params found for report {report_id} at key {params_key}. "
                f"Cannot proceed to phase 2."
            )
            return

        params = json.loads(params_raw)
        client.delete(params_key)

        logger.info(f"Summaries done for report {report_id}, dispatching phase 2")
        task_create_report_continue.send(
            params["project_id"],
            report_id,
            params["language"],
            params.get("user_instructions", ""),
        )
    finally:
        client.close()


def _report_event_distinct_id(report_id_str: str, project_id: str) -> str:
    """Resolve the PostHog distinct_id for server-side report events: the
    report creator's email, so these merge with the creator's frontend person.
    Falls back to the directus user id, then the project id. Best-effort."""
    log = getLogger("dembrane.tasks.analytics")
    try:
        from dembrane.app_user import resolve_app_user

        with directus_client_context() as client:
            report_row = client.get_item("project_report", report_id_str)
        report_data = (report_row or {}).get("data") or report_row or {}
        creator_directus_id = report_data.get("user_created")
        if creator_directus_id:
            creator = run_async_in_new_loop(lambda: resolve_app_user(creator_directus_id))
            email = ((creator or {}).get("email") or "").lower()
            return email or str(creator_directus_id)
    except Exception:  # noqa: BLE001 — analytics is best-effort
        log.warning("could not resolve report distinct_id for %s", report_id_str)
    return project_id


@dramatiq.actor(queue_name="network", priority=50)
def task_create_report(
    project_id: str, report_id: int, language: str, user_instructions: str = ""
) -> None:
    """
    Phase 1 of report generation: validate, dispatch summarization fan-out.

    Does NOT block waiting for summaries. Instead:
    - If summaries are needed, fans them out via dramatiq.group() with a
      completion callback that triggers task_create_report_continue.
    - If all summaries already exist, sends task_create_report_continue
      immediately.

    This avoids deadlocking the network queue: the child summarization
    tasks run on the same queue, so blocking here would starve them of
    greenlet slots.
    """
    logger = getLogger("dembrane.tasks.task_create_report")
    logger.info(
        f"Starting report generation (phase 1) for project {project_id}, report {report_id}"
    )

    from dembrane.report_utils import ReportGenerationError
    from dembrane.report_events import publish_report_progress
    from dembrane.report_generation import dispatch_summarization_if_needed

    with ProcessingStatusContext(
        project_id=project_id,
        event_prefix="task_create_report",
        message=f"for report {report_id}",
    ):
        report_id_str = str(report_id)

        # Idempotency guard: check report is still draft (or transitioning from scheduled)
        try:
            with directus_client_context() as client:
                report = client.get_item("project_report", report_id_str)
                if not report or report.get("status") not in ("draft", "scheduled"):
                    logger.info(
                        f"Report {report_id} is not draft/scheduled (status={report.get('status') if report else 'missing'}), skipping"
                    )
                    return
                # If report was scheduled, transition to draft before generating
                if report.get("status") == "scheduled":
                    client.update_item("project_report", report_id_str, {"status": "draft"})
        except Exception as e:
            logger.error(f"Failed to check report status: {e}")
            raise

        def progress_callback(event_type: str, message: str, detail: Optional[dict] = None) -> None:
            try:
                publish_report_progress(report_id, event_type, message, detail)
            except Exception as e:
                logger.warning(f"Failed to publish progress event: {e}")

        from dembrane.analytics import capture_event_sync

        capture_event_sync(
            _report_event_distinct_id(report_id_str, project_id),
            "server_report_generation_started",
            {"project_id": project_id, "report_id": report_id, "language": language},
        )

        try:
            # Store params in Redis so the completion callback can retrieve
            # them and dispatch phase 2 (task_create_report_continue).
            import json

            from dembrane.coordination import _get_sync_redis_client

            redis_client = _get_sync_redis_client()
            try:
                redis_client.set(
                    f"report:{report_id}:params",
                    json.dumps(
                        {
                            "project_id": project_id,
                            "language": language,
                            "user_instructions": user_instructions,
                        }
                    ),
                    ex=3600,  # 1 hour TTL
                )
            finally:
                redis_client.close()

            summaries_dispatched = dispatch_summarization_if_needed(
                project_id,
                report_id,
                progress_callback,
            )

            if not summaries_dispatched:
                # All summaries already exist -- proceed to phase 2 immediately
                logger.info(
                    f"No summarization needed for report {report_id}, proceeding to phase 2"
                )
                task_create_report_continue.send(
                    project_id,
                    report_id,
                    language,
                    user_instructions,
                )
            else:
                # Summaries were dispatched. The completion callback
                # (task_report_summarization_done) will trigger phase 2.
                logger.info(
                    f"Summarization dispatched for report {report_id}, "
                    f"phase 2 will be triggered by completion callback"
                )

        except ReportGenerationError as e:
            logger.error(f"Report generation failed for report {report_id}: {e}")
            try:
                with directus_client_context() as client:
                    client.update_item(
                        "project_report",
                        report_id_str,
                        {
                            "status": "error",
                            "error_code": "GENERATION_FAILED",
                            "error_message": str(e),
                        },
                    )
            except Exception as update_err:
                logger.error(f"Failed to update report status to error: {update_err}")
            publish_report_progress(report_id, "failed", str(e))
            return

        except Exception as e:
            logger.error(f"Unexpected error in report phase 1 for report {report_id}: {e}")
            try:
                with directus_client_context() as client:
                    client.update_item(
                        "project_report",
                        report_id_str,
                        {
                            "status": "error",
                            "error_code": "UNEXPECTED_ERROR",
                            "error_message": str(e),
                        },
                    )
            except Exception as update_err:
                logger.error(f"Failed to update report status to error: {update_err}")
            publish_report_progress(report_id, "failed", str(e))
            raise


@dramatiq.actor(queue_name="network", priority=50)
def task_create_report_continue(
    project_id: str, report_id: int, language: str, user_instructions: str = ""
) -> None:
    """
    Phase 2 of report generation: fetch transcripts, build prompt, call LLM, save.

    Triggered either directly by task_create_report (when no summarization was
    needed) or by task_report_summarization_done (after all summaries complete).

    Runs on the network queue because it uses gevent.pool.Pool for transcript
    fetching and gevent.sleep-compatible I/O.
    """
    logger = getLogger("dembrane.tasks.task_create_report_continue")
    logger.info(
        f"Starting report generation (phase 2) for project {project_id}, report {report_id}"
    )

    from dembrane.report_utils import ReportGenerationError
    from dembrane.report_events import publish_report_progress
    from dembrane.report_generation import generate_report_after_summaries

    with ProcessingStatusContext(
        project_id=project_id,
        event_prefix="task_create_report_continue",
        message=f"for report {report_id}",
    ):
        report_id_str = str(report_id)

        # Idempotency guard: check report is still draft
        try:
            with directus_client_context() as client:
                report = client.get_item("project_report", report_id_str)
                if not report or report.get("status") != "draft":
                    logger.info(
                        f"Report {report_id} is not draft (status={report.get('status') if report else 'missing'}), skipping phase 2"
                    )
                    return
        except Exception as e:
            logger.error(f"Failed to check report status: {e}")
            raise

        def progress_callback(event_type: str, message: str, detail: Optional[dict] = None) -> None:
            try:
                publish_report_progress(report_id, event_type, message, detail)
            except Exception as e:
                logger.warning(f"Failed to publish progress event: {e}")

        try:
            content = generate_report_after_summaries(
                project_id,
                language,
                progress_callback=progress_callback,
                user_instructions=user_instructions,
            )

            # Re-check report status before saving (user may have cancelled)
            with directus_client_context() as client:
                report_check = client.get_item("project_report", report_id_str)
                if not report_check or report_check.get("status") != "draft":
                    logger.info(
                        f"Report {report_id} status changed to "
                        f"{report_check.get('status') if report_check else 'missing'} "
                        f"during generation, skipping save"
                    )
                    return

            # Success: update report to archived
            with directus_client_context() as client:
                client.update_item(
                    "project_report",
                    report_id_str,
                    {
                        "content": content,
                        "status": "archived",
                        "date_created": get_utc_timestamp().isoformat(),
                    },
                )

            publish_report_progress(report_id, "completed", "Report ready")
            logger.info(f"Report {report_id} generated for project {project_id}")

            # Server-side success event: the client report_generated is fired
            # from the browser on SSE completion, so it misses every host who
            # closed the tab. This is the reliable count + generation-time anchor.
            from dembrane.analytics import capture_event_sync

            capture_event_sync(
                _report_event_distinct_id(report_id_str, project_id),
                "server_report_generated",
                {"project_id": project_id, "report_id": report_id, "language": language},
            )

            # Notify the report's creator. Keep the audience tight —
            # fanning to every workspace member on every report would
            # spam inboxes. If we want a wider broadcast later, derive
            # audience via project visibility + project_membership.
            try:
                from dembrane.app_user import resolve_app_user
                from dembrane.notifications import emit_sync

                with directus_client_context() as client:
                    report_row = client.get_item("project_report", report_id_str)
                    project_row = client.get_item("project", project_id) if project_id else None
                report_data = (report_row or {}).get("data") or report_row or {}
                creator_directus_id = report_data.get("user_created")
                if creator_directus_id:
                    creator = run_async_in_new_loop(lambda: resolve_app_user(creator_directus_id))
                    if creator:
                        project_name = (project_row or {}).get("name") or "your project"
                        emit_sync(
                            audience_user_id=creator["id"],
                            event_code="REPORT_READY",
                            title="Your report is ready",
                            message=f"**{project_name}** — open to review.",
                            action="NAVIGATE_REPORT",
                            ref_project_id=project_id,
                            ref_report_id=report_id_str,
                            ref_workspace_id=(project_row or {}).get("workspace_id"),
                        )
            except Exception as e:
                logger.warning(f"Failed to emit REPORT_READY notification: {e}")

            # Dispatch report.generated webhook
            try:
                from dembrane.service.webhook import dispatch_webhooks_for_report_event

                dispatch_webhooks_for_report_event(project_id, report_id_str, "report.generated")
            except Exception as e:
                logger.warning(f"Failed to dispatch report.generated webhook: {e}")

        except ReportGenerationError as e:
            logger.error(f"Report generation failed for report {report_id}: {e}")
            try:
                with directus_client_context() as client:
                    client.update_item(
                        "project_report",
                        report_id_str,
                        {
                            "status": "error",
                            "error_code": "GENERATION_FAILED",
                            "error_message": str(e),
                        },
                    )
            except Exception as update_err:
                logger.error(f"Failed to update report status to error: {update_err}")
            publish_report_progress(report_id, "failed", str(e))
            # Non-retriable — tell the creator so they don't keep waiting.
            try:
                from dembrane.app_user import resolve_app_user
                from dembrane.notifications import emit_sync

                with directus_client_context() as client:
                    report_row = client.get_item("project_report", report_id_str)
                    project_row = client.get_item("project", project_id) if project_id else None
                report_data = (report_row or {}).get("data") or report_row or {}
                creator_directus_id = report_data.get("user_created")
                if creator_directus_id:
                    creator = run_async_in_new_loop(lambda: resolve_app_user(creator_directus_id))
                    if creator:
                        emit_sync(
                            audience_user_id=creator["id"],
                            event_code="REPORT_FAILED",
                            title="Report generation ran into a problem",
                            message="Open the report to retry or check details.",
                            action="NAVIGATE_REPORT",
                            ref_project_id=project_id,
                            ref_report_id=report_id_str,
                            ref_workspace_id=(project_row or {}).get("workspace_id"),
                        )
            except Exception as notif_err:
                logger.warning(f"Failed to emit REPORT_FAILED: {notif_err}")
            from dembrane.analytics import capture_event_sync

            capture_event_sync(
                _report_event_distinct_id(report_id_str, project_id),
                "server_report_generation_failed",
                {
                    "project_id": project_id,
                    "report_id": report_id,
                    "error_code": "GENERATION_FAILED",
                },
            )
            return

        except Exception as e:
            logger.error(f"Unexpected error generating report {report_id}: {e}")
            from dembrane.analytics import capture_event_sync

            capture_event_sync(
                _report_event_distinct_id(report_id_str, project_id),
                "server_report_generation_failed",
                {
                    "project_id": project_id,
                    "report_id": report_id,
                    "error_code": "UNEXPECTED_ERROR",
                },
            )
            try:
                with directus_client_context() as client:
                    client.update_item(
                        "project_report",
                        report_id_str,
                        {
                            "status": "error",
                            "error_code": "UNEXPECTED_ERROR",
                            "error_message": str(e),
                        },
                    )
            except Exception as update_err:
                logger.error(f"Failed to update report status to error: {update_err}")
            publish_report_progress(report_id, "failed", str(e))
            raise


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


@dramatiq.actor(queue_name="network", priority=50)
def task_check_scheduled_reports() -> None:
    """Reconciler: ensure every still-scheduled report has a generate_report
    scheduled_task (ECHO-863).

    The create/update report paths enqueue a durable scheduled_task directly and
    the unified runner (task_process_scheduled_tasks) does the actual dispatch.
    This no longer dispatches itself; it only backfills a scheduled_task for any
    report still in `scheduled` that lacks one — covering reports scheduled
    before this migration and any enqueue that failed. Idempotent.
    """
    from dembrane.scheduled_tasks import TASK_GENERATE_REPORT, enqueue_task_sync

    logger = getLogger("dembrane.tasks.task_check_scheduled_reports")

    try:
        with directus_client_context() as client:
            reports = client.get_items(
                "project_report",
                {
                    "query": {
                        "filter": {
                            "status": {"_eq": "scheduled"},
                            "deleted_at": {"_null": True},
                        },
                        "fields": [
                            "id",
                            "project_id",
                            "language",
                            "user_instructions",
                            "scheduled_at",
                        ],
                        "limit": 100,
                    }
                },
            )

        if not reports:
            return

        # report_ids that already have a pending/processing generate_report task.
        with directus_client_context() as client:
            existing = client.get_items(
                "scheduled_task",
                {
                    "query": {
                        "filter": {
                            "task_type": {"_eq": TASK_GENERATE_REPORT},
                            "status": {"_in": ["scheduled", "processing"]},
                        },
                        "fields": ["payload"],
                        "limit": -1,
                    }
                },
            )
        covered: set[str] = set()
        if isinstance(existing, list):
            for t in existing:
                rid = (t.get("payload") or {}).get("report_id")
                if rid is not None:
                    covered.add(str(rid))

        enqueued = 0
        for report in reports:
            report_id = report.get("id")
            project_id = report.get("project_id")
            scheduled_at = report.get("scheduled_at")
            if not report_id or not project_id or not scheduled_at:
                continue
            if str(report_id) in covered:
                continue
            try:
                with directus_client_context() as client:
                    enqueue_task_sync(
                        client,
                        task_type=TASK_GENERATE_REPORT,
                        scheduled_at_iso=scheduled_at,
                        payload={
                            "report_id": report_id,
                            "project_id": project_id,
                            "language": report.get("language") or "en",
                            "user_instructions": report.get("user_instructions") or "",
                        },
                    )
                enqueued += 1
            except Exception as e:
                logger.error("Failed to backfill scheduled_task for report %s: %s", report_id, e)

        if enqueued:
            logger.info("Backfilled %d scheduled report task(s)", enqueued)

    except Exception as e:
        logger.error(f"Error reconciling scheduled reports: {e}")
        raise


@dramatiq.actor(queue_name="network", priority=50)
def task_reconcile_canvas_tick_tasks() -> None:
    """Reconciler: ensure active canvas loops have a pending canvas_tick row."""
    from dembrane.canvas.ticks import reconcile_missing_canvas_tick_tasks

    logger = getLogger("dembrane.tasks.task_reconcile_canvas_tick_tasks")
    try:
        enqueued = run_async_in_new_loop(lambda: reconcile_missing_canvas_tick_tasks())
    except Exception as e:
        logger.error("Error reconciling canvas tick tasks: %s", e)
        raise
    if enqueued:
        logger.info("Backfilled %d canvas tick task(s)", enqueued)


# ── Generic durable scheduled-task runner (ECHO-863) ─────────────────────────
# Polls the scheduled_task collection for due one-shot tasks, claims them, and
# dispatches by task_type. See dembrane/scheduled_tasks.py for the model. Fired
# once a minute by the scheduler; handlers must be idempotent.


@dramatiq.actor(queue_name="network", priority=50)
def task_process_scheduled_tasks() -> None:
    """Claim and dispatch every scheduled_task whose time has come.

    Reconciles stale `processing` rows first (crash recovery), then claims due
    rows and runs each handler. A handler raising marks that one row `failed`
    (with the error) and moves on; it does not abort the batch.
    """
    from dembrane.scheduled_tasks import (
        claim_due_tasks,
        mark_task_failed,
        mark_task_completed,
        reconcile_stale_claims,
    )

    task_logger = getLogger("dembrane.tasks.task_process_scheduled_tasks")

    with directus_client_context() as client:
        reset = reconcile_stale_claims(client)
        if reset:
            task_logger.info("reset %d stale scheduled_task claim(s)", reset)
        due = claim_due_tasks(client, limit=50)

    if not due:
        return

    task_logger.info("processing %d due scheduled_task(s)", len(due))
    for row in due:
        task_id = str(row.get("id"))
        try:
            _dispatch_scheduled_task(row)
        except Exception as exc:
            task_logger.exception("scheduled_task %s (%s) failed", task_id, row.get("task_type"))
            with directus_client_context() as client:
                mark_task_failed(client, task_id, str(exc))
            continue
        with directus_client_context() as client:
            mark_task_completed(client, task_id)


def _dispatch_scheduled_task(row: dict) -> None:
    from dembrane.scheduled_tasks import (
        TASK_CANVAS_TICK,
        TASK_GENERATE_REPORT,
        TASK_REVOKE_STAFF_SUPPORT,
        TASK_EXPIRE_SUPPORT_REQUEST,
        TASK_SUPPORT_TOGGLE_REMINDER,
    )

    task_type = row.get("task_type")
    payload = row.get("payload") or {}
    if task_type == TASK_REVOKE_STAFF_SUPPORT:
        _run_revoke_staff_support(payload)
    elif task_type == TASK_GENERATE_REPORT:
        _run_generate_report(payload)
    elif task_type == TASK_CANVAS_TICK:
        _run_canvas_tick(payload)
    elif task_type == TASK_EXPIRE_SUPPORT_REQUEST:
        _run_expire_support_request(payload)
    elif task_type == TASK_SUPPORT_TOGGLE_REMINDER:
        _run_support_toggle_reminder(payload)
    else:
        raise ValueError(f"unknown scheduled_task type: {task_type!r}")


def _run_canvas_tick(payload: dict) -> None:
    loop_id = payload.get("loop_id")
    if not loop_id:
        raise ValueError("canvas_tick payload missing loop_id")
    tick_kind = payload.get("tick_kind") or "scheduled"
    from dembrane.canvas.ticks import run_tick

    run_async_in_new_loop(lambda: run_tick(str(loop_id), str(tick_kind)))


async def _expire_support_request_async(request_id: str) -> bool:
    """Expire a still-pending request and tell the requester. Status-guarded, so
    an approval/denial that raced the timer wins and this is a no-op."""
    from dembrane.directus_async import async_directus
    from dembrane.support_access import (
        REQUEST_COLLECTION,
        EVENT_REQUEST_EXPIRED,
        record_support_access_event,
    )

    req = await async_directus.get_item(REQUEST_COLLECTION, request_id)
    if not req or req.get("status") != "pending":
        return False
    await async_directus.update_item(
        REQUEST_COLLECTION,
        request_id,
        {"status": "expired", "resolved_at": get_utc_timestamp().isoformat()},
    )
    await record_support_access_event(
        workspace_id=str(req.get("workspace_id")),
        event_code=EVENT_REQUEST_EXPIRED,
        staff_user_id=req.get("requested_by"),
        params={"request_id": request_id},
    )
    return True


def _run_expire_support_request(payload: dict) -> None:
    """Handler: expire a pending support access request (idempotent)."""
    task_logger = getLogger("dembrane.tasks.expire_support_request")
    request_id = payload.get("request_id")
    if not request_id:
        raise ValueError("expire_support_access_request payload missing request_id")
    expired = run_async_in_new_loop(_expire_support_request_async(str(request_id)))
    task_logger.info(
        "support access request %s %s",
        request_id,
        "expired" if expired else "already resolved; no-op",
    )


async def _support_toggle_reminder_async(workspace_id: str) -> Optional[datetime]:
    """One reminder tick. Returns the next fire time while the toggle is on, or
    None to stop. Nudges only when no staff session is active."""
    from dembrane.inheritance import membership_access_expired
    from dembrane.directus_async import async_directus
    from dembrane.support_access import (
        REMINDER_INTERVAL,
        EVENT_REMINDER_SENT,
        record_support_access_event,
    )

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or ws.get("deleted_at") or not ws.get("allow_support_access"):
        return None
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "source": {"_eq": "staff_support"},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "expires_at"],
                "limit": -1,
            }
        },
    )
    rows = rows if isinstance(rows, list) else []
    active = [r for r in rows if not membership_access_expired(r.get("expires_at"))]
    if not active:
        await record_support_access_event(workspace_id=workspace_id, event_code=EVENT_REMINDER_SENT)
    return datetime.now(timezone.utc) + REMINDER_INTERVAL


def _run_support_toggle_reminder(payload: dict) -> None:
    """Handler: weekly 'support access is still on' nudge; self-re-arming."""
    from dembrane.scheduled_tasks import TASK_SUPPORT_TOGGLE_REMINDER, enqueue_task_sync

    task_logger = getLogger("dembrane.tasks.support_toggle_reminder")
    workspace_id = payload.get("workspace_id")
    if not workspace_id:
        raise ValueError("support_toggle_reminder payload missing workspace_id")
    next_at = run_async_in_new_loop(_support_toggle_reminder_async(str(workspace_id)))
    if next_at is None:
        task_logger.info("reminder loop for workspace %s stopped", workspace_id)
        return
    with directus_client_context() as client:
        enqueue_task_sync(
            client,
            task_type=TASK_SUPPORT_TOGGLE_REMINDER,
            scheduled_at_iso=next_at.isoformat(),
            payload={"workspace_id": str(workspace_id)},
        )
    task_logger.info("reminder for workspace %s re-armed for %s", workspace_id, next_at.isoformat())


async def _revoke_staff_support_async(
    workspace_id: str, membership_id: str, org_id: Optional[str]
) -> bool:
    """Soft-delete the staff support membership and bust usage caches.
    Returns True if a row was actually revoked (False = already gone)."""
    from dembrane.cache_utils import invalidate_workspace_and_org_usage
    from dembrane.directus_async import async_directus
    from dembrane.support_access import (
        EVENT_STAFF_AUTO_REVOKED,
        send_support_access_notice,
        record_support_access_event,
        maybe_auto_disable_support_access,
    )

    revoked = False
    membership = await async_directus.get_item("workspace_membership", membership_id)
    # Guard on source: a soft-deleted id can be reactivated as a genuine `direct`
    # member (same row id), so a stale revoke must never strip a real membership.
    if (
        membership
        and not membership.get("deleted_at")
        and membership.get("source") == "staff_support"
    ):
        await async_directus.update_item(
            "workspace_membership",
            membership_id,
            {"deleted_at": get_utc_timestamp().isoformat()},
        )
        revoked = True
        staff_user_id = membership.get("user_id")
        await record_support_access_event(
            workspace_id=workspace_id,
            event_code=EVENT_STAFF_AUTO_REVOKED,
            staff_user_id=staff_user_id,
            params={"membership_id": membership_id},
            notify=False,
        )
        auto_disabled = await maybe_auto_disable_support_access(workspace_id=workspace_id)
        if not auto_disabled:
            await send_support_access_notice(
                workspace_id=workspace_id,
                event_code=EVENT_STAFF_AUTO_REVOKED,
                staff_user_id=staff_user_id,
            )
    # Always invalidate — seat/usage counts must reflect the revocation even if a
    # manual leave already removed the row.
    await invalidate_workspace_and_org_usage(workspace_id, org_id)
    return revoked


def _run_revoke_staff_support(payload: dict) -> None:
    """Handler: revoke a staff member's temporary support access (idempotent)."""
    task_logger = getLogger("dembrane.tasks.revoke_staff_support")
    workspace_id = payload.get("workspace_id")
    membership_id = payload.get("membership_id")
    org_id = payload.get("org_id")
    if not workspace_id or not membership_id:
        raise ValueError("revoke_staff_support payload missing workspace_id/membership_id")

    revoked = run_async_in_new_loop(
        lambda: _revoke_staff_support_async(workspace_id, membership_id, org_id)
    )
    if revoked:
        task_logger.info(
            "revoked staff support membership %s on workspace %s",
            membership_id,
            workspace_id,
        )
    else:
        task_logger.info(
            "staff support membership %s already gone on workspace %s; no-op",
            membership_id,
            workspace_id,
        )


def _run_generate_report(payload: dict) -> None:
    """Handler: fire a scheduled report. Transitions the report scheduled->draft
    and dispatches generation. Idempotent via the status guard — a report that
    is no longer `scheduled` (already drafted, deleted) is skipped."""
    task_logger = getLogger("dembrane.tasks.generate_report")
    report_id = payload.get("report_id")
    project_id = payload.get("project_id")
    language = payload.get("language") or "en"
    user_instructions = payload.get("user_instructions") or ""
    if not report_id or not project_id:
        raise ValueError("generate_report payload missing report_id/project_id")

    try:
        with directus_client_context() as client:
            report = client.get_item("project_report", str(report_id))
    except DirectusBadRequest:
        # Hard-deleted / unresolvable id — nothing to generate.
        task_logger.info("scheduled report %s not found; skipping", report_id)
        return
    if not report or report.get("deleted_at"):
        task_logger.info("scheduled report %s gone; skipping", report_id)
        return
    if report.get("status") != "scheduled":
        task_logger.info(
            "scheduled report %s no longer scheduled (status=%s); skipping",
            report_id,
            report.get("status"),
        )
        return

    with directus_client_context() as client:
        client.update_item("project_report", str(report_id), {"status": "draft"})
    task_create_report.send(project_id, report_id, language, user_instructions)
    task_logger.info("dispatched generation for scheduled report %s", report_id)


@dramatiq.actor(queue_name="network", priority=40)
def task_expire_staff_support_memberships() -> None:
    """Belt-and-suspenders sweep for staff support access (ECHO-863).

    The per-join scheduled_task is the primary 24h revocation path. This catch-up
    hard-stops any staff_support membership whose expires_at has elapsed but is
    still active (e.g. its scheduled_task row was lost or cancelled by mistake).
    Runs every 15 minutes. Idempotent: already-revoked rows are excluded by the
    deleted_at filter.
    """
    task_logger = getLogger("dembrane.tasks.task_expire_staff_support_memberships")
    now_iso = get_utc_timestamp().isoformat()

    with directus_client_context() as client:
        expired = client.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "source": {"_eq": "staff_support"},
                        "deleted_at": {"_null": True},
                        "expires_at": {"_nnull": True, "_lt": now_iso},
                    },
                    "fields": ["id", "workspace_id"],
                    "limit": -1,
                }
            },
        )

    if not isinstance(expired, list) or not expired:
        return

    task_logger.info("expiring %d overdue staff support membership(s)", len(expired))
    for row in expired:
        ws_id = row.get("workspace_id")
        # Resolve org_id so org-level usage caches bust too.
        org_id = None
        if ws_id:
            with directus_client_context() as client:
                ws = client.get_item("workspace", str(ws_id))
            org_id = ws.get("org_id") if ws else None
        try:
            run_async_in_new_loop(
                lambda ws_id=ws_id, membership_id=row["id"], org_id=org_id: (
                    _revoke_staff_support_async(str(ws_id), str(membership_id), org_id)
                )
            )
        except Exception:
            task_logger.exception("failed to expire staff support membership %s", row.get("id"))


@dramatiq.actor(queue_name="network", priority=30)
def task_send_downgrade_email(
    audience_app_user_ids: list[str],
    ws_name: str,
    workspace_id: str,
    from_tier: str,
    to_tier: str,
    effects: list[dict],
    downgraded_at_iso: str,
) -> None:
    """Send the matrix §3 post-downgrade email to a list of app_user ids.

    Runs in the network queue (SendGrid is network-bound). Silent on
    missing addresses; SendGrid misconfig is logged but never raises.
    """
    from datetime import datetime

    from dembrane.email import send_email_sync
    from dembrane.settings import get_settings as _get_settings

    logger = getLogger("dembrane.tasks.task_send_downgrade_email")

    if not audience_app_user_ids:
        return

    settings = _get_settings()

    with directus_client_context() as client:
        rows = (
            client.get_items(
                "app_user",
                {
                    "query": {
                        "filter": {"id": {"_in": audience_app_user_ids}},
                        "fields": ["email"],
                        "limit": -1,
                    }
                },
            )
            or []
        )

    emails = sorted(
        {(r.get("email") or "").strip() for r in rows if isinstance(r, dict) and r.get("email")}
    )
    if not emails:
        logger.info(
            "downgrade_email_skipped workspace=%s — no recipient addresses",
            workspace_id,
        )
        return

    freeze_items = [
        e["human"]
        for e in effects
        if isinstance(e, dict) and e.get("effect") == "freeze" and e.get("human")
    ]
    revert_items = [
        e["human"]
        for e in effects
        if isinstance(e, dict) and e.get("effect") == "revert" and e.get("human")
    ]

    try:
        when = datetime.fromisoformat(downgraded_at_iso.replace("Z", "+00:00"))
        downgraded_at_human = when.strftime("%d %B %Y")
    except Exception:
        downgraded_at_human = "today"

    base = (settings.urls.admin_base_url or "").rstrip("/")
    workspace_url = (
        f"{base}/w/{workspace_id}/settings/billing"
        if base
        else f"/w/{workspace_id}/settings/billing"
    )

    subject = f"{ws_name} moved to {to_tier}".replace("\r", " ").replace("\n", " ")

    ok = send_email_sync(
        to=emails,
        subject=subject,
        template="tier_downgraded",
        template_data={
            "workspace_name": ws_name,
            "from_tier": from_tier,
            "to_tier": to_tier,
            "downgraded_at_human": downgraded_at_human,
            "freeze_items": freeze_items,
            "revert_items": revert_items,
            "workspace_url": workspace_url,
        },
    )

    logger.info(
        "downgrade_email workspace=%s recipients=%d sent=%s",
        workspace_id,
        len(emails),
        ok,
    )


@dramatiq.actor(queue_name="network", priority=10, max_retries=3)
def task_send_invite_email(
    to: str,
    subject: str,
    template: str,
    template_data: dict,
    failure_context: str,
) -> None:
    """Send a workspace invite / workspace-added email.

    Called via invites.py's _enqueue_invite_email so the HTTP response
    returns before SendGrid round-trips. Runs on the network queue
    (SendGrid is a network I/O call). Retries with dramatiq defaults on
    failure — we raise from here when SendGrid returns non-2xx so the
    retry logic actually triggers (send_email_sync swallows exceptions
    and returns False, which wouldn't retry on its own).
    """
    from dembrane.email import send_email_sync

    task_logger = getLogger("dembrane.tasks.task_send_invite_email")

    ok = send_email_sync(
        to=to,
        subject=subject,
        template=template,
        template_data=template_data,
    )
    if not ok:
        task_logger.error(
            "invite_email_failed to=%s context=%s — will retry",
            to,
            failure_context,
        )
        try:
            import sentry_sdk

            sentry_sdk.capture_message(
                f"Invite email failed: {to} / {failure_context}",
                level="error",
            )
        except Exception:
            pass
        # Raise so dramatiq retries. The worker's retry middleware
        # applies exponential backoff (default 15s → minutes).
        raise RuntimeError(f"invite email send failed: {to}")


@dramatiq.actor(queue_name="network")
def task_expire_workspace_tiers() -> None:
    """Hourly cron: downgrade workspaces whose tier_expires_at has elapsed.

    For each expired workspace:
      1. Set tier = 'free'
      2. Populate downgraded_at / downgraded_from_tier (existing banner reads these)
      3. Clear tier_expires_at
      4. Run downgrade effects (whitelabel revert, policy freezes)
      5. Emit TIER_EXPIRED notification + email to workspace admins + billing

    Idempotent: already-free workspaces are excluded by the query filter.
    Re-running after a successful downgrade is a no-op.
    """
    task_logger = getLogger("dembrane.tasks.task_expire_workspace_tiers")
    task_logger.info("Checking for expired workspace tiers @ %s", get_utc_timestamp())

    from dembrane.directus import directus, directus_client_context

    now_iso = get_utc_timestamp().isoformat()

    # Tier + expiry live on the billing account. Scan accounts, act on the
    # workspace(s) each one covers (Phase 1: one workspace-scoped account each;
    # org-scoped accounts would fan out to all covered workspaces).
    with directus_client_context(directus) as client:
        expired_accounts = client.get_items(
            "billing_account",
            {
                "query": {
                    "filter": {
                        "tier_expires_at": {"_nnull": True, "_lt": now_iso},
                        "tier": {"_neq": "free"},
                        # Managed (offline) accounts never auto-downgrade: entitlements
                        # are decoupled from payment (ISSUE-021). Staff manages expiry.
                        "payment_mode": {"_neq": "offline"},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "tier", "workspace_id"],
                    "limit": -1,
                }
            },
        )

    if not isinstance(expired_accounts, list) or not expired_accounts:
        task_logger.debug("No expired billing-account tiers found")
        return

    task_logger.info("Found %d billing account(s) with expired tier", len(expired_accounts))

    for acc in expired_accounts:
        from_tier = acc.get("tier", "pioneer")
        ws_id = acc.get("workspace_id")
        # Resolve the workspace(s) the account covers. Workspace-scoped accounts
        # point at one; org-scoped accounts fan out to every attached workspace.
        if ws_id:
            covered_ws_ids = [ws_id]
        else:
            with directus_client_context(directus) as client:
                covered = client.get_items(
                    "workspace",
                    {
                        "query": {
                            "filter": {
                                "billing_account_id": {"_eq": acc.get("id")},
                                "deleted_at": {"_null": True},
                            },
                            "fields": ["id"],
                            "limit": -1,
                        }
                    },
                )
            covered_ws_ids = [w["id"] for w in covered] if isinstance(covered, list) else []
            if not covered_ws_ids:
                # Org account with no workspaces yet: just clear expiry on the
                # account so it doesn't re-trigger every run.
                with directus_client_context(directus) as client:
                    client.update_item(
                        "billing_account",
                        acc.get("id"),
                        {
                            "tier": "free",
                            "tier_expires_at": None,
                            "pre_warning_sent": False,
                        },
                    )
                task_logger.info("Expired org account %s -> free (no workspaces)", acc.get("id"))
                continue

        for target_ws_id in covered_ws_ids:
            with directus_client_context(directus) as client:
                ws = client.get_item("workspace", target_ws_id)
            if not ws or ws.get("deleted_at"):
                continue
            ws_name = ws.get("name") or "Untitled"
            try:
                effects = run_async_in_new_loop(
                    lambda target_ws_id=target_ws_id, from_tier=from_tier: _apply_tier_expiry(
                        target_ws_id, from_tier
                    )
                )
                task_logger.info(
                    "Expired workspace %s (%s): %s -> free, %d effects applied",
                    target_ws_id,
                    ws_name,
                    from_tier,
                    len(effects),
                )
                _send_tier_expired_notifications(target_ws_id, ws_name, from_tier, effects)
            except Exception:
                task_logger.exception(
                    "Failed to expire workspace %s (%s)",
                    target_ws_id,
                    ws_name,
                )


async def _apply_tier_expiry(workspace_id: str, from_tier: str) -> list[dict]:
    """Downgrade a single workspace to free tier and clear expiry date.

    Returns the list of downgrade effects applied.
    """
    from dembrane.cache_utils import invalidate_org_usage, invalidate_workspace_usage
    from dembrane.directus_async import async_directus
    from dembrane.tier_downgrade import apply_downgrade_effects
    from dembrane.billing_account import update_workspace_billing

    effects = await apply_downgrade_effects(workspace_id, from_tier, "free")

    # Tier lives on the billing account: write the downgrade there.
    now_iso = get_utc_timestamp().isoformat()
    await update_workspace_billing(
        workspace_id,
        {
            "tier": "free",
            "downgraded_at": now_iso,
            "downgraded_from_tier": from_tier,
            "tier_expires_at": None,
            "pre_warning_sent": False,
        },
    )

    await invalidate_workspace_usage(workspace_id)
    ws = await async_directus.get_item("workspace", workspace_id)
    if ws and ws.get("org_id"):
        await invalidate_org_usage(ws["org_id"])

    return effects


def _send_tier_expired_notifications(
    workspace_id: str,
    workspace_name: str,
    from_tier: str,
    effects: list[dict],
) -> None:
    """Emit TIER_EXPIRED in-app notification + email to admins + billing."""
    from dembrane.email import send_email_sync
    from dembrane.notifications import (
        emit_to_audience,
        audience_workspace_admins_and_billing,
    )

    task_logger = getLogger("dembrane.tasks._send_tier_expired_notifications")

    audience = run_async_in_new_loop(lambda: audience_workspace_admins_and_billing(workspace_id))
    if not audience:
        task_logger.info("No audience for TIER_EXPIRED on workspace %s", workspace_id)
        return

    run_async_in_new_loop(
        lambda: emit_to_audience(
            audience_user_ids=audience,
            event_code="TIER_EXPIRED",
            title=f"{workspace_name} tier expired",
            message=f"Moved from {from_tier} to free. Request an upgrade to restore features.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_workspace_id=workspace_id,
        )
    )

    settings = get_settings()
    base = (settings.urls.admin_base_url or "").rstrip("/")
    workspace_url = (
        f"{base}/w/{workspace_id}/settings/billing"
        if base
        else f"/w/{workspace_id}/settings/billing"
    )

    freeze_items = [
        e["human"]
        for e in effects
        if isinstance(e, dict) and e.get("effect") == "freeze" and e.get("human")
    ]
    revert_items = [
        e["human"]
        for e in effects
        if isinstance(e, dict) and e.get("effect") == "revert" and e.get("human")
    ]

    from dembrane.directus import directus

    with directus_client_context(directus) as client:
        rows = client.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": audience}},
                    "fields": ["email"],
                    "limit": -1,
                }
            },
        )
    emails = sorted(
        {
            (r.get("email") or "").strip()
            for r in (rows if isinstance(rows, list) else [])
            if isinstance(r, dict) and r.get("email")
        }
    )

    if not emails:
        return

    for email_addr in emails:
        ok = send_email_sync(
            to=email_addr,
            subject=f"{workspace_name} moved to free",
            template="tier_expired",
            template_data={
                "workspace_name": workspace_name,
                "from_tier": from_tier,
                "freeze_items": freeze_items,
                "revert_items": revert_items,
                "workspace_url": workspace_url,
            },
        )
        if not ok:
            task_logger.warning(
                "tier_expired email failed for workspace %s to %s",
                workspace_id,
                email_addr,
            )


@dramatiq.actor(queue_name="network")
def task_send_tier_expiry_prewarning() -> None:
    """Hourly cron: send 3-day pre-warning emails for expiring workspace tiers.

    Finds workspaces where tier_expires_at is within 3 days from now,
    tier != 'free', and pre_warning_sent = false. Emits TIER_EXPIRING_SOON
    notification + email, then sets pre_warning_sent = true.

    Idempotent: pre_warning_sent prevents duplicate warnings.
    """
    task_logger = getLogger("dembrane.tasks.task_send_tier_expiry_prewarning")
    task_logger.info(
        "Checking for workspaces needing tier expiry pre-warning @ %s", get_utc_timestamp()
    )

    from datetime import datetime as dt_cls, timezone, timedelta

    from dembrane.directus import directus, directus_client_context

    now = dt_cls.now(timezone.utc)
    three_days = now + timedelta(days=3)
    now_iso = now.isoformat()
    three_days_iso = three_days.isoformat()

    # Tier + expiry live on the billing account. Scan accounts, warn the
    # workspace(s) each covers (Phase 1: one workspace-scoped account each).
    with directus_client_context(directus) as client:
        candidates = client.get_items(
            "billing_account",
            {
                "query": {
                    "filter": {
                        "tier_expires_at": {
                            "_nnull": True,
                            "_gte": now_iso,
                            "_lte": three_days_iso,
                        },
                        "tier": {"_neq": "free"},
                        "pre_warning_sent": {"_eq": False},
                        # Managed (offline) accounts never get an auto-expiry warning;
                        # they don't auto-downgrade (ISSUE-021).
                        "payment_mode": {"_neq": "offline"},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "tier", "tier_expires_at", "workspace_id"],
                    "limit": -1,
                }
            },
        )

    if not isinstance(candidates, list) or not candidates:
        task_logger.debug("No billing accounts need tier expiry pre-warning")
        return

    task_logger.info("Found %d billing account(s) needing tier expiry pre-warning", len(candidates))

    for acc in candidates:
        account_id = acc.get("id")
        current_tier = acc.get("tier", "pioneer")
        expires_at_raw = acc.get("tier_expires_at", "")
        ws_id = acc.get("workspace_id")
        if not ws_id:
            task_logger.warning(
                "Billing account %s has no workspace_id; org-scoped fan-out not implemented, skipping",
                account_id,
            )
            continue
        with directus_client_context(directus) as client:
            ws = client.get_item("workspace", ws_id)
        if not ws or ws.get("deleted_at"):
            continue
        ws_name = ws.get("name") or "Untitled"

        try:
            _send_tier_expiring_soon(ws_id, ws_name, current_tier, expires_at_raw)

            from dembrane.directus import directus

            with directus_client_context(directus) as client:
                client.update_item("billing_account", account_id, {"pre_warning_sent": True})

            task_logger.info(
                "Pre-warning sent for workspace %s (%s), tier=%s, expires=%s",
                ws_id,
                ws_name,
                current_tier,
                expires_at_raw,
            )
        except Exception:
            task_logger.exception(
                "Failed to send pre-warning for workspace %s (%s)",
                ws_id,
                ws_name,
            )


def _send_tier_expiring_soon(
    workspace_id: str,
    workspace_name: str,
    current_tier: str,
    expires_at_raw: str,
) -> None:
    """Emit TIER_EXPIRING_SOON in-app notification + email to admins + billing."""
    from dembrane.email import send_email_sync
    from dembrane.notifications import (
        emit_to_audience,
        audience_workspace_admins_and_billing,
    )

    task_logger = getLogger("dembrane.tasks._send_tier_expiring_soon")

    audience = run_async_in_new_loop(lambda: audience_workspace_admins_and_billing(workspace_id))
    if not audience:
        task_logger.info("No audience for TIER_EXPIRING_SOON on workspace %s", workspace_id)
        return

    expires_date = _format_expiry_date(expires_at_raw)

    run_async_in_new_loop(
        lambda: emit_to_audience(
            audience_user_ids=audience,
            event_code="TIER_EXPIRING_SOON",
            title=f"{workspace_name} tier expires {expires_date}",
            message=f"Your {current_tier} tier expires on {expires_date}. Request an upgrade to keep full features.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_workspace_id=workspace_id,
        )
    )

    settings = get_settings()
    base = (settings.urls.admin_base_url or "").rstrip("/")
    workspace_url = (
        f"{base}/w/{workspace_id}/settings/billing"
        if base
        else f"/w/{workspace_id}/settings/billing"
    )

    from dembrane.directus import directus

    with directus_client_context(directus) as client:
        rows = client.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": audience}},
                    "fields": ["email"],
                    "limit": -1,
                }
            },
        )
    emails = sorted(
        {
            (r.get("email") or "").strip()
            for r in (rows if isinstance(rows, list) else [])
            if isinstance(r, dict) and r.get("email")
        }
    )

    if not emails:
        return

    for email_addr in emails:
        ok = send_email_sync(
            to=email_addr,
            subject=f"{workspace_name} tier expires {expires_date}",
            template="tier_expiring_soon",
            template_data={
                "workspace_name": workspace_name,
                "current_tier": current_tier,
                "expires_date": expires_date,
                "workspace_url": workspace_url,
            },
        )
        if not ok:
            task_logger.warning(
                "tier_expiring_soon email failed for workspace %s to %s",
                workspace_id,
                email_addr,
            )


def _format_expiry_date(expires_at_raw: str) -> str:
    """Format ISO timestamp to human-readable date like '15 May 2026'."""
    from datetime import datetime as dt_cls

    try:
        if expires_at_raw:
            dt = dt_cls.fromisoformat(expires_at_raw.replace("Z", "+00:00"))
            return f"{dt.day} {dt.strftime('%B %Y')}"
    except (ValueError, TypeError):
        pass
    return "soon"


@dramatiq.actor(queue_name="network")
def task_reconcile_pending_billing() -> None:
    """Catch-up: activate billing accounts whose first payment cleared but whose
    return-sync was missed (e.g. the customer closed the tab, or no public
    webhook in dev). Finds accounts in `pending` with a Mollie customer and
    reconciles each from Mollie. Idempotent — activation is a no-op if already
    active."""
    task_logger = getLogger("dembrane.tasks.task_reconcile_pending_billing")
    from dembrane.directus import directus, directus_client_context
    from dembrane.billing_service import sync_account_from_mollie

    with directus_client_context(directus) as client:
        pending = client.get_items(
            "billing_account",
            {
                "query": {
                    "filter": {
                        "status": {"_eq": "pending"},
                        "mollie_customer_id": {"_nnull": True},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
    if not isinstance(pending, list) or not pending:
        return
    task_logger.info("Reconciling %d pending billing account(s)", len(pending))
    for acc in pending:
        try:
            status = run_async_in_new_loop(
                lambda account_id=acc["id"]: sync_account_from_mollie(account_id)
            )
            if status == "active":
                task_logger.info("Activated billing account %s via catch-up", acc["id"])
        except Exception:
            task_logger.exception("Failed reconciling billing account %s", acc.get("id"))


@dramatiq.actor(queue_name="network")
def task_reconcile_subscription_seats() -> None:
    """Keep each active subscription's amount in line with its live seat count.

    Per-seat billing has no Mollie quantity, so a member added/removed anywhere
    in the org only reaches the bill when we PATCH the subscription amount. This
    reconciles all active subscriptions; the service layer skips the PATCH when
    the amount is unchanged."""
    task_logger = getLogger("dembrane.tasks.task_reconcile_subscription_seats")
    from dembrane.directus import directus, directus_client_context
    from dembrane.billing_service import reconcile_account_seats

    with directus_client_context(directus) as client:
        active = client.get_items(
            "billing_account",
            {
                "query": {
                    "filter": {
                        "status": {"_eq": "active"},
                        "mollie_subscription_id": {"_nnull": True},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
    if not isinstance(active, list) or not active:
        return
    for acc in active:
        try:
            run_async_in_new_loop(lambda account_id=acc["id"]: reconcile_account_seats(account_id))
        except Exception:
            task_logger.exception("Failed seat-sync for billing account %s", acc.get("id"))


@dramatiq.actor(queue_name="network")
def task_flush_email_digests() -> None:
    """Daily digest flush — sends one summary email per recipient.

    Scheduled at 09:00 UTC by the scheduler. Drains all queued digest
    items and sends a single digest email per recipient. Idempotent:
    re-running when the queue is empty is a no-op.
    """
    from dembrane.email import send_email_sync
    from dembrane.email_throttle import flush_all_digests_sync

    task_logger = getLogger("dembrane.tasks.task_flush_email_digests")

    batches = flush_all_digests_sync()
    if not batches:
        task_logger.info("digest_flush: no pending items")
        return

    settings = get_settings()
    base = (settings.urls.admin_base_url or "").rstrip("/")
    admin_url = f"{base}/admin/upgrades"

    for recipient_id, items in batches.items():
        task_logger.info(
            "digest_flush: sending %d items to recipient %s",
            len(items),
            recipient_id,
        )
        email_addr = _resolve_recipient_email_sync(recipient_id)
        if not email_addr:
            task_logger.warning(
                "digest_flush: no email found for recipient %s, skipping", recipient_id
            )
            continue
        ok = send_email_sync(
            to=email_addr,
            subject=f"dembrane digest: {len(items)} notification{'s' if len(items) != 1 else ''}",
            template="notification_digest",
            template_data={
                "item_count": len(items),
                "items": items,
                "admin_url": admin_url,
            },
        )
        if not ok:
            task_logger.warning("digest_flush: email send failed for %s", recipient_id)


def _resolve_recipient_email_sync(app_user_id: str) -> str:
    """Look up email for an app_user ID (sync, for Dramatiq actors)."""
    from dembrane.directus import directus

    try:
        user = directus.get_item("app_user", app_user_id)
        if user and user.get("email"):
            return user["email"]
    except Exception:
        logger.warning("_resolve_recipient_email_sync: failed for %s", app_user_id)
    return ""


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Parse a Directus ISO timestamp into an aware datetime, or None."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _resolve_app_user_id_for_directus_user_id(directus_user_id: object) -> Optional[str]:
    if not directus_user_id:
        return None
    with directus_client_context() as client:
        rows = client.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"directus_user_id": {"_eq": str(directus_user_id)}},
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )
    if not isinstance(rows, list) or not rows:
        return None
    app_user_id = rows[0].get("id")
    return str(app_user_id) if app_user_id else None


@dramatiq.actor(queue_name="network", priority=100)
def task_capture_chat_insights() -> None:
    """Summarize idle agentic chats into anonymized usage insights.

    There is no reliable "chat ended" signal, so this sweep treats a chat as
    ended once it has sat untouched for INSIGHT_IDLE_MINUTES. For each idle
    agentic chat it writes a single anonymized usage_insight describing what the
    host was trying to do or where they got stuck.

    Idleness is measured from the latest project_chat_message, NOT
    project_chat.date_updated (that column only moves on rename/mode changes, not
    on new messages, so it cannot signal message activity). The sweep reads
    recent messages to find each chat's last-activity time, treats a chat as
    ended once its last message is older than INSIGHT_IDLE_MINUTES, and skips
    still-active chats.

    Idempotent / no-rework: for each idle chat it looks up the most recent
    usage_insight. If one exists whose created_at is at or after the chat's last
    message, there has been no fresh activity since the last insight, so it
    skips. A new insight therefore fires only after fresh activity followed by
    idle time, i.e. roughly once per chat session. Per-chat work is isolated so
    one failure never aborts the sweep.
    """
    from dembrane.insight_utils import (
        INSIGHT_SWEEP_BATCH,
        INSIGHT_IDLE_MINUTES,
        INSIGHT_LOOKBACK_HOURS,
        INSIGHT_MAX_RECENT_MESSAGES,
        generate_chat_insight,
    )

    task_logger = getLogger("dembrane.tasks.task_capture_chat_insights")

    # Cap on how many messages we feed the model; longer chats are head+tail.
    MAX_MESSAGES = 50

    now = get_utc_timestamp()
    idle_cutoff = now - timedelta(minutes=INSIGHT_IDLE_MINUTES)
    lookback_cutoff = (now - timedelta(hours=INSIGHT_LOOKBACK_HOURS)).isoformat()

    # Find each recently-active chat's LAST message time. A chat is idle when its
    # latest message is older than idle_cutoff; any message newer than that means
    # it is still active and is skipped. Reading messages newest-first, the first
    # row seen per chat is its latest.
    with directus_client_context() as client:
        recent_messages = client.get_items(
            "project_chat_message",
            {
                "query": {
                    "filter": {"date_created": {"_gte": lookback_cutoff}},
                    "fields": ["project_chat_id", "date_created"],
                    "sort": ["-date_created"],
                    "limit": INSIGHT_MAX_RECENT_MESSAGES,
                }
            },
        )
    recent_messages = recent_messages if isinstance(recent_messages, list) else []

    last_message_at: dict[str, datetime] = {}
    for row in recent_messages:
        raw_chat_id = row.get("project_chat_id")
        cid = raw_chat_id.get("id") if isinstance(raw_chat_id, dict) else raw_chat_id
        if not cid or cid in last_message_at:
            continue  # first (newest) row per chat wins
        parsed = _parse_iso(row.get("date_created"))
        if parsed:
            last_message_at[cid] = parsed

    idle_chat_ids = [cid for cid, ts in last_message_at.items() if ts < idle_cutoff][
        :INSIGHT_SWEEP_BATCH
    ]

    if not idle_chat_ids:
        task_logger.debug("task_capture_chat_insights: no idle agentic chats")
        return

    # Resolve the idle ids to agentic, non-deleted chats (mode/project/creator).
    with directus_client_context() as client:
        chat_rows = client.get_items(
            "project_chat",
            {
                "query": {
                    "filter": {
                        "id": {"_in": [str(c) for c in idle_chat_ids]},
                        "chat_mode": {"_eq": "agentic"},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "project_id", "user_created"],
                    "limit": INSIGHT_SWEEP_BATCH,
                }
            },
        )
    chats = chat_rows if isinstance(chat_rows, list) else []

    scanned = len(chats)
    written = 0
    skipped = 0

    for chat in chats:
        chat_id = chat.get("id")
        if not chat_id:
            skipped += 1
            continue
        try:
            chat_last_activity = last_message_at.get(chat_id)

            # Idempotency: skip if the newest insight already covers this session.
            with directus_client_context() as client:
                latest = client.get_items(
                    "usage_insight",
                    {
                        "query": {
                            "filter": {"project_chat_id": {"_eq": str(chat_id)}},
                            "fields": ["id", "created_at"],
                            "sort": ["-created_at"],
                            "limit": 1,
                        }
                    },
                )
            if isinstance(latest, list) and latest:
                last_created = _parse_iso(latest[0].get("created_at"))
                if last_created and chat_last_activity and last_created >= chat_last_activity:
                    skipped += 1
                    continue

            # Fetch the ordered messages, capped head+tail for long chats.
            with directus_client_context() as client:
                messages = client.get_items(
                    "project_chat_message",
                    {
                        "query": {
                            "filter": {"project_chat_id": {"_eq": str(chat_id)}},
                            "fields": ["id", "message_from", "text", "date_created"],
                            "sort": ["date_created"],
                            "limit": -1,
                        }
                    },
                )
            messages = messages if isinstance(messages, list) else []

            user_turns = sum(1 for m in messages if m.get("message_from") == "user")
            if user_turns < 1:
                skipped += 1
                continue

            if len(messages) > MAX_MESSAGES:
                head = MAX_MESSAGES // 2
                tail = MAX_MESSAGES - head
                messages = messages[:head] + messages[-tail:]

            triggering_message_id = next(
                (
                    str(message.get("id"))
                    for message in reversed(messages)
                    if message.get("message_from") == "user" and message.get("id")
                ),
                None,
            )

            insight = run_async_in_new_loop(
                lambda messages=messages: generate_chat_insight(messages)
            )
            if not insight:
                skipped += 1
                continue

            # Resolve workspace_id from the chat's project.
            project_id = chat.get("project_id")
            workspace_id = None
            if project_id:
                with directus_client_context() as client:
                    project = client.get_item("project", str(project_id))
                workspace_id = project.get("workspace_id") if project else None

            with directus_client_context() as client:
                client.create_item(
                    "usage_insight",
                    {
                        "workspace_id": workspace_id,
                        "project_id": project_id,
                        "directus_user_id": chat.get("user_created"),
                        "project_chat_id": str(chat_id),
                        "chat_id": str(chat_id),
                        "app_user_id": _resolve_app_user_id_for_directus_user_id(
                            chat.get("user_created")
                        ),
                        "message_id": triggering_message_id,
                        "insight_type": insight["insight_type"],
                        "summary": insight["summary"],
                        "status": "new",
                    },
                )
            written += 1
        except Exception:
            task_logger.exception("task_capture_chat_insights: failed for chat %s", chat_id)
            skipped += 1

    task_logger.info(
        "task_capture_chat_insights: scanned=%d written=%d skipped=%d",
        scanned,
        written,
        skipped,
    )
