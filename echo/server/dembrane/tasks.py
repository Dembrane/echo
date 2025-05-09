from logging import getLogger

import dramatiq
import lz4.frame
from dramatiq import group
from dramatiq.encoder import JSONEncoder, MessageData
from dramatiq.results import Results
from dramatiq_workflow import Chain, Group, Workflow, WithDelay, WorkflowMiddleware
from dramatiq.middleware import GroupCallbacks
from dramatiq.brokers.redis import RedisBroker
from dramatiq.rate_limits.backends import RedisBackend as RateLimitRedisBackend
from dramatiq.results.backends.redis import RedisBackend as ResultsRedisBackend

from dembrane.utils import generate_uuid, get_utc_timestamp
from dembrane.config import REDIS_URL, ENABLE_AUDIO_LIGHTRAG_INPUT
from dembrane.sentry import init_sentry
from dembrane.database import (
    ViewModel,
    QuoteModel,
    DatabaseSession,
    ProcessingStatusEnum,
    ConversationChunkModel,
    ProjectAnalysisRunModel,
)
from dembrane.directus import directus
from dembrane.transcribe import transcribe_conversation_chunk
from dembrane.audio_utils import split_audio_chunk
from dembrane.quote_utils import (
    generate_quotes,
    initialize_view,
    generate_view_extras,
    assign_aspect_centroid,
    generate_aspect_extras,
    cluster_quotes_using_aspect_centroids,
)
from dembrane.conversation_utils import collect_unfinished_conversations
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.processing_status_utils import ProcessingStatus
from dembrane.audio_lightrag.main.run_etl import run_etl_pipeline

init_sentry()

logger = getLogger("dembrane.tasks")

# Add compression to JSON data using lz4


class DramatiqLz4JSONEncoder(JSONEncoder):
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
def task_transcribe_chunk(conversation_chunk_id: str) -> None:
    """
    Transcribe a conversation chunk. The results are not returned.
    """
    logger = getLogger("dembrane.tasks.task_transcribe_chunk")
    try:
        logger.info(f"Transcribing conversation chunk: {conversation_chunk_id}")

        transcribe_conversation_chunk(conversation_chunk_id)

        return
    except Exception as e:
        logger.error(f"Error: {e}")
        raise e from e


@dramatiq.actor(queue_name="network")
def task_summarize_conversation(conversation_id: str) -> None:
    """
    Summarize a conversation. The results are not returned. You can find it in
    conversation["summary"] after the task is finished.
    """
    logger = getLogger("dembrane.tasks.task_summarize_conversation")

    try:
        from dembrane.api.conversation import summarize_conversation

        logger.info(f"Summarizing conversation: {conversation_id}")
        summarize_conversation(
            conversation_id, auth=DependencyDirectusSession(user_id="none", is_admin=True)
        )

        return
    except Exception as e:
        logger.error(f"Error: {e}")
        raise e from e


@dramatiq.actor(store_results=True, queue_name="cpu")
def task_merge_conversation_chunks(conversation_id: str) -> None:
    """
    Merge conversation chunks.
    """
    logger = getLogger("dembrane.tasks.task_merge_conversation_chunks")

    try:
        # local import to avoid circular imports
        from dembrane.api.conversation import get_conversation_content

        logger.info(f"Merging conversation chunks: {conversation_id}")
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


@dramatiq.actor(queue_name="cpu")
def task_run_etl_pipeline(conversation_id: str) -> None:
    """
    Run the AudioLightrag ETL pipeline.
    """
    logger = getLogger("dembrane.tasks.task_run_etl_pipeline")

    try:
        logger.info(f"Invoking ETL pipeline for conversation: {conversation_id}")
        run_etl_pipeline([conversation_id])

        return
    except Exception as e:
        logger.error(f"Error: {e}")
        raise e from e


