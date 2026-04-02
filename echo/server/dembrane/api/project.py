import os
import asyncio
import zipfile
from http import HTTPStatus
from typing import Any, List, Optional, Generator, AsyncGenerator
from logging import getLogger
from datetime import datetime

from fastapi import Query, Depends, Request, APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from fastapi.responses import StreamingResponse

from dembrane.tasks import task_create_view, task_create_report, task_create_project_library
from dembrane.utils import generate_uuid, get_safe_filename
from dembrane.service import build_conversation_service
from dembrane.settings import get_settings
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.exceptions import (
    ProjectLanguageNotSupportedException,
)
from dembrane.service.project import (
    ProjectService,
    ProjectServiceException,
    ProjectNotFoundException,
    get_allowed_languages,
)
from dembrane.api.dependency_auth import DependencyDirectusSession, require_directus_client

logger = getLogger("api.project")

ProjectRouter = APIRouter(
    tags=["project"],
    dependencies=[Depends(require_directus_client)],
)
settings = get_settings()
BASE_DIR = settings.base_dir


# ── BFF: Projects Home ──────────────────────────────────────────────────


class BffProjectSummary(BaseModel):
    id: str
    name: Optional[str] = None
    updated_at: Optional[str] = None
    language: Optional[str] = None
    pin_order: Optional[int] = None
    conversations_count: int = 0
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None


class BffProjectsHomeResponse(BaseModel):
    pinned: list[BffProjectSummary]
    projects: list[BffProjectSummary]
    total_count: int
    has_more: bool
    is_admin: bool = False


_HOME_FIELDS = [
    "id", "name", "updated_at", "language", "pin_order", "count(conversations)",
]


def _build_project_summary(raw: dict) -> BffProjectSummary:
    owner_name: Optional[str] = None
    owner_email: Optional[str] = None
    user_rel = raw.get("directus_user_id")
    if isinstance(user_rel, dict):
        owner_name = user_rel.get("first_name")
        owner_email = user_rel.get("email")

    return BffProjectSummary(
        id=raw["id"],
        name=raw.get("name"),
        updated_at=raw.get("updated_at"),
        language=raw.get("language"),
        pin_order=raw.get("pin_order"),
        conversations_count=int(raw.get("conversations_count", 0) or 0),
        owner_name=owner_name,
        owner_email=owner_email,
    )


