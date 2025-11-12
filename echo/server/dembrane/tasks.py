from typing import Optional
from logging import getLogger

import dramatiq
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
from dembrane.settings import get_settings
from dembrane.sentry import init_sentry
from dembrane.directus import (
    DirectusBadRequest,
    DirectusServerError,
    directus,
    directus_client_context,
)
from dembrane.transcribe import transcribe_conversation_chunk
from dembrane.async_helpers import run_in_thread_pool, run_async_in_new_loop
from dembrane.conversation_utils import collect_unfinished_conversations
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.processing_status_utils import (
    ProcessingStatusContext,
    set_error_status,
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
    conversation_chunk_id: str, conversation_id: str, use_pii_redaction: bool = False
) -> None:
    """
    Transcribe a conversation chunk. The results are not returned.
    """
    logger = getLogger("dembrane.tasks.task_transcribe_chunk")
    try:
        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_transcribe_chunk",
            message=f"for chunk {conversation_chunk_id}",
        ):
            transcribe_conversation_chunk(conversation_chunk_id, use_pii_redaction)

        return
    except Exception as e:
        logger.error(f"Error: {e}")
        raise e from e


@dramatiq.actor(queue_name="network", priority=30)
def task_summarize_conversation(conversation_id: str) -> None:
    """
    Summarize a conversation. The results are not returned. You can find it in
    conversation["summary"] after the task is finished.
    """
    logger = getLogger("dembrane.tasks.task_summarize_conversation")

    from dembrane.service.conversation import ConversationNotFoundException

    try:
        from dembrane.service import conversation_service

        conversation = conversation_service.get_by_id_or_raise(conversation_id)

        if conversation["is_finished"] and conversation["summary"] is not None:
            logger.info(f"Conversation {conversation_id} already summarized, skipping")
            return

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

        return
    except ConversationNotFoundException:
        logger.error(f"Conversation not found: {conversation_id}")
        return
    except Exception as e:
        logger.error(f"Error: {e}")
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
    Finalize processing of a conversation and invoke follow-up tasks.
    1. Set status
    3. Merge chunks into merged_audio_path
    4. Run ETL pipeline (if enabled)
    """
    logger = getLogger("dembrane.tasks.task_finish_conversation_hook")

    from dembrane.service import conversation_service
    from dembrane.service.conversation import ConversationNotFoundException

    try:
        logger.info(f"Finishing conversation: {conversation_id}")

        conversation_obj = conversation_service.get_by_id_or_raise(conversation_id)

        if conversation_obj["is_finished"]:
            logger.info(f"Conversation {conversation_id} already finished, skipping")
            return

        conversation_service.update(conversation_id=conversation_id, is_finished=True)

        logger.info(
            f"Conversation {conversation_id} has not finished processing, running all follow-up tasks"
        )

        task_merge_conversation_chunks.send(conversation_id)
        task_summarize_conversation.send(conversation_id)

        counts = conversation_service.get_chunk_counts(conversation_id)

        if counts["processed"] == counts["total"]:
            logger.debug("allez c'est fini")
            conversation_service.update(
                conversation_id=conversation_id,
                is_all_chunks_transcribed=True,
            )
        else:
            logger.debug(
                f"waiting for pending chunks {counts['pending']} ok({counts['ok']}) error({counts['error']}) total({counts['total']})"
            )

        return

    except ConversationNotFoundException:
        logger.error(f"NO RETRY: Conversation not found: {conversation_id}")
        return

    except Exception as e:
        logger.error(f"Error: {e}")
        raise e from e


# cpu because it is also bottlenecked by the cpu queue due to the split_audio_chunk task
@dramatiq.actor(queue_name="cpu", priority=0)
def task_process_conversation_chunk(
    chunk_id: str,
    # TODO: here probably later we can fetch the use_pii_redaction flag from the conversation / project
    # when it is available
    use_pii_redaction: bool = False,
) -> None:
    """
    Process a conversation chunk.
    """

    logger = getLogger("dembrane.tasks.task_process_conversation_chunk")
    try:
        from dembrane.service import conversation_service

        chunk = conversation_service.get_chunk_by_id_or_raise(chunk_id)
        logger.debug(f"Chunk {chunk_id} found in conversation: {chunk['conversation_id']}")

        # critical section
        with ProcessingStatusContext(
            conversation_id=chunk["conversation_id"],
            event_prefix="task_process_conversation_chunk.split_audio_chunk",
            message=f"for chunk {chunk_id}",
        ):
            from dembrane.audio_utils import split_audio_chunk

            split_chunk_ids = split_audio_chunk(chunk_id, "mp3", delete_original=True)

        if split_chunk_ids is None:
            logger.error(f"Split audio chunk result is None for chunk: {chunk_id}")
            raise ValueError(f"Split audio chunk result is None for chunk: {chunk_id}")

        logger.info(f"Split audio chunk result: {split_chunk_ids}")

        group(
            [
                task_transcribe_chunk.message(cid, chunk["conversation_id"], use_pii_redaction)
                for cid in split_chunk_ids
                if cid is not None
            ]
        ).run()

        return

    except Exception as e:
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