@dramatiq.actor(queue_name="network")
def task_finish_conversation_hook(conversation_id: str) -> None:
    """
    Finalize processing of a conversation and invoke follow-up tasks.
    1. Set status
    2. Summarize
    3. Merge chunks into merged_audio_path
    4. Run ETL pipeline (if enabled)
    """
    logger = getLogger("dembrane.tasks.task_finish_conversation_hook")

    try:
        logger.info(f"Finishing conversation: {conversation_id}")

        directus.update_item(
            "conversation",
            conversation_id,
            item_data={
                "is_finished": True,
                "processing_status": ProcessingStatus.COMPLETED.value,
                "processing_message": "Conversation marked as finished.",
            },
        )

        # Create a group of follow-up tasks
        follow_up_tasks = [
            task_summarize_conversation.message(conversation_id),
            task_merge_conversation_chunks.message(conversation_id),
        ]

        # Conditionally add ETL pipeline task
        if ENABLE_AUDIO_LIGHTRAG_INPUT:
            logger.info(
                f"Audio Processing enabled, requesting etl pipeline run for conversation {conversation_id}"
            )
            follow_up_tasks.append(task_run_etl_pipeline.message(conversation_id))

        return group(follow_up_tasks).run()
    except Exception as e:
        logger.error(f"Error: {e}")
        raise e from e


# cpu because it is also bottlenecked by the cpu queue due to the split_audio_chunk task
@dramatiq.actor(queue_name="cpu", priority=0)
def task_process_conversation_chunk(chunk_id: str, run_finish_hook: bool = False) -> None:
    """
    Process a conversation chunk.
    """
    logger = getLogger("dembrane.tasks.task_process_conversation_chunk")
    try:
        try:
            chunk = directus.get_item("conversation_chunk", chunk_id)

            # attempt to access
            logger.info(f"Chunk {chunk_id} found in conversation: {chunk['conversation_id']}")

        except Exception as e:
            logger.error(f"Error: {e}")
            return

        logger.info(f"Chunk found: {chunk_id}")

        directus.update_item(
            "conversation",
            chunk["conversation_id"],
            {
                "processing_status": ProcessingStatus.PROCESSING.value,
                "processing_message": "Processing audio",
            },
        )

        # critical section
        split_chunk_ids = split_audio_chunk(chunk_id, "mp3")

        if split_chunk_ids is None:
            logger.error(f"Split audio chunk result is None for chunk: {chunk_id}")
            raise ValueError(f"Split audio chunk result is None for chunk: {chunk_id}")

        logger.info(f"Split audio chunk result: {split_chunk_ids}")

        directus.update_item(
            "conversation",
            chunk["conversation_id"],
            {
                "processing_status": ProcessingStatus.PROCESSING.value,
                "processing_message": "Transcribing audio",
            },
        )

        if run_finish_hook:
            wf = Workflow(
                Chain(
                    Group(
                        *[
                            task_transcribe_chunk.message(chunk_id)
                            for chunk_id in split_chunk_ids
                            if chunk_id is not None
                        ],
                    ),
                    task_finish_conversation_hook.message(chunk["conversation_id"]),
                )
            )

            return wf.run()
        else:
            return group(
                [
                    task_transcribe_chunk.message(chunk_id)
                    for chunk_id in split_chunk_ids
                    if chunk_id is not None
                ]
            ).run()

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

        if len(unfinished_conversation_ids) == 0:
            logger.info("No unfinished conversations found")
            return

        logger.info(f"found {len(unfinished_conversation_ids)} unfinished conversations")

        g = group(
            [
                task_finish_conversation_hook.message(conversation_id)
                for conversation_id in unfinished_conversation_ids
                if conversation_id is not None
            ]
        )

        g.run()

        return
    except Exception as e:
        logger.error(f"Error collecting and finishing unfinished conversations: {e}")
        raise e from e


