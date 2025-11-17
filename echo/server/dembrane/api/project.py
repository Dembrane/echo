import os
import asyncio
import zipfile
from http import HTTPStatus
from typing import Any, List, Optional, Generator
from logging import getLogger
from datetime import datetime

from fastapi import Depends, APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from fastapi.responses import StreamingResponse

from dembrane.tasks import task_create_view, task_create_project_library
from dembrane.utils import generate_uuid, get_safe_filename
from dembrane.service import build_conversation_service
from dembrane.settings import get_settings
from dembrane.report_utils import ContextTooLongException, get_report_content_for_project
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.exceptions import (
    ProjectLanguageNotSupportedException,
)
from dembrane.service.project import (
    ProjectService,
    ProjectServiceException,
    ProjectNotFoundException,
)
from dembrane.api.dependency_auth import DependencyDirectusSession, require_directus_client

logger = getLogger("api.project")

ProjectRouter = APIRouter(
    tags=["project"],
    dependencies=[Depends(require_directus_client)],
)
PROJECT_ALLOWED_LANGUAGES = ["en", "nl", "de", "fr", "es"]
settings = get_settings()
BASE_DIR = settings.base_dir


class CreateProjectRequestSchema(BaseModel):
    name: Optional[str] = None
    context: Optional[str] = None
    language: Optional[str] = None
    is_conversation_allowed: Optional[bool] = None
    default_conversation_title: Optional[str] = None
    default_conversation_description: Optional[str] = None
    default_conversation_finish_text: Optional[str] = None


@ProjectRouter.post("")
async def create_project(
    body: CreateProjectRequestSchema,
    auth: DependencyDirectusSession,
) -> dict:
    if body.language is not None and body.language not in PROJECT_ALLOWED_LANGUAGES:
        raise ProjectLanguageNotSupportedException
    name = body.name or "New Project"
    context = body.context or None
    language = body.language or "en"

    is_conversation_allowed = (
        body.is_conversation_allowed if body.is_conversation_allowed is not None else True
    )

    optional_fields: dict[str, Any] = {
        "context": context,
        "default_conversation_title": body.default_conversation_title,
        "default_conversation_description": body.default_conversation_description,
        "default_conversation_finish_text": body.default_conversation_finish_text,
    }

    filtered_optional_fields = {
        key: value for key, value in optional_fields.items() if value is not None
    }

    project_service = ProjectService(directus_client=auth.client)

    project = await run_in_thread_pool(
        project_service.create,
        name=name,
        language=language,
        is_conversation_allowed=is_conversation_allowed,
        directus_user_id=auth.user_id,
        id=generate_uuid(),
        **filtered_optional_fields,
    )

    return project


def _parse_iso_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value

    if isinstance(value, str):
        normalized = value.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(normalized)
        except ValueError:
            logger.warning(
                "Unable to parse datetime string '%s', falling back to current UTC", value
            )

    return datetime.utcnow()


def _sanitize_for_filename(text: str, max_length: int = 30) -> str:
    if not text:
        return ""
    safe_text = "".join(c if c.isalnum() else "_" for c in text)
    safe_text = "_".join(filter(None, safe_text.split("_")))
    return safe_text[:max_length]


def _generate_transcript_file_sync(conversation: dict) -> Optional[str]:
    conversation_id = conversation.get("id")
    logger.info(f"generating transcript for conversation {conversation_id}")

    chunks: List[dict] = conversation.get("chunks") or []
    if not chunks:
        return None

    transcript_lines = [
        str(chunk.get("transcript"))
        for chunk in chunks
        if isinstance(chunk, dict) and chunk.get("transcript")
    ]

    if not transcript_lines:
        return None

    created_at = _parse_iso_datetime(conversation.get("created_at"))
    timestamp = created_at.strftime("%Y%m%d_%H%M%S")

    name_for_file = f"{timestamp}"

    name_value = conversation.get("participant_name")
    if name_value:
        safe_name = _sanitize_for_filename(name_value, max_length=50)
        if safe_name:
            name_for_file += f"_{safe_name}"

    email_value = conversation.get("participant_email")
    if email_value:
        email_part = email_value.split("@")[0]
        safe_email = _sanitize_for_filename(email_part, max_length=30)
        if safe_email:
            name_for_file += f"_{safe_email}"

    if conversation_id:
        name_for_file += f"_{conversation_id[:8]}"

    conversation_dir = os.path.join(BASE_DIR, "transcripts", conversation_id or "unknown")
    os.makedirs(conversation_dir, exist_ok=True)

    file_path = os.path.join(conversation_dir, f"{name_for_file}-transcript.md")

    with open(file_path, "w") as file:
        for line in transcript_lines:
            file.write(line + "\n")

    return file_path


