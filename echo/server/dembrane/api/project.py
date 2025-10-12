import os
import asyncio
import zipfile
from http import HTTPStatus
from typing import List, Optional, Generator
from logging import getLogger

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session
from fastapi.responses import StreamingResponse

from dembrane.tasks import task_create_view, task_create_project_library
from dembrane.utils import generate_uuid, get_safe_filename
from dembrane.config import BASE_DIR
from dembrane.schemas import (
    ProjectSchema,
)
from dembrane.service import project_service
from dembrane.database import (
    ProjectModel,
    ConversationModel,
    DependencyInjectDatabase,
)
from dembrane.directus import DirectusBadRequest, directus_client_context
from dembrane.report_utils import ContextTooLongException, get_report_content_for_project
from dembrane.api.exceptions import (
    ProjectLanguageNotSupportedException,
)
from dembrane.api.conversation import get_conversation, get_conversation_chunks
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = getLogger("api.project")

ProjectRouter = APIRouter(tags=["project"])
PROJECT_ALLOWED_LANGUAGES = ["en", "nl", "de", "fr", "es"]


class CreateProjectRequestSchema(BaseModel):
    name: Optional[str] = None
    context: Optional[str] = None
    language: Optional[str] = None
    is_conversation_allowed: Optional[bool] = None
    default_conversation_title: Optional[str] = None
    default_conversation_description: Optional[str] = None
    default_conversation_finish_text: Optional[str] = None


@ProjectRouter.post("", response_model=ProjectSchema)
async def create_project(
    body: CreateProjectRequestSchema,
    db: DependencyInjectDatabase,
    auth: DependencyDirectusSession,
) -> ProjectModel:
    if body.language is not None and body.language not in PROJECT_ALLOWED_LANGUAGES:
        raise ProjectLanguageNotSupportedException
    name = body.name or "New Project"
    context = body.context or None
    language = body.language or "en"

    project = ProjectModel(
        id=generate_uuid(),
        directus_user_id=auth.user_id,
        name=name,
        context=context,
        language=language,
    )
    db.add(project)
    db.commit()

    return project


async def generate_transcript_file(conversation_id: str, db: Session) -> Optional[str]:
    logger.info(f"generating transcript for conversation {conversation_id}")
    chunks = await get_conversation_chunks(conversation_id, db)

    if not chunks:
        return None

    conversation = await get_conversation(conversation_id, db, load_chunks=False)
    email = conversation.participant_email
    name = conversation.participant_name
    # Add timestamp to make filename unique
    timestamp = conversation.created_at.strftime("%Y%m%d_%H%M%S")

    name_for_file = f"{timestamp}"

    def sanitize_for_filename(text: str, max_length: int = 30) -> str:
        """Sanitize text to be used in filenames by replacing invalid chars with underscore."""
        if not text:
            return ""
        # Replace any non-alphanumeric chars with underscore
        safe_text = "".join(c if c.isalnum() else "_" for c in text)
        # Collapse multiple underscores
        safe_text = "_".join(filter(None, safe_text.split("_")))
        return safe_text[:max_length]

    if name:
        safe_name = sanitize_for_filename(name, max_length=50)
        if safe_name:  # Only add if we have valid chars left
            name_for_file += f"_{safe_name}"

    if email:
        # Extract username part and sanitize
        email_part = email.split("@")[0]
        safe_email = sanitize_for_filename(email_part, max_length=30)
        if safe_email:  # Only add if we have valid chars left
            name_for_file += f"_{safe_email}"

    # Add conversation ID to ensure uniqueness
    name_for_file += f"_{conversation_id[:8]}"

    conversation_dir = os.path.join(BASE_DIR, "transcripts", conversation_id)
    os.makedirs(conversation_dir, exist_ok=True)

    file_path = os.path.join(conversation_dir, f"{name_for_file}-transcript.md")

    with open(file_path, "w") as file:
        for chunk in chunks:
            try:
                if chunk.transcript is not None:
                    file.write(str(chunk.transcript) + "\n")
            except Exception as e:
                logger.error(f"Failed to write transcript for chunk {chunk.id}: {e}")

    return file_path


async def cleanup_files(zip_file_name: str, filenames: List[str]) -> None:
    os.remove(zip_file_name)
    for filename in filenames:
        os.remove(filename)


@ProjectRouter.get("/{project_id}/transcripts")
async def get_project_transcripts(
    project_id: str,
    db: DependencyInjectDatabase,
    auth: DependencyDirectusSession,
    background_tasks: BackgroundTasks,
) -> StreamingResponse:
    project = db.get(ProjectModel, project_id)

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if not auth.is_admin and project.directus_user_id != auth.user_id:
        raise HTTPException(status_code=403, detail="User does not have access to this project")

    conversations = (
        db.query(ConversationModel).filter(ConversationModel.project_id == project_id).all()
    )

    if not conversations:
        raise HTTPException(status_code=404, detail="No conversations found for this project")

    conversations = [
        c for c in conversations if c.chunks and any(ch.transcript is not None for ch in c.chunks)
    ]

    filename_futures = [
        generate_transcript_file(conversation.id, db) for conversation in conversations
    ]

    filenames_with_none: List[str | None] = await asyncio.gather(*filename_futures)

    filenames: List[str] = [filename for filename in filenames_with_none if filename is not None]

    if not filenames:
        raise HTTPException(status_code=404, detail="No transcripts available for this project")

    project_name_or_id = project.name if project.name is not None else project.id
    safe_project_name = get_safe_filename(project_name_or_id)
    zip_file_name = f"{safe_project_name}_transcripts.zip"

    with zipfile.ZipFile(zip_file_name, "w", zipfile.ZIP_DEFLATED) as zipf:
        for filename in filenames:
            if not filename:
                continue
            arcname = os.path.basename(filename)
            zipf.write(filename, arcname)

    def iterfile() -> Generator[bytes, None, None]:
        with open(zip_file_name, "rb") as file:
            yield from file

    response = StreamingResponse(iterfile(), media_type="application/zip")
    response.headers["Content-Disposition"] = f"attachment; filename={zip_file_name}"

    # Schedule cleanup task to run after the response has been sent
    background_tasks.add_task(
        cleanup_files,
        zip_file_name,  # Pass the actual zip filename
        filenames,  # Pass the actual list of generated transcript files
    )

    return response