# FIXME: move to quote_utils.py / remove
@dramatiq.actor(queue_name="cpu", priority=70)
def task_generate_quotes(project_analysis_run_id: str, conversation_id: str) -> None:
    logger = getLogger("dembrane.tasks.task_generate_quotes")

    with DatabaseSession() as db:
        try:
            logger.info(f"Generating quotes for project analysis run: {project_analysis_run_id}")

            # check if no new conversation chunks have been added since the last quote generation
            # if the latest conversation chunk was created after the previous project analysis run was created
            # then we need to create a new project analysis run,
            # otherwise reuse the quotes from the previous project analysis run

            # first we obtain the project ID
            current_project_analysis_run = directus.get_item(
                "project_analysis_run", project_analysis_run_id
            )

            if current_project_analysis_run is None:
                logger.error(f"Project analysis run not found: {project_analysis_run_id}")
                return

            project_id = current_project_analysis_run["project_id"]

            # then we obtain the previous project analysis runs
            previous_project_analysis_runs = directus.get_items(
                "project_analysis_run",
                {
                    "query": {
                        "filter": {"project_id": project_id},
                        "sort": "-created_at",
                        "limit": 2,
                    }
                },
            )

            if previous_project_analysis_runs is None:
                raise Exception(
                    "No previous project analysis runs found. Something is clearly wrong."
                )

            # at this point we should have at least 1 project analysis run
            # if there is no history then we go ahead and generate quotes
            if len(previous_project_analysis_runs) == 1:
                logger.info("1 previous project analysis run")
                generate_quotes(db, project_analysis_run_id, conversation_id)

            elif len(previous_project_analysis_runs) == 2:
                # if there is a history we need to check if the latest conversation
                # chunk was created after the latest project analysis run
                logger.info("2 previous project analysis runs")

                comparison_project_analysis_run = previous_project_analysis_runs[1]

                latest_conversation_chunk = (
                    db.query(ConversationChunkModel)
                    .filter(ConversationChunkModel.conversation_id == conversation_id)
                    .order_by(ConversationChunkModel.timestamp.desc())
                    .first()
                )

                if latest_conversation_chunk is None:
                    logger.error(
                        f"No conversation chunks found for conversation: {conversation_id}"
                    )
                    return

                # conversation was updated since the last project analysis run so we need to generate new quotes
                if latest_conversation_chunk.timestamp > comparison_project_analysis_run.created_at:
                    logger.info(
                        f"Have to generate quotes for project analysis run ({latest_conversation_chunk.id[:6]} ({latest_conversation_chunk.timestamp.strftime('%Y-%m-%d %H:%M:%S')}) > {comparison_project_analysis_run.id[:6]} ({comparison_project_analysis_run.created_at.strftime('%Y-%m-%d %H:%M:%S')}))"
                    )
                    generate_quotes(db, project_analysis_run_id, conversation_id)
                else:
                    # conversation was not updated since the last project analysis run so we reuse the quotes from the previous project analysis run
                    # for all quotes (comparision run, conversation id) update with the latest project run id
                    # we need to update the quote with the latest conversation chunk
                    logger.info(
                        f"Reusing quotes for project analysis run from {comparison_project_analysis_run.id[:6]} ({comparison_project_analysis_run.created_at.strftime('%Y-%m-%d %H:%M:%S')})"
                    )
                    latest_project_analysis_run = previous_project_analysis_runs[0]

                    quotes_updated = (
                        db.query(QuoteModel)
                        .filter(
                            QuoteModel.project_analysis_run_id
                            == comparison_project_analysis_run.id,
                            QuoteModel.conversation_id == conversation_id,
                        )
                        .update(
                            {
                                "project_analysis_run_id": latest_project_analysis_run.id,
                            },
                            synchronize_session=False,
                        )
                    )

                    db.commit()

                    logger.info(f"Updated {quotes_updated} quotes")

                    return

        except Exception as e:
            logger.error(f"Error: {e}")
            db.rollback()
            raise e from e


@dramatiq.actor(queue_name="network")
def task_generate_aspect_extras(aspect_id: str, language: str = "en") -> None:
    logger = getLogger("dembrane.tasks.task_generate_aspect_extras")
    with DatabaseSession() as db:
        try:
            logger.info(f"Generating aspect extras for aspect: {aspect_id}")

            generate_aspect_extras(db, aspect_id, language)

            return

        except Exception as e:
            logger.error(f"Error: {e}")
            db.rollback()
            raise e from e


