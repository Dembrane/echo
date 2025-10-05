from typing import Optional
from logging import getLogger

import dramatiq
import requests
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
from dembrane.config import (
    REDIS_URL,
    RUNPOD_WHISPER_API_KEY,
    RUNPOD_TOPIC_MODELER_URL,
    ENABLE_AUDIO_LIGHTRAG_INPUT,
    RUNPOD_TOPIC_MODELER_API_KEY,
)
from dembrane.sentry import init_sentry
from dembrane.prompts import render_json
from dembrane.directus import (
    DirectusBadRequest,
    DirectusServerError,
    directus,
    directus_client_context,
)
from dembrane.transcribe import transcribe_conversation_chunk
from dembrane.conversation_utils import (
    collect_unfinished_conversations,
    collect_unfinished_audio_processing_conversations,
)
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.conversation_health import get_runpod_diarization
from dembrane.processing_status_utils import (
    ProcessingStatusContext,
    set_error_status,
)
from dembrane.audio_lightrag.utils.echo_utils import finish_conversation

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
def task_transcribe_chunk(conversation_chunk_id: str, conversation_id: str) -> None:
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
            transcribe_conversation_chunk(conversation_chunk_id)

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
            summarize_conversation(
                conversation_id=conversation_id,
                auth=DependencyDirectusSession(user_id="none", is_admin=True),
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
        from dembrane.api.conversation import get_conversation_content

        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_merge_conversation_chunks",
        ):
            # todo: except if NoValidParts
            get_conversation_content(
                conversation_id,
                auth=DependencyDirectusSession(user_id="none", is_admin=True),
                force_merge=True,
                return_url=True,
            )

        return

    except Exception as e:
        logger.error(f"Error: {e}")
        raise e from e