def get_latest_project_analysis_run(project_id: str) -> Optional[dict]:
    try:
        with directus_client_context() as client:
            analysis_run = client.get_items(
                "project_analysis_run",
                {
                    "query": {
                        "filter": {
                            "project_id": project_id,
                        },
                        "sort": "-created_at",
                    },
                },
            )

            if analysis_run is None:
                return None

            if len(analysis_run) == 0:
                return None

            return analysis_run[0]

    except DirectusBadRequest as e:
        logger.error(f"Failed to get latest project analysis run for project {project_id}: {e}")
        return None


class CreateLibraryRequestBodySchema(BaseModel):
    language: Optional[str] = "en"


@ProjectRouter.post(
    "/{project_id}/create-library",
    status_code=HTTPStatus.ACCEPTED,
)
async def post_create_project_library(
    auth: DependencyDirectusSession,
    project_id: str,
    body: CreateLibraryRequestBodySchema,
) -> None:
    from dembrane.service import project_service
    from dembrane.service.project import ProjectNotFoundException

    try:
        project = project_service.get_by_id_or_raise(project_id)
    except ProjectNotFoundException as e:
        raise HTTPException(status_code=404, detail="Project not found") from e

    if not auth.is_admin and project.get("directus_user_id", "") != auth.user_id:
        raise HTTPException(status_code=403, detail="User does not have access to this project")

    # analysis_run = get_latest_project_analysis_run(project.id)

    # if analysis_run and analysis_run["processing_status"] in [
    #     ProcessingStatusEnum.PENDING,
    #     ProcessingStatusEnum.PROCESSING,
    # ]:
    #     raise HTTPException(
    #         status_code=409,
    #         detail="Analysis is already in progress",
    #     )

    task_create_project_library.send(project_id, body.language or "en")

    logger.info(
        f"Generate Project Library task created for project {project_id}. Language: {body.language}"
    )

    return None


class CreateViewRequestBodySchema(BaseModel):
    query: str
    additional_context: Optional[str] = ""
    language: Optional[str] = "en"


@ProjectRouter.post("/{project_id}/create-view", status_code=HTTPStatus.ACCEPTED)
async def post_create_view(
    project_id: str,
    body: CreateViewRequestBodySchema,
    auth: DependencyDirectusSession,
) -> None:
    project_analysis_run = get_latest_project_analysis_run(project_id)

    if not project_analysis_run:
        raise HTTPException(status_code=404, detail="No analysis found for this project")

    from dembrane.service import project_service
    from dembrane.service.project import ProjectNotFoundException

    try:
        project = project_service.get_by_id_or_raise(project_id)
    except ProjectNotFoundException as e:
        raise HTTPException(status_code=404, detail="Project not found") from e

    if not auth.is_admin and project.get("directus_user_id", "") != auth.user_id:
        raise HTTPException(status_code=403, detail="User does not have access to this project")

    task_create_view.send(
        project_analysis_run["id"],
        body.query,
        body.additional_context or "",
        body.language or "en",
    )

    logger.info(f"Create View task created for project {project_id}. Language: {body.language}")

    return None


class CreateReportRequestBodySchema(BaseModel):
    language: Optional[str] = "en"


@ProjectRouter.post("/{project_id}/create-report")
async def create_report(project_id: str, body: CreateReportRequestBodySchema) -> None:
    language = body.language or "en"
    try:
        report_content_response = await get_report_content_for_project(project_id, language)
    except ContextTooLongException:
        with directus_client_context() as client:
            report = client.create_item(
                "project_report",
                item_data={
                    "content": "",
                    "project_id": project_id,
                    "language": language,
                    "status": "error",
                    "error_code": "CONTEXT_TOO_LONG",
                },
            )["data"]
        return report
    except Exception as e:
        raise e

    with directus_client_context() as client:
        report = client.create_item(
            "project_report",
            item_data={
                "content": report_content_response,
                "project_id": project_id,
                "language": language,
                "status": "archived",
            },
        )["data"]

    return report


class CloneProjectRequestBodySchema(BaseModel):
    name: Optional[str] = None
    language: Optional[str] = None


@ProjectRouter.post("/{project_id}/clone")
async def clone_project(project_id: str, body: CloneProjectRequestBodySchema) -> str:
    logger.info(f"Cloning project {project_id}")

    overrides = {}
    if body.name:
        overrides["name"] = body.name
    if body.language:
        overrides["language"] = body.language

    new_project_id = project_service.create_shallow_clone(
        project_id,
        with_tags=True,
        **overrides,
    )

    return new_project_id