@dramatiq.actor(queue_name="network")
def task_generate_view_extras(view_id: str, language: str) -> None:
    logger = getLogger("dembrane.tasks.task_generate_view_extras")
    with DatabaseSession() as db:
        try:
            logger.info(f"Generating view extras for view: {view_id}")

            view = db.get(ViewModel, view_id)

            if view is None:
                logger.error(f"View not found: {view_id}")
                return None

            view.processing_message = "Analysing aspects"
            db.commit()
            generate_view_extras(db, view_id, language)
            view.processing_status = ProcessingStatusEnum.DONE
            view.processing_completed_at = get_utc_timestamp()
            db.commit()

            return
        except Exception as e:
            logger.error(f"Error: {e}")
            db.rollback()
            raise e from e


@dramatiq.actor(queue_name="cpu", priority=70)
def task_assign_aspect_centroid(aspect_id: str, language: str = "en") -> None:
    logger = getLogger("dembrane.tasks.task_assign_aspect_centroid")
    with DatabaseSession() as db:
        try:
            logger.info(f"Assigning aspect centroid for aspect: {aspect_id}")

            assign_aspect_centroid(db, aspect_id, language)

            return

        except Exception as e:
            logger.error(f"Error: {e}")
            db.rollback()
            raise e from e


@dramatiq.actor(queue_name="cpu", priority=70)
def task_cluster_quotes_using_aspect_centroids(view_id: str) -> None:
    logger = getLogger("dembrane.tasks.task_cluster_quotes_using_aspect_centroids")
    with DatabaseSession() as db:
        try:
            logger.info(f"Clustering quotes using aspect centroids for view: {view_id}")

            cluster_quotes_using_aspect_centroids(db, view_id)

            return

        except Exception as e:
            logger.error(f"Error: {e}")
            db.rollback()
            raise e from e


@dramatiq.actor(queue_name="network", priority=70)
def task_create_view(
    project_analysis_run_id: str,
    user_query: str,
    user_query_context: str,
    language: str,
) -> None:
    logger = getLogger("dembrane.tasks.task_create_view")
    with DatabaseSession() as db:
        try:
            logger.info(f"Creating view for project analysis run: {project_analysis_run_id}")

            project_analysis_run = db.get(ProjectAnalysisRunModel, project_analysis_run_id)

            if project_analysis_run is None:
                logger.info(f"Project analysis run not found: {project_analysis_run_id}")
                return None

            # Create the view
            view = initialize_view(
                db, project_analysis_run_id, user_query, user_query_context, language
            )
            view.processing_message = "Clustering aspects"
            db.commit()

            logger.info(f"View created: {view.id}")

            # Get all aspects associated with the view
            aspect_ids = [aspect.id for aspect in view.aspects]

            wf = Workflow(
                Chain(
                    Group(
                        *[
                            task_assign_aspect_centroid.message(aspect_id, language)
                            for aspect_id in aspect_ids
                        ],
                    ),
                    task_cluster_quotes_using_aspect_centroids.message(view.id),
                    Group(
                        *[
                            task_generate_aspect_extras.message(aspect_id, language)
                            for aspect_id in aspect_ids
                        ],
                    ),
                    task_generate_view_extras.message(view.id, language),
                )
            )

            wf.run()

            return

        except Exception as e:
            logger.error(f"Error creating view: {e}")
            db.rollback()
            raise e from e


@dramatiq.actor(queue_name="network", priority=70)
def task_finalize_project_library(project_analysis_run_id: str) -> None:
    logger = getLogger("dembrane.tasks.task_finalize_project_library")
    with DatabaseSession() as db:
        logger.info(f"Finalizing project library: {project_analysis_run_id}")

        project_analysis_run = db.get(ProjectAnalysisRunModel, project_analysis_run_id)

        if project_analysis_run is None:
            logger.error(f"Project analysis run not found: {project_analysis_run_id}")
            return None

        project_analysis_run.processing_status = ProcessingStatusEnum.DONE
        project_analysis_run.processing_message = "Project library created"
        project_analysis_run.processing_completed_at = get_utc_timestamp()
        db.commit()

        return


