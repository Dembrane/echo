# mypy: disable-error-code="no-untyped-def"
from typing import List
from pathlib import Path

from celery import Celery, chain, chord, group, signals, bootsteps  # type: ignore
from sentry_sdk import capture_exception
from celery.signals import worker_ready, worker_shutdown  # type: ignore
from celery.schedules import crontab
from celery.utils.log import get_task_logger  # type: ignore

import dembrane.tasks_config
from dembrane.utils import generate_uuid, get_utc_timestamp
from dembrane.config import REDIS_URL, ENABLE_AUDIO_LIGHTRAG_INPUT
from dembrane.sentry import init_sentry
from dembrane.database import (
    ViewModel,
    QuoteModel,
    AspectModel,
    DatabaseSession,
    ConversationModel,
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
    initialize_insights,
    generate_view_extras,
    assign_aspect_centroid,
    generate_aspect_extras,
    generate_insight_extras,
    generate_conversation_summary,
    cluster_quotes_using_aspect_centroids,
)
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.processing_status_utils import ProcessingStatus
from dembrane.audio_lightrag.main.run_etl import run_etl_pipeline

# File for validating worker readiness
READINESS_FILE = Path("/tmp/celery_ready")

# File for validating worker liveness
HEARTBEAT_FILE = Path("/tmp/celery_worker_heartbeat")


class LivenessProbe(bootsteps.StartStopStep):
    requires = {"celery.worker.components:Timer"}

    def __init__(self, parent, **kwargs):
        super().__init__(parent, **kwargs)
        self.requests = []
        self.tref = None

    def start(self, worker):
        self.tref = worker.timer.call_repeatedly(
            1.0,
            self.update_heartbeat_file,
            (worker,),
            priority=10,
        )

    def stop(self, _worker):
        HEARTBEAT_FILE.unlink(missing_ok=True)

    def update_heartbeat_file(self, _worker):
        HEARTBEAT_FILE.touch()


logger = get_task_logger("celery_tasks")

assert REDIS_URL, "REDIS_URL environment variable is not set"

# TODO: remove this once we have a proper SSL certificate
# for the time atleast isolate using vpc
ssl_params = ""
if REDIS_URL.startswith("rediss://") and "?ssl_cert_reqs=" not in REDIS_URL:
    ssl_params = "?ssl_cert_reqs=CERT_NONE"

celery_app = Celery(
    "tasks",
    broker=REDIS_URL + "/1" + ssl_params,
    result_backend=REDIS_URL + "/1" + ssl_params,
)

celery_app.config_from_object(dembrane.tasks_config)

celery_app.steps["worker"].add(LivenessProbe)


@worker_ready.connect  # type: ignore
def worker_ready(**_):
    READINESS_FILE.touch()


@worker_shutdown.connect  # type: ignore
def worker_shutdown(**_):
    READINESS_FILE.unlink(missing_ok=True)


@signals.celeryd_init.connect
def init_sentry_celery(**_kwargs):
    """
    Initializes Sentry error tracking for Celery workers.
    
    This function sets up Sentry integration to capture and report errors occurring within Celery tasks.
    """
    logger.info("initializing sentry for celery")
    init_sentry()


@celery_app.on_after_configure.connect
def setup_periodic_tasks(sender: Celery, **_kwargs):
    """
    Registers a periodic Celery task to collect unfinished conversations weekly.
    
    Schedules the `test_collect_unfinished_conversations` task to run every Monday at 7:30 AM.
    """
    sender.add_periodic_task(
        crontab(hour=7, minute=30, day_of_week=1),
        test_collect_unfinished_conversations.s(),
    )


class BaseTask(celery_app.Task):  # type: ignore
    """Abstract base class for all tasks in my app."""

    abstract = True

    def on_retry(self, exc, task_id, args, kwargs, einfo):
        """Log the exceptions to sentry at retry."""
        capture_exception(exc)
        super(BaseTask, self).on_retry(exc, task_id, args, kwargs, einfo)

    def on_failure(self, exc, task_id, args, kwargs, einfo):
        """Log the exceptions to sentry."""
        capture_exception(exc)
        super(BaseTask, self).on_failure(exc, task_id, args, kwargs, einfo)


@celery_app.task(
    bind=True,
    retry_backoff=True,
    ignore_result=True,
    base=BaseTask,
)
def log_error(_self, exc: Exception):
    logger.error(f"Error: {exc}")
    try:
        raise exc from exc
    except Exception:
        logger.error(f"Error: {str(exc)}")
        raise


@celery_app.task(
    bind=True,
    retry_backoff=True,
    ignore_result=True,
    base=BaseTask,
)
def task_transcribe_conversation_chunk(self, conversation_chunk_id: str):
    try:
        transcribe_conversation_chunk(conversation_chunk_id)
    except (ValueError, FileNotFoundError) as e:
        raise e
    except Exception as e:
        raise self.retry(exc=e) from e