async def generate_transcript_file(conversation: dict) -> Optional[str]:
    return await run_in_thread_pool(_generate_transcript_file_sync, conversation)


async def cleanup_files(zip_file_name: str, filenames: List[str]) -> None:
    os.remove(zip_file_name)
    for filename in filenames:
        os.remove(filename)


@ProjectRouter.get("/{project_id}/transcripts")
async def get_project_transcripts(
    project_id: str,
    auth: DependencyDirectusSession,
    background_tasks: BackgroundTasks,
) -> StreamingResponse:
    from dembrane.service.project import ProjectNotFoundException

    project_service = ProjectService(directus_client=auth.client)

    try:
        project = await run_in_thread_pool(project_service.get_by_id_or_raise, project_id)
    except ProjectNotFoundException as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc

    if not auth.is_admin and project.get("directus_user_id", "") != auth.user_id:
        raise HTTPException(status_code=403, detail="User does not have access to this project")

    conversation_service_auth = build_conversation_service(auth.client)

    conversations = await run_in_thread_pool(
        conversation_service_auth.list_by_project,
        project_id,
        with_chunks=True,
        with_tags=False,
    )

    if not conversations:
        raise HTTPException(status_code=404, detail="No conversations found for this project")

    conversations_with_transcripts = [
        conversation
        for conversation in conversations
        if any(
            isinstance(chunk, dict) and chunk.get("transcript")
            for chunk in (conversation.get("chunks") or [])
        )
    ]

    if not conversations_with_transcripts:
        raise HTTPException(status_code=404, detail="No transcripts available for this project")

    filenames_with_none: List[Optional[str]] = await asyncio.gather(
        *[generate_transcript_file(conversation) for conversation in conversations_with_transcripts]
    )

    filenames: List[str] = [filename for filename in filenames_with_none if filename is not None]

    if not filenames:
        raise HTTPException(status_code=404, detail="No transcripts available for this project")

    project_name_or_id = project.get("name") if project.get("name") is not None else project_id
    safe_project_name = get_safe_filename(str(project_name_or_id))
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
    project_service = ProjectService(directus_client=auth.client)

    try:
        project = await run_in_thread_pool(project_service.get_by_id_or_raise, project_id)
    except ProjectServiceException as e:
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
    project_service = ProjectService(directus_client=auth.client)
    project_analysis_run = await run_in_thread_pool(
        project_service.get_latest_analysis_run, project_id
    )

    if not project_analysis_run:
        raise HTTPException(status_code=404, detail="No analysis found for this project")

    try:
        project = await run_in_thread_pool(project_service.get_by_id_or_raise, project_id)
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
async def create_report(
    project_id: str,
    body: CreateReportRequestBodySchema,
    auth: DependencyDirectusSession,
) -> dict:
    project_service = ProjectService(directus_client=auth.client)
    language = body.language or "en"
    try:
        report_content_response = await get_report_content_for_project(project_id, language)
    except ContextTooLongException:
        report = await run_in_thread_pool(
            project_service.create_report,
            project_id,
            language,
            "",
            "error",
            "CONTEXT_TOO_LONG",
        )
        return report
    except Exception as e:
        raise e

    report = await run_in_thread_pool(
        project_service.create_report,
        project_id,
        language,
        report_content_response,
    )
    return report


class CloneProjectRequestBodySchema(BaseModel):
    name: Optional[str] = None
    language: Optional[str] = None


@ProjectRouter.post("/{project_id}/clone")
async def clone_project(
    project_id: str,
    body: CloneProjectRequestBodySchema,
    auth: DependencyDirectusSession,
) -> str:
    project_service = ProjectService(directus_client=auth.client)
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