@ProjectRouter.get("/home", response_model=BffProjectsHomeResponse)
async def get_projects_home(
    auth: DependencyDirectusSession,
    search: Optional[str] = Query(None, description="Search term, supports owner:<email> prefix"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    limit: int = Query(15, ge=1, le=100, description="Page size"),
) -> BffProjectsHomeResponse:
    """
    Aggregated endpoint for the projects home page.
    Returns pinned projects and a paginated project list in one call.
    """
    client = auth.client

    # Admin users get owner info via relational fields
    fields = list(_HOME_FIELDS)
    if auth.is_admin:
        fields.extend(["directus_user_id.first_name", "directus_user_id.email"])

    # Fetch pinned projects (always, regardless of search)
    # Admins see only their own pins; non-admins see all (Directus permissions handle scoping)
    pin_filter: dict[str, Any] = {"pin_order": {"_nnull": True}}
    if auth.is_admin:
        pin_filter["directus_user_id"] = {"_eq": auth.user_id}

    pinned_raw = await run_in_thread_pool(
        client.get_items,
        "project",
        {
            "query": {
                "fields": fields,
                "filter": pin_filter,
                "sort": ["pin_order"],
                "limit": 3,
            }
        },
    )
    if not isinstance(pinned_raw, list):
        logger.warning("get_items returned non-list for pinned projects: %s", pinned_raw)
        pinned_raw = []
    pinned = [_build_project_summary(p) for p in pinned_raw]

    # Parse owner: prefix from search string (admin only)
    import re
    owner_term: Optional[str] = None
    text_search: Optional[str] = search
    if search and auth.is_admin:
        match = re.match(r"^owner:(\S+)\s*(.*)", search)
        if match:
            owner_term = match.group(1)
            text_search = match.group(2).strip() or None

    owner_filter: Optional[dict] = None
    if owner_term:
        owner_filter = {
            "_or": [
                {"directus_user_id": {"first_name": {"_icontains": owner_term}}},
                {"directus_user_id": {"email": {"_icontains": owner_term}}},
            ]
        }

    # Build query for paginated project list
    query: dict = {
        "fields": fields,
        "sort": ["-updated_at"],
        "limit": limit + 1,
        "offset": offset,
    }
    if text_search:
        query["search"] = text_search
    if owner_filter:
        query["filter"] = owner_filter

    projects_raw = await run_in_thread_pool(
        client.get_items,
        "project",
        {"query": query},
    )
    if not isinstance(projects_raw, list):
        logger.warning("get_items returned non-list for projects: %s", projects_raw)
        projects_raw = []

    has_more = len(projects_raw) > limit
    projects = [_build_project_summary(p) for p in projects_raw[:limit]]

    # Get total count (only when not searching/filtering, for pinned-section threshold)
    total_count = 0
    if not text_search and not owner_filter:
        count_result = await run_in_thread_pool(
            client.get_items,
            "project",
            {"query": {"aggregate": {"count": ["id"]}}},
        )
        if isinstance(count_result, list) and len(count_result) > 0:
            total_count = int(count_result[0].get("count", {}).get("id", 0))
    else:
        total_count = offset + len(projects) + (1 if has_more else 0)

    return BffProjectsHomeResponse(
        pinned=pinned,
        projects=projects,
        total_count=total_count,
        has_more=has_more,
        is_admin=auth.is_admin,
    )


class PinProjectRequest(BaseModel):
    pin_order: Optional[int] = None


@ProjectRouter.patch("/{project_id}/pin")
async def toggle_project_pin(
    project_id: str,
    body: PinProjectRequest,
    auth: DependencyDirectusSession,
) -> dict:
    """Pin or unpin a project. Admins can only pin projects they own."""
    if body.pin_order is not None and body.pin_order not in (1, 2, 3):
        raise HTTPException(status_code=400, detail="pin_order must be 1, 2, or 3")

    client = auth.client

    # Ownership check: admins can only pin/unpin projects they own
    if auth.is_admin:
        project_service = ProjectService(directus_client=client)
        try:
            project = await run_in_thread_pool(project_service.get_by_id_or_raise, project_id)
        except ProjectNotFoundException as e:
            raise HTTPException(status_code=404, detail="Project not found") from e

        if project.get("directus_user_id") != auth.user_id:
            raise HTTPException(
                status_code=403,
                detail="Admins can only pin projects they own",
            )

    await run_in_thread_pool(
        client.update_item,
        "project",
        project_id,
        {"pin_order": body.pin_order},
    )
    return {"success": True, "pin_order": body.pin_order}


# ── Project CRUD ────────────────────────────────────────────────────────


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
    if body.language is not None and body.language not in get_allowed_languages():
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
    user_instructions: Optional[str] = None
    scheduled_at: Optional[str] = None  # ISO 8601 datetime with timezone


@ProjectRouter.post("/{project_id}/create-report", status_code=HTTPStatus.ACCEPTED)
async def create_report(
    project_id: str,
    body: CreateReportRequestBodySchema,
    auth: DependencyDirectusSession,
) -> dict:
    project_service = ProjectService(directus_client=auth.client)
    language = body.language or "en"

    try:
        project = await run_in_thread_pool(project_service.get_by_id_or_raise, project_id)
    except ProjectNotFoundException as e:
        raise HTTPException(status_code=404, detail="Project not found") from e

    if not auth.is_admin and project.get("directus_user_id", "") != auth.user_id:
        raise HTTPException(status_code=403, detail="User does not have access to this project")

    from dembrane.directus import directus

    # Determine if this is a scheduled report
    is_scheduled = False
    if body.scheduled_at:
        from datetime import timezone as tz

        # Validate scheduled_at is a proper ISO 8601 datetime
        if not isinstance(body.scheduled_at, (str, datetime)):
            raise HTTPException(
                status_code=422,
                detail="scheduled_at must be a valid ISO 8601 datetime string",
            )
        if isinstance(body.scheduled_at, str):
            normalized = body.scheduled_at.replace("Z", "+00:00")
            try:
                scheduled_dt = datetime.fromisoformat(normalized)
            except (ValueError, TypeError) as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Invalid scheduled_at datetime format: {body.scheduled_at}",
                ) from e
        else:
            scheduled_dt = body.scheduled_at

        if scheduled_dt.tzinfo is None:
            scheduled_dt = scheduled_dt.replace(tzinfo=tz.utc)
        if scheduled_dt <= datetime.now(tz.utc):
            raise HTTPException(
                status_code=400,
                detail="scheduled_at must be a future datetime",
            )
        is_scheduled = True

    if not is_scheduled:
        # Check for existing draft report to prevent duplicate generation
        existing_drafts = await run_in_thread_pool(
            directus.get_items,
            "project_report",
            {
                "query": {
                    "filter": {
                        "project_id": {"_eq": project_id},
                        "status": {"_eq": "draft"},
                    },
                    "limit": 1,
                }
            },
        )
        if existing_drafts:
            raise HTTPException(
                status_code=409,
                detail="A report is already being generated for this project",
            )

    # Create report record
    initial_status = "scheduled" if is_scheduled else "draft"
    report = await run_in_thread_pool(
        project_service.create_report, project_id, language, "", initial_status
    )

    # Store user instructions and scheduled_at if provided
    update_fields: dict = {}
    if body.user_instructions:
        update_fields["user_instructions"] = body.user_instructions
    if is_scheduled:
        update_fields["scheduled_at"] = body.scheduled_at

    if update_fields:
        await run_in_thread_pool(
            directus.update_item,
            "project_report",
            str(report["id"]),
            update_fields,
        )

    if not is_scheduled:
        # Dispatch background task immediately
        task_create_report.send(project_id, report["id"], language, body.user_instructions or "")
        logger.info(f"Report generation task dispatched for project {project_id}, report {report['id']}")
    else:
        logger.info(f"Report {report['id']} scheduled for {body.scheduled_at} for project {project_id}")

    return report