@celery_app.task(bind=True, retry_backoff=True, ignore_result=True, base=BaseTask)
def task_transcribe_conversation_chunks(self, conversation_chunk_id: List[str]):
    try:
        task_signatures = [
            task_transcribe_conversation_chunk.si(chunk_id).on_error(log_error.s())
            for chunk_id in conversation_chunk_id
        ]

        g = group(*task_signatures)

        result = g.apply_async()

        return result
    except (ValueError, FileNotFoundError) as e:
        raise e
    except Exception as e:
        raise self.retry(exc=e) from e


@celery_app.task(
    bind=True,
    retry_backoff=True,
    ignore_result=False,
    base=BaseTask,
    queue="cpu",
)
def task_split_audio_chunk(self, chunk_id: str) -> List[str]:
    """
    Split audio chunk into smaller chunks. Returns the list of split chunks.
    """
    with DatabaseSession() as db:
        try:
            return split_audio_chunk(chunk_id, "mp3")
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    ignore_result=False,  # Result needs to be stored for chord to work
    base=BaseTask,
)
def task_create_transcription_chord(_self, chunk_ids: List[str], conversation_id: str):
    """
    Create a chord of transcription tasks for each chunk ID,
    with the finish conversation hook as the callback.

    This separates the chord creation into its own task to avoid
    serialization issues with inline functions.
    """
    # Create a task for each chunk ID
    header = [
        task_transcribe_conversation_chunk.si(chunk_id).on_error(log_error.s())
        for chunk_id in chunk_ids
    ]

    # Create the chord with the finish hook as callback
    chord_workflow = chord(header, task_finish_conversation_hook.si(conversation_id))

    # Execute the chord
    return chord_workflow.apply_async()


@celery_app.task(
    bind=True,
    retry_backoff=True,
    ignore_result=True,
    base=BaseTask,
)
def task_process_conversation_chunk(self, chunk_id: str, run_finish_hook: bool = False):
    try:
        chunk = directus.get_item("conversation_chunk", chunk_id)

        if chunk is None:
            raise ValueError(f"Chunk not found: {chunk_id}")

        directus.update_item(
            "conversation_chunk",
            chunk_id,
            {
                "processing_status": ProcessingStatus.PROCESSING.value,
                "processing_message": "Processing chunk",
            },
        )

        if run_finish_hook:
            # First split the audio to get list of chunk IDs
            # Then process each chunk with a chord to ensure the finish hook
            # runs only after ALL transcription tasks complete
            workflow = chain(
                task_split_audio_chunk.s(chunk_id),
                task_create_transcription_chord.s(chunk["conversation_id"]),
            )
        else:
            # Without finish hook, just split and transcribe
            workflow = chain(
                task_split_audio_chunk.s(chunk_id), task_transcribe_conversation_chunks.s()
            )

        result = workflow.apply_async()
        return result
    except Exception as exc:
        logger.error(f"Error: {exc}")
        raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 2},
    ignore_result=False,
    base=BaseTask,
)
def task_generate_quotes(
    self,
    project_analysis_run_id: str,
    conversation_id: str,
):
    with DatabaseSession() as db:
        try:
            # check if no new conversation chunks have been added since the last quote generation
            # if the latest conversation chunk was created after the previous project analysis run was created
            # then we need to create a new project analysis run,
            # otherwise reuse the quotes from the previous project analysis run

            # first we obtain the project ID
            current_project_analysis_run = db.get(ProjectAnalysisRunModel, project_analysis_run_id)
            if current_project_analysis_run is None:
                logger.error(f"Project analysis run not found: {project_analysis_run_id}")
                return
            project_id = current_project_analysis_run.project_id

            # then we obtain the previous project analysis runs
            previous_project_analysis_runs = (
                db.query(ProjectAnalysisRunModel)
                .filter(ProjectAnalysisRunModel.project_id == project_id)
                .order_by(ProjectAnalysisRunModel.created_at.desc())
                # we need only 2
                .limit(2)
                .all()
            )

            # at this point we should have at least 1 project analysis run
            # if there is no history then we go ahead and generate quotes
            if len(previous_project_analysis_runs) == 1:
                logger.info(
                    "Generating quotes for project analysis run because there is no history"
                )
                generate_quotes(db, project_analysis_run_id, conversation_id)
            elif len(previous_project_analysis_runs) == 2:
                # if there is a history we need to check if the latest conversation chunk was created after the latest project analysis run
                logger.info("Checking if we need to generate quotes for project analysis run")
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

        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 2},
    ignore_result=False,
    base=BaseTask,
)
def task_generate_conversation_summary(self, conversation_id: str, language: str):
    with DatabaseSession() as db:
        try:
            generate_conversation_summary(db, conversation_id, language)
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 3},
    ignore_result=False,
    base=BaseTask,
)
def task_generate_insight_extras(self, insight_id: str, language: str):
    with DatabaseSession() as db:
        try:
            generate_insight_extras(db, insight_id, language)
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 3},
    ignore_result=True,
    base=BaseTask,
)
def task_generate_insight_extras_multiple(self, insight_ids: List[str], language: str):
    with DatabaseSession() as db:
        try:
            task_signatures = [
                task_generate_insight_extras.si(insight_id, language).on_error(log_error.s())
                for insight_id in insight_ids
            ]

            result = group(*task_signatures).apply_async()

            return result
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 3},
    ignore_result=False,
    base=BaseTask,
    queue="cpu",
)
def task_initialize_insights(self, project_analysis_run_id: str) -> List[str]:
    with DatabaseSession() as db:
        try:
            return initialize_insights(db, project_analysis_run_id)
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 3},
    ignore_result=False,
    base=BaseTask,
)
def task_generate_insights(self, project_analysis_run_id: str, language: str):
    with DatabaseSession() as db:
        try:
            job = chain(
                task_initialize_insights.si(project_analysis_run_id),
                task_generate_insight_extras_multiple.s(language=language),
            )

            result = job.apply_async()

            return result

        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