@dramatiq.actor(
    queue_name="cpu",
    priority=10,
    time_limit=5 * 60 * 1000,  # 5 minutes (no audio processing!)
    max_retries=3,
)
def task_run_etl_pipeline(conversation_id: str) -> None:
    """
    THE PIVOT: Process finished conversation for RAG using existing transcripts.
    NO audio processing - text-only!
    
    Steps:
    1. Fetch conversation chunks from Directus (with existing transcripts)
    2. Concatenate chunk.transcript fields (from standard Whisper pipeline)
    3. Get project context
    4. Rich contextualization with Claude
    5. Create conversation_segment record
    6. Insert into LightRAG (Neo4j + PostgreSQL)
    """
    logger = getLogger("dembrane.tasks.task_run_etl_pipeline")
    
    try:
        # Check if conversation exists
        try:
            conversation_object = directus.get_item("conversation", conversation_id)
        except Exception:
            logger.error(f"Failed to get conversation {conversation_id}")
            return
        
        if conversation_object is None:
            logger.error(f"Conversation not found: {conversation_id}")
            return
        
        project_id = conversation_object["project_id"]
        
        # Check if RAG processing is enabled for this project
        try:
            project = directus.get_item("project", project_id)
            is_enabled = project.get("is_enhanced_audio_processing_enabled", False)
        except Exception as e:
            logger.error(f"Failed to get project {project_id}: {e}")
            return
        
        if not (ENABLE_AUDIO_LIGHTRAG_INPUT and is_enabled):
            logger.info(f"RAG processing disabled for project {project_id}, skipping")
            return
        
        with ProcessingStatusContext(
            conversation_id=conversation_id,
            event_prefix="task_run_etl_pipeline",
            message="Processing conversation for RAG (transcript-only)",
        ):
            logger.info(f"Starting RAG processing for conversation {conversation_id}")
            
            # Step 1: Fetch chunks with transcripts from Directus
            logger.info("Step 1/6: Fetching chunks from Directus")
            chunks_response = directus.get_items("conversation_chunk", {
                "query": {
                    "filter": {
                        "conversation_id": conversation_id
                    },
                    "fields": ["id", "transcript", "timestamp", "conversation_id"],
                    "sort": ["timestamp"],
                    "limit": -1
                }
            })
            
            if not chunks_response or len(chunks_response) == 0:
                logger.warning(f"No chunks found for conversation {conversation_id}")
                return
            
            # Step 2: Concatenate transcripts
            logger.info(f"Step 2/6: Concatenating {len(chunks_response)} chunk transcripts")
            transcripts = []
            for chunk in chunks_response:
                transcript = chunk.get("transcript", "")
                if transcript and transcript.strip():
                    transcripts.append(transcript.strip())
            
            if not transcripts:
                logger.warning(f"No valid transcripts found in chunks for conversation {conversation_id}")
                return
            
            full_transcript = "\n\n".join(transcripts)
            logger.info(f"Full transcript length: {len(full_transcript)} characters")
            
            # Step 3: Get project context (format as event_text like old pipeline)
            logger.info("Step 3/6: Getting project context")
            project_language = project.get("language", "en")
            
            # Format project data as key:value pairs (same as old pipeline)
            event_text = "\n\n".join([
                f"{k} : {v}" for k, v in project.items()
                if k in ["name", "context", "language", "description"]
            ])
            
            # Step 3b: Get previous conversation segments for context
            # (For now, we'll start with empty - can enhance later)
            previous_conversation_text = ""
            # TODO: In future, fetch previous segments' contextual_transcripts from this conversation
            # and join with \n\n like old pipeline did
            
            # Step 4: Rich contextualization with Claude (using old prompt template)
            logger.info("Step 4/6: Contextualizing with Claude")
            from dembrane.api.stateless import InsertRequest, insert_item
            from dembrane.api.dependency_auth import DependencyDirectusSession
            from dembrane.audio_lightrag.utils.async_utils import run_async_in_new_loop
            from dembrane.audio_lightrag.services.contextualizer import get_contextualizer
            
            contextualizer = get_contextualizer()
            
            # Define async function that does all async work in ONE loop
            async def process_with_rag():
                # Step 4a: Contextualize transcript (using old audio_model_system_prompt)
                contextual_transcript = await contextualizer.contextualize(
                    full_transcript, 
                    event_text, 
                    previous_conversation_text,
                    project_language
                )
                
                # Step 5: Create segment record
                logger.info("Step 5/6: Creating conversation segment")
                segment_data = {
                    "conversation_id": conversation_id,
                    "transcript": full_transcript,
                    "contextual_transcript": contextual_transcript,
                }
                segment = directus.create_item("conversation_segment", segment_data)
                segment_id = segment["data"]["id"]
                logger.info(f"Created segment {segment_id} for conversation {conversation_id}")
                
                # Step 6: Insert into RAG (using same pattern as old code)
                logger.info("Step 6/6: Inserting into LightRAG")
                payload = InsertRequest(
                    content=contextual_transcript,
                    echo_segment_id=str(segment_id),
                    transcripts=[full_transcript],
                )
                # Create fake admin session (same as old code)
                fake_session = DependencyDirectusSession(user_id="none", is_admin=True)
                
                # Call insert_item directly (not via HTTP)
                insert_response = await insert_item(payload, fake_session)
                
                if insert_response.status != "success":
                    raise RuntimeError(f"RAG insertion failed: {insert_response.status}")
                
                return segment_id
            
            # Run all async work in ONE event loop
            segment_id = run_async_in_new_loop(process_with_rag())
            
            logger.info(f"Successfully processed conversation {conversation_id} for RAG")
            logger.info(f"Segment ID: {segment_id}")

            # Mark segment as processed in RAG (same as old pipeline)
            directus.update_item("conversation_segment", segment_id, {"lightrag_flag": True})
            logger.info(f"Marked segment {segment_id} as RAG processed")

            # CRITICAL: Mark ALL segments for this conversation as processed
            # (There may be old segments from previous audio processing runs)
            try:
                # Batch update all segments for this conversation
                all_segments = directus.get_items("conversation_segment", {
                    "query": {
                        "filter": {"conversation_id": conversation_id, "lightrag_flag": False},
                        "fields": ["id"],
                        "limit": -1
                    }
                })
                
                if all_segments and len(all_segments) > 0:
                    logger.warning(f"Found {len(all_segments)} old unprocessed segments for conversation {conversation_id}, marking as processed")
                    for old_seg in all_segments:
                        try:
                            directus.update_item("conversation_segment", old_seg["id"], {"lightrag_flag": True})
                        except Exception as e:
                            logger.error(f"Failed to update old segment {old_seg['id']}: {e}")
            except Exception as e:
                logger.error(f"Failed to check/update old segments: {e}")

            if finish_conversation(conversation_id):
                logger.info(f"Marked conversation {conversation_id} as audio processing finished")
            else:
                logger.warning(
                    f"Failed to mark conversation {conversation_id} as audio processing finished"
                )
            
    except Exception as e:
        logger.error(f"RAG processing failed for conversation {conversation_id}: {e}", exc_info=True)
        raise


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

        # Dispatch follow-up tasks directly
        # Note: Using .send() instead of group() to ensure tasks are actually dispatched
        task_merge_conversation_chunks.send(conversation_id)
        task_run_etl_pipeline.send(conversation_id)  # THE PIVOT: Drop-in replacement with new logic!
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
def task_process_conversation_chunk(chunk_id: str) -> None:
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

        if "upload" not in str(chunk["source"]).lower():
            group([task_get_runpod_diarization.message(chunk_id)]).run()

        logger.info(f"Split audio chunk result: {split_chunk_ids}")

        group(
            [
                task_transcribe_chunk.message(cid, chunk["conversation_id"])
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

        try:
            unfinished_ap_conversation_ids = collect_unfinished_audio_processing_conversations()
            logger.info(
                f"Unfinished audio processing conversation ids: {unfinished_ap_conversation_ids}"
            )
        except Exception as e:
            logger.error(f"Error collecting unfinished audio processing conversations: {e}")
            unfinished_ap_conversation_ids = []

        group(
            [
                task_finish_conversation_hook.message(conversation_id)
                for conversation_id in unfinished_conversation_ids
                if conversation_id is not None
            ]
        ).run()

        group(
            [
                task_run_etl_pipeline.message(conversation_id)
                for conversation_id in unfinished_ap_conversation_ids
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
        try:
            with directus_client_context() as client:
                # get all segment ids from project_id
                segments = client.get_items(
                    "project",
                    {
                        "query": {
                            "filter": {
                                "id": project_id,
                            },
                            "fields": ["conversations.conversation_segments.id"],
                        }
                    },
                )

                if not segments or len(segments) == 0:
                    status_ctx.set_exit_message(f"No segments found for project: {project_id}")
                    logger.error(f"No segments found for project: {project_id}")
                    return

                segment_ids = list(
                    set(
                        [
                            seg["id"]
                            for conv in segments[0]["conversations"]
                            for seg in conv["conversation_segments"]
                        ]
                    )
                )

            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {RUNPOD_TOPIC_MODELER_API_KEY}",
            }

            data = {
                "input": {
                    "project_analysis_run_id": project_analysis_run_id,
                    "response_language": language,
                    "segment_ids": segment_ids,
                    "user_input": user_query,
                    "user_input_description": user_query_context or "",
                    "user_prompt": "\n\n\n".join([user_query, user_query_context or ""]),  # depr
                }
            }

            url = f"{str(RUNPOD_TOPIC_MODELER_URL).rstrip('/')}/run"
            logger.debug(f"sending url to runpod: {url} with data: {data}")

            response = requests.post(url, headers=headers, json=data, timeout=600)

            # Handle the response
            if not response.status_code == 200:
                status_ctx.set_exit_message(
                    f"RunPod API returned status {response.status_code}: {response.text}"
                )
                logger.error(f"RunPod API returned status {response.status_code}: {response.text}")
                # TODO: handle class of error in runpod
                raise Exception(f"RunPod API failed with status {response.status_code}")

            status_ctx.set_exit_message(
                f"Successfully created view with {len(segment_ids)} segments"
            )
            logger.info(
                f"Successfully created view for project_analysis_run_id: {project_analysis_run_id}"
            )
            logger.debug(f"RunPod response: {response.json()}")
            return

        except DirectusBadRequest as e:
            status_ctx.set_exit_message(f"Bad Directus request: {str(e)}")
            logger.error(f"Bad Directus request. Something item might be missing? {e}")
            return

        except DirectusServerError as e:
            status_ctx.set_exit_message(f"Can retry. Directus server down? {e}")
            logger.error(f"Can retry. Directus server down? {e}")
            raise e from e

        except requests.exceptions.RequestException as e:
            status_ctx.set_exit_message(f"Can retry. Network error calling RunPod API: {e}")
            logger.error(f"Can retry. Network error calling RunPod API: {e}")
            raise e from e

        except Exception as e:
            status_ctx.set_exit_message(
                f"Can retry. Views failed to create for unknown reason: {e}"
            )
            logger.error(f"Can retry. Views failed to create for unknown reason: {e}")
            raise e from e


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

        default_view_name_list = ["default_view_recurring_themes"]
        messages = []

        for view_name in default_view_name_list:
            message = render_json(view_name, language, {}, ["user_query", "user_query_context"])
            logger.info(f"Message: {message}")
            messages.append(
                task_create_view.message(
                    project_analysis_run_id=new_run_id,
                    user_query=message["user_query"],
                    user_query_context=message["user_query_context"],
                    language=language,
                )
            )

        group(messages).run()

        status_ctx.set_exit_message(
            f"Successfully created {len(messages)} views for project: {project_id}"
        )
        logger.info(
            f"Successfully created {len(messages)} views for project: {project_id} (language: {language})"
        )

        return


@dramatiq.actor(queue_name="network", priority=10)
def task_process_runpod_chunk_response(chunk_id: str, status_link: str) -> None:
    logger = getLogger("dembrane.tasks.task_process_runpod_chunk_response")

    # pre-flight check to avoid processing chunks that are not in a conversation
    from dembrane.service import conversation_service
    from dembrane.service.conversation import ConversationChunkNotFoundException

    try:
        chunk_object = conversation_service.get_chunk_by_id_or_raise(chunk_id)
        conversation_id = chunk_object["conversation_id"]
    # unrecoverable error, we can't process the chunk
    except ConversationChunkNotFoundException:
        logger.error(f"Chunk {chunk_id} not found, skipping")
        return
    # retry
    except Exception as e:
        logger.error(f"Error fetching conversation for chunk {chunk_id}: {e}")
        set_error_status(
            conversation_chunk_id=chunk_id, error="Failed to fetch conversation for this chunk."
        )
        raise e from e

    with ProcessingStatusContext(
        conversation_id=conversation_id,
        conversation_chunk_id=chunk_id,
        event_prefix="task_process_runpod_chunk_response",
    ):
        chunk_object = conversation_service.get_chunk_by_id_or_raise(chunk_id)
        conversation_id = chunk_object["conversation_id"]

        headers = {
            "Authorization": f"Bearer {RUNPOD_WHISPER_API_KEY}",
            "Content-Type": "application/json",
        }
        response = requests.get(status_link, headers=headers, timeout=30)

        if response.status_code == 200:
            try:
                logger.debug(f"About to parse JSON for chunk {chunk_id}")
                data = response.json()
                logger.debug(f"Successfully parsed JSON for chunk {chunk_id}")

                # Debug logging to see the actual structure
                logger.debug(f"Raw response data structure for chunk {chunk_id}: {data}")
                logger.debug(f"Type of data: {type(data)}")
                if "output" in data:
                    logger.debug(f"Type of data['output']: {type(data['output'])}")

                logger.debug(
                    f"About to call load_runpod_transcription_response for chunk {chunk_id}"
                )
                from dembrane.runpod import load_runpod_transcription_response

                load_runpod_transcription_response(data)
                logger.debug(
                    f"Successfully completed load_runpod_transcription_response for chunk {chunk_id}"
                )

            except Exception as e:
                logger.error(f"Error parsing response for chunk {chunk_id}: {e}")
                logger.error(f"Error type: {type(e)}")
                logger.error("Error traceback:", exc_info=True)
                # Log the raw response for debugging
                logger.error(f"Raw response text: {response.text}")
                logger.error(f"Response status: {response.status_code}")
                logger.error(f"Response headers: {response.headers}")
        else:
            logger.info(f"Non-200 response for chunk {chunk_id}, retrying transcription.")
            try:
                transcribe_conversation_chunk(chunk_id)
            except Exception as e:
                logger.error(f"Failed to re-trigger transcription for chunk {chunk_id}: {e}")


@dramatiq.actor(queue_name="network", priority=10)
def task_update_runpod_transcription_response() -> None:
    logger = getLogger("dembrane.tasks.task_update_runpod_transcription_response")
    try:
        chunks = directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "filter": {"runpod_job_status_link": {"_nnull": True}},
                    "fields": ["id", "runpod_job_status_link"],
                }
            },
        )
        if not chunks:
            logger.info("No chunks with runpod_job_status_link found.")
            return

        # Dispatch a group of sub-tasks for parallel processing
        group(
            [
                task_process_runpod_chunk_response.message(
                    chunk["id"], chunk["runpod_job_status_link"]
                )
                for chunk in chunks
            ]
        ).run()

    except Exception as e:
        logger.error(f"Error in task_update_runpod_transcription_response: {e}")


@dramatiq.actor(queue_name="network", priority=30)
def task_get_runpod_diarization(chunk_id: str) -> None:
    logger = getLogger("dembrane.tasks.task_get_runpod_diarization")
    logger.info(f"Getting runpod diarization for chunk {chunk_id}")
    try:
        get_runpod_diarization(chunk_id)
    except Exception as e:
        logger.error(f"Error in task_get_runpod_diarization: {e}")