async def _verify_project_access(auth: DependencyDirectusSession, project_id: str) -> dict:
    """Verify the authenticated user has access to the given project. Returns the project dict."""
    project_service = ProjectService(directus_client=auth.client)
    try:
        project = await run_in_thread_pool(project_service.get_by_id_or_raise, project_id)
    except (ProjectNotFoundException, ProjectServiceException) as err:
        raise HTTPException(status_code=404, detail="Project not found") from err
    if not auth.is_admin and project.get("directus_user_id", "") != auth.user_id:
        raise HTTPException(status_code=403, detail="User does not have access to this project")
    return project


def _extract_report_title(content: Optional[str]) -> Optional[str]:
    """Extract the first markdown heading from report content."""
    if not content:
        return None
    import re
    match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    return match.group(1).strip() if match else None


@ProjectRouter.get("/{project_id}/reports")
async def list_project_reports(
    project_id: str,
    auth: DependencyDirectusSession,
) -> list:
    """List all reports for a project (including generating), newest first."""
    await _verify_project_access(auth, project_id)
    from dembrane.directus import directus

    reports = await run_in_thread_pool(
        directus.get_items,
        "project_report",
        {
            "query": {
                "filter": {
                    "project_id": {"_eq": project_id},
                    "status": {"_in": ["archived", "published", "scheduled", "draft"]},
                },
                "fields": ["id", "status", "date_created", "language", "user_instructions", "content", "scheduled_at"],
                "sort": ["-date_created"],
            }
        },
    )
    result = []
    for r in (reports or []):
        result.append({
            "id": r["id"],
            "status": r.get("status"),
            "date_created": r.get("date_created"),
            "language": r.get("language"),
            "user_instructions": r.get("user_instructions"),
            "scheduled_at": r.get("scheduled_at"),
            "title": _extract_report_title(r.get("content")),
        })
    return result


@ProjectRouter.get("/{project_id}/reports/latest")
async def get_latest_report(
    project_id: str,
    auth: DependencyDirectusSession,
) -> Optional[dict]:
    """Get the most recent report for a project (any status)."""
    await _verify_project_access(auth, project_id)
    from dembrane.directus import directus

    reports = await run_in_thread_pool(
        directus.get_items,
        "project_report",
        {
            "query": {
                "filter": {
                    "project_id": {"_eq": project_id},
                },
                "fields": ["id", "status", "project_id", "show_portal_link", "date_created", "error_message"],
                "sort": ["-date_created"],
                "limit": 1,
            }
        },
    )
    return reports[0] if reports else None


class UpdateReportRequestBodySchema(BaseModel):
    status: Optional[str] = None
    show_portal_link: Optional[bool] = None
    content: Optional[str] = None