intial_views_lang_dict = {
    "recurring_themes": {
        "en": {
            "title": "Recurring Themes",
            "description": "I will use these to make a detailed report. Give me around 15-18 aspects or more if really necessary. Ensure to merge similar aspects.",
        },
        "nl": {
            "title": "Herhalende Thema's",
            "description": "Ik gebruik deze om een uitgebreide rapport te maken. Geef me ongeveer 15-18 aspecten of meer als het nodig is. Zorg ervoor dat vergelijkbare aspecten worden samengevoegd.",
        },
        "fr": {
            "title": "Thèmes récurrents",
            "description": "Je vais les utiliser pour faire un rapport détaillé. Donnez-moi environ 15-18 aspects ou plus si nécessaire. Assurez-vous de fusionner les aspects similaires.",
        },
        "es": {
            "title": "Temas recurrentes",
            "description": "Los usaré para hacer un informe detallado. Dame alrededor de 15-18 aspectos o más si es necesario. Asegúrate de fusionar aspectos similares.",
        },
        "de": {
            "title": "Wiederkehrende Themen",
            "description": "Ich verwende diese, um ein detailliertes Bericht zu erstellen. Gib mir ungefähr 15-18 Themen oder mehr, falls notwendig. Stellen Sie sicher, dass ähnliche Themen zusammengefasst werden.",
        },
    },
    "sentiment": {
        "en": {
            "title": "Sentiment",
            "description": "Use only 3 aspects",
        },
        "nl": {
            "title": "Sentiment",
            "description": "Gebruik alleen 3 aspecten",
        },
        "fr": {
            "title": "Sentiment",
            "description": "Utilisez uniquement 3 aspects",
        },
        "es": {
            "title": "Sentiment",
            "description": "Utilice solo 3 aspectos",
        },
        "de": {
            "title": "Sentiment",
            "description": "Verwenden Sie nur 3 Themen",
        },
    },
}


@dramatiq.actor(queue_name="network", priority=70)
def task_create_project_library(project_id: str, language: str) -> None:
    logger = getLogger("dembrane.tasks.task_create_project_library")

    logger.info(f"Creating project library for project: {project_id}")

    if language not in intial_views_lang_dict["sentiment"]:
        raise ValueError(f"Language {language} not supported")

    with DatabaseSession() as db:
        try:
            project_analysis_run = ProjectAnalysisRunModel(
                id=generate_uuid(),
                project_id=project_id,
                processing_status=ProcessingStatusEnum.PROCESSING,
                processing_message="Creating your project library",
                processing_started_at=get_utc_timestamp(),
            )

            db.add(project_analysis_run)
            db.commit()

            conversations = directus.get_items(
                "conversation",
                {
                    "query": {
                        "filter": {
                            "project_id": {"_eq": project_id},
                            "is_finished": {"_eq": True},
                        }
                    },
                },
            )

            if len(conversations) == 0:
                logger.info(f"No conversations to process for project: {project_id}")
                return

            conversation_ids = [conversation["id"] for conversation in conversations]

            project_analysis_run.processing_message = (
                f"Gathering quotes from {len(conversations)} conversations"
            )
            db.commit()

            # Create sentiment view message
            create_sentiment_view_message = task_create_view.message(
                project_analysis_run.id,
                intial_views_lang_dict["sentiment"][language]["title"],
                intial_views_lang_dict["sentiment"][language]["description"],
                language,
            )

            # Create theme view message
            create_theme_view_message = task_create_view.message(
                project_analysis_run.id,
                intial_views_lang_dict["recurring_themes"][language]["title"],
                intial_views_lang_dict["recurring_themes"][language]["description"],
                language,
            )

            wf = Workflow(
                Chain(
                    Group(
                        *[
                            task_generate_quotes.message(
                                project_analysis_run.id,
                                conversation_id,
                            )
                            for conversation_id in conversation_ids
                        ],
                    ),
                    Group(
                        *[
                            create_sentiment_view_message,
                            create_theme_view_message,
                        ],
                    ),
                    WithDelay(
                        task_finalize_project_library.message(project_analysis_run.id),
                        delay=3 * 60 * 1000,  # 3 minutes delay
                    ),
                ),
            )

            wf.run()

        except Exception as e:
            logger.error(f"Error creating project library: {e}")
            db.rollback()
            raise e from e
