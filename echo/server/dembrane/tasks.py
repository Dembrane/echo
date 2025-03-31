# mypy: disable-error-code="no-untyped-def"
from typing import List

from celery import Celery, chain, chord, group, signals  # type: ignore
from sentry_sdk import capture_exception
from celery.utils.log import get_task_logger  # type: ignore

import dembrane.tasks_config
from dembrane.utils import generate_uuid, get_utc_timestamp
from dembrane.config import REDIS_URL
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
from dembrane.api.stateless import generate_summary

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


@signals.celeryd_init.connect
def init_sentry_celery(**_kwargs):
    logger.info("initializing sentry for celery")
    init_sentry()


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
    raise exc from BaseException()


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


@celery_app.task(
    bind=True,
    retry_backoff=True,
    ignore_result=True,
    base=BaseTask,
)
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
)
def task_split_audio_chunk(self, chunk_id: str) -> List[str]:
    """
    Split audio chunk into smaller chunks. Returns the list of split chunks.
    """
    with DatabaseSession() as db:
        try:
            return split_audio_chunk(chunk_id)
        except Exception as exc:
            logger.error(f"Error: {exc}")
            db.rollback()
            raise self.retry(exc=exc) from exc


@celery_app.task(
    bind=True,
    retry_backoff=True,
    ignore_result=True,
    base=BaseTask,
)
def task_process_conversation_chunk(self, chunk_id: str):
    with DatabaseSession() as db:
        try:
            chunk = db.get(ConversationChunkModel, chunk_id)

            if chunk is None:
                logger.info(f"Chunk not found: {chunk_id}")
                return None

            chunk.task_id = self.request.id
            db.commit()

            c = chain(
                task_split_audio_chunk.s(chunk_id),
                task_transcribe_conversation_chunks.s(),
            )

            result = c.apply_async()

            return result
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
def task_finish_conversation_hook(self, conversation_id: str):
    try:
        conversation_data = directus.get_items(
            "conversation",
            {
                "query": {
                    "filter": {
                        "id": {"_eq": conversation_id},
                    },
                    "fields": ["id", "chunks.transcript", "project_id.language"],
                    "deep": {
                        "chunks": {"_sort": ["timestamp"], "_limit": "120"},
                    },
                },
            },
        )

        if not conversation_data or len(conversation_data) == 0:
            raise Exception("Conversation not found")

        conversation_data = conversation_data[0]

        language = conversation_data["project_id"]["language"]

        transcript_str = ""

        for chunk in conversation_data["chunks"]:
            if chunk["transcript"] is not None:
                transcript_str += chunk["transcript"]

        if transcript_str == "":
            logger.info(
                f"transcript is empty for conversation: {conversation_id}. so not generating summary"
            )
        else:
            summary = generate_summary(transcript_str, None, language if language else "nl")

            directus.update_item(
                collection_name="conversation",
                item_id=conversation_id,
                item_data={
                    "summary": summary,
                },
            )

    except Exception as e:
        logger.error(f"Error: {e}")
        raise self.retry(exc=e) from e