# @celery_app.task(
#     bind=True,
#     retry_backoff=True,
#     retry_kwargs={"max_retries": 2},
#     ignore_result=False,
#     base=BaseTask,
# )
# def task_assign_aspect_centroids_and_cluster_quotes(self, project_analysis_run_id: str, view_id: str):
#     with DatabaseSession() as db:
#         try:
#             assign_aspect_centroids_and_cluster_quotes(db, project_analysis_run_id, view_id)
#         except Exception as exc:
#             logger.error(f"Error: {exc}")
#             db.rollback()
#             raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 3},
    ignore_result=False,
    base=BaseTask,
)
def task_generate_aspect_extras(self, aspect_id: str, language: str = "en"):
    with DatabaseSession() as db:
        try:
            generate_aspect_extras(db, aspect_id, language)
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 3},
    ignore_result=False,
    base=BaseTask,
)
def task_generate_view_extras(self, view_id: str, language: str):
    with DatabaseSession() as db:
        try:
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
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 3},
    ignore_result=False,
    base=BaseTask,
    queue="cpu",
)
def task_assign_aspect_centroid(self, aspect_id: str, language: str = "en"):
    with DatabaseSession() as db:
        try:
            assign_aspect_centroid(db, aspect_id, language)
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 3},
    ignore_result=False,
    base=BaseTask,
    queue="cpu",
)
def task_cluster_quotes_using_aspect_centroids(self, view_id: str):
    with DatabaseSession() as db:
        try:
            cluster_quotes_using_aspect_centroids(db, view_id)
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    retry_kwargs={"max_retries": 3},
    ignore_result=False,
    base=BaseTask,
)
def task_create_view(
    _self,
    project_analysis_run_id: str,
    user_query: str,
    user_query_context: str,
    language: str,
):
    with DatabaseSession() as db:
        try:
            project_analysis_run = db.get(ProjectAnalysisRunModel, project_analysis_run_id)

            if project_analysis_run is None:
                logger.info(f"Project analysis run not found: {project_analysis_run_id}")
                return None

            # FIXME: update_progress(self, 1, 4, message="Creating view")
            # TODO: convert to task
            view = initialize_view(
                db, project_analysis_run_id, user_query, user_query_context, language
            )
            view.processing_message = "Clustering aspects"
            db.commit()

            # update_progress(self, 2, 4, message="Clustering quotes")

            aspect_ids = [aspect.id for aspect in view.aspects]
            aspect_jobs = [
                task_assign_aspect_centroid.si(aspect_id, language) for aspect_id in aspect_ids
            ]

            # update_progress(self, 3, 4, message="Clustering quotes")

            aspects = db.query(AspectModel).filter(AspectModel.view_id == view.id).all()
            aspect_extra_jobs = [
                task_generate_aspect_extras.si(aspect.id, language) for aspect in aspects
            ]

            result = chord(
                chord(group(*aspect_jobs), task_cluster_quotes_using_aspect_centroids.si(view.id)),
                chord(group(*aspect_extra_jobs), task_generate_view_extras.si(view.id, language)),
            ).apply_async()

            logger.debug(result)

            # update_progress(self, 4, 4, message="Analysing results")

            return result

        except Exception as e:
            logger.error(f"Error: {e}")
            db.rollback()
            raise


@celery_app.task(bind=True, retry_backoff=True, ignore_result=False, base=BaseTask)
def task_finalize_project_library(_self, project_analysis_run_id: str):
    with DatabaseSession() as db:
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