@ProjectRouter.patch("/{project_id}/reports/{report_id}")
async def update_report(
    project_id: str,
    report_id: int,
    body: UpdateReportRequestBodySchema,
    auth: DependencyDirectusSession,
) -> dict:
    """Update a report's fields."""
    await _verify_project_access(auth, project_id)
    from dembrane.directus import directus

    payload: dict = {}
    if body.status is not None:
        payload["status"] = body.status
    if body.show_portal_link is not None:
        payload["show_portal_link"] = body.show_portal_link
    if body.content is not None:
        payload["content"] = body.content

    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Auto-unpublish other reports when publishing this one
    if payload.get("status") == "published":
        other_published = await run_in_thread_pool(
            directus.get_items,
            "project_report",
            {
                "query": {
                    "filter": {
                        "project_id": {"_eq": project_id},
                        "status": {"_eq": "published"},
                        "id": {"_neq": report_id},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        if isinstance(other_published, list):
            for old_report in other_published:
                await run_in_thread_pool(
                    directus.update_item,
                    "project_report",
                    str(old_report["id"]),
                    {"status": "archived"},
                )

    result = await run_in_thread_pool(
        directus.update_item,
        "project_report",
        str(report_id),
        payload,
    )
    return result.get("data", result)


@ProjectRouter.delete("/{project_id}/reports/{report_id}")
async def delete_report(
    project_id: str,
    report_id: int,
    auth: DependencyDirectusSession,
) -> dict:
    """Delete a report permanently."""
    await _verify_project_access(auth, project_id)
    from dembrane.directus import directus

    # Verify the report exists and belongs to this project
    report = await run_in_thread_pool(
        directus.get_item,
        "project_report",
        str(report_id),
    )
    if not report or str(report.get("project_id")) != project_id:
        raise HTTPException(status_code=404, detail="Report not found")

    await run_in_thread_pool(
        directus.delete_item,
        "project_report",
        str(report_id),
    )
    return {"deleted": True}


@ProjectRouter.post("/{project_id}/reports/{report_id}/cancel-schedule")
async def cancel_scheduled_report(
    project_id: str,
    report_id: int,
    auth: DependencyDirectusSession,
) -> dict:
    """Cancel a scheduled report."""
    await _verify_project_access(auth, project_id)
    from dembrane.directus import directus

    report = await run_in_thread_pool(
        directus.get_item,
        "project_report",
        str(report_id),
    )
    if not report or str(report.get("project_id")) != project_id:
        raise HTTPException(status_code=404, detail="Report not found")

    if report.get("status") != "scheduled":
        raise HTTPException(status_code=400, detail="Report is not scheduled")

    await run_in_thread_pool(
        directus.update_item,
        "project_report",
        str(report_id),
        {"status": "cancelled"},
    )
    return {"cancelled": True}


@ProjectRouter.get("/{project_id}/reports/{report_id}/detail")
async def get_report_detail(
    project_id: str,
    report_id: int,
    auth: DependencyDirectusSession,
) -> dict:
    """Get full details of a specific report."""
    await _verify_project_access(auth, project_id)
    from dembrane.directus import DirectusBadRequest, directus

    try:
        report = await run_in_thread_pool(
            directus.get_item,
            "project_report",
            str(report_id),
        )
    except DirectusBadRequest as err:
        raise HTTPException(status_code=404, detail="Report not found") from err
    if not report or str(report.get("project_id")) != project_id:
        raise HTTPException(status_code=404, detail="Report not found")
    return report


@ProjectRouter.get("/{project_id}/reports/{report_id}/views")
async def get_report_views(
    project_id: str,
    report_id: int,  # noqa: ARG001
    auth: DependencyDirectusSession,
) -> dict:
    """Get view counts for a report."""
    await _verify_project_access(auth, project_id)
    from dembrane.directus import directus

    # Total views across all reports for the project
    all_metrics = await run_in_thread_pool(
        directus.get_items,
        "project_report_metric",
        {
            "query": {
                "filter": {
                    "project_report_id": {
                        "project_id": {"_eq": project_id},
                    },
                },
                "aggregate": {"count": "*"},
            }
        },
    )
    total = 0
    if all_metrics and len(all_metrics) > 0:
        total = int(all_metrics[0].get("count", 0))

    # Recent views (last 10 minutes)
    from datetime import datetime, timezone, timedelta
    ten_mins_ago = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    recent_metrics = await run_in_thread_pool(
        directus.get_items,
        "project_report_metric",
        {
            "query": {
                "filter": {
                    "date_created": {"_gte": ten_mins_ago},
                    "project_report_id": {
                        "project_id": {"_eq": project_id},
                    },
                },
                "aggregate": {"count": "*"},
            }
        },
    )
    recent = 0
    if recent_metrics and len(recent_metrics) > 0:
        recent = int(recent_metrics[0].get("count", 0))

    return {"total": total, "recent": recent}


@ProjectRouter.get("/{project_id}/reports/{report_id}/needs-update")
async def check_report_needs_update(
    project_id: str,
    report_id: int,
    auth: DependencyDirectusSession,
) -> dict:
    """Check if there are newer conversations than the report."""
    await _verify_project_access(auth, project_id)
    from dembrane.directus import directus

    reports = await run_in_thread_pool(
        directus.get_items,
        "project_report",
        {
            "query": {
                "filter": {"id": {"_eq": report_id}},
                "fields": ["id", "date_created", "project_id"],
                "limit": 1,
            }
        },
    )
    if not reports:
        return {"needs_update": False}

    report = reports[0]
    conversations = await run_in_thread_pool(
        directus.get_items,
        "conversation",
        {
            "query": {
                "filter": {"project_id": {"_eq": report.get("project_id")}},
                "fields": ["id", "created_at"],
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    if not conversations:
        return {"needs_update": False}

    report_date = report.get("date_created", "")
    conv_date = conversations[0].get("created_at", "")
    needs_update = conv_date > report_date if report_date and conv_date else False
    return {"needs_update": needs_update}


@ProjectRouter.get("/{project_id}/participants/count")
async def get_participant_count(
    project_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Get count of participants who opted in to email notifications."""
    await _verify_project_access(auth, project_id)
    from dembrane.directus import directus

    participants = await run_in_thread_pool(
        directus.get_items,
        "project_report_notification_participants",
        {
            "query": {
                "filter": {
                    "_and": [
                        {"project_id": {"_eq": project_id}},
                        {"email_opt_in": {"_eq": True}},
                    ],
                },
                "aggregate": {"count": "*"},
            }
        },
    )
    count = 0
    if participants and len(participants) > 0:
        count = int(participants[0].get("count", 0))
    return {"count": count}


@ProjectRouter.get("/{project_id}/reports/{report_id}/progress")
async def stream_report_progress(
    project_id: str,
    report_id: int,
    request: Request,
    auth: DependencyDirectusSession,
) -> StreamingResponse:
    """SSE endpoint for real-time report generation progress."""
    await _verify_project_access(auth, project_id)
    import json
    import time

    from dembrane.report_events import read_report_event, subscribe_report_events

    async def _generate_events() -> AsyncGenerator[str, None]:
        last_heartbeat = time.monotonic()

        # Check if report is already done before subscribing
        from dembrane.directus import directus

        report = await run_in_thread_pool(
            directus.get_item, "project_report", str(report_id)
        )
        if report and report.get("status") in ("archived", "published"):
            yield f"event: progress\ndata: {json.dumps({'type': 'completed', 'message': 'Report ready'})}\n\n"
            return
        if report and report.get("status") == "error":
            yield f"event: progress\ndata: {json.dumps({'type': 'failed', 'message': 'Report generation failed'})}\n\n"
            return

        try:
            async with subscribe_report_events(report_id) as pubsub:
                yield f"event: progress\ndata: {json.dumps({'type': 'connected', 'message': 'Connected'})}\n\n"

                while True:
                    if await request.is_disconnected():
                        break

                    payload = await read_report_event(pubsub, timeout_seconds=1.0)
                    if payload:
                        yield f"event: progress\ndata: {payload}\n\n"

                        try:
                            event = json.loads(payload)
                            if event.get("type") in ("completed", "failed"):
                                break
                        except json.JSONDecodeError:
                            pass
                        continue

                    now = time.monotonic()
                    if now - last_heartbeat >= 10.0:
                        yield "event: heartbeat\ndata: {}\n\n"
                        last_heartbeat = now
        except Exception as exc:
            logger.warning("SSE stream error for report %s: %s", report_id, exc)
            yield f"event: progress\ndata: {json.dumps({'type': 'failed', 'message': 'Stream error'})}\n\n"

    return StreamingResponse(
        _generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