@celery_app.task(bind=True, retry_backoff=True, ignore_result=False, base=BaseTask)
def task_create_project_library(_self, project_id: str, language: str):
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

            is_insights_enabled = False

            try:
                project = directus.get_items(
                    "project",
                    {
                        "query": {
                            "fields": ["is_library_insights_enabled"],
                            "filter": {"id": {"_eq": project_id}},
                        },
                    },
                )

                if len(project) == 0:
                    logger.error(f"Project not found: {project_id}")
                    return

                project = project[0]

                logger.info(
                    f"for project {project_id} is_insights_enabled: {project['is_library_insights_enabled']}"
                )
                is_insights_enabled = project["is_library_insights_enabled"]
            except Exception as e:
                logger.error(f"Error: {e}")

            db.add(project_analysis_run)
            db.commit()

            conversations = (
                db.query(ConversationModel).filter(ConversationModel.project_id == project_id).all()
            )

            project_analysis_run.processing_message = (
                f"Gathering quotes from {len(conversations)} conversations"
            )
            db.commit()

            quote_s_list = []

            for conversation in conversations:
                quote_s_list.append(
                    chord(
                        task_generate_quotes.si(project_analysis_run.id, conversation.id),
                        task_generate_conversation_summary.si(conversation.id, language),
                    )
                )

            g = group(*quote_s_list)

            if not quote_s_list:
                logger.info(f"No conversations to process for project: {project_id}")
                return

            insight_task = task_generate_insights.si(project_analysis_run.id, language)

            sentiment_view_query = intial_views_lang_dict["sentiment"][language]["title"]
            sentiment_view_description = intial_views_lang_dict["sentiment"][language][
                "description"
            ]

            sentiment_view = task_create_view.si(
                project_analysis_run.id, sentiment_view_query, sentiment_view_description, language
            )

            theme_view_query = intial_views_lang_dict["recurring_themes"][language]["title"]
            theme_view_description = intial_views_lang_dict["recurring_themes"][language][
                "description"
            ]

            theme_view = task_create_view.si(
                project_analysis_run.id, theme_view_query, theme_view_description, language
            )

            if is_insights_enabled:
                callback = chord(
                    group(
                        sentiment_view,
                        theme_view,
                        insight_task,
                    ),
                    task_finalize_project_library.si(project_analysis_run.id),
                )
            else:
                callback = chord(
                    group(
                        sentiment_view,
                        theme_view,
                    ),
                    task_finalize_project_library.si(project_analysis_run.id),
                )

            result = chord(g)(callback.on_error(log_error.s()))

            return result

        except Exception as e:
            logger.error(f"Error: {e}")
            db.rollback()
            raise


@celery_app.task(bind=True, retry_backoff=True, ignore_result=False, base=BaseTask)
def task_summarize_conversation(self, conversation_id: str):
    try:
        from dembrane.api.conversation import summarize_conversation

        summarize_conversation(
            conversation_id, auth=DependencyDirectusSession(user_id="none", is_admin=True)
        )

    except Exception as e:
        logger.error(f"Error: {e}")
        raise self.retry(exc=e) from e


@celery_app.task(
    bind=True,
    retry_backoff=True,
    ignore_result=False,
    base=BaseTask,
    queue="cpu",
)
def task_merge_conversation_chunks(self, conversation_id: str):
    try:
        # Import locally to avoid circular imports
        from dembrane.api.conversation import get_conversation_content

        get_conversation_content(
            conversation_id,
            auth=DependencyDirectusSession(user_id="none", is_admin=True),
            force_merge=True,
            return_url=True,
        )

    except Exception as e:
        logger.error(f"Error: {e}")
        raise self.retry(exc=e) from e


@celery_app.task(bind=True, retry_backoff=True, ignore_result=False, base=BaseTask)
def task_finish_conversation_hook(self, conversation_id: str):
    """
    Marks a conversation as finished and triggers post-processing tasks.
    
    Updates the conversation's status and completion flag in Directus, then asynchronously launches tasks to summarize the conversation and merge its chunks. If audio LightRag input is enabled, also runs the ETL pipeline for the conversation. Retries on exceptions.
    """
    try:
        directus.update_item(
            "conversation",
            conversation_id,
            item_data={
                "is_finished": True,
                "processing_status": ProcessingStatus.COMPLETED.value,
                "processing_message": "Conversation marked as finished",
            },
        )

        signatures = group(
            task_summarize_conversation.si(conversation_id),
            task_merge_conversation_chunks.si(conversation_id),
        )

        signatures.apply_async()

        logger.info(f"Processing conversation {conversation_id} started")

        if ENABLE_AUDIO_LIGHTRAG_INPUT:
            run_etl_pipeline([conversation_id])
    except Exception as e:
        logger.error(f"Error: {e}")
        raise self.retry(exc=e) from e
