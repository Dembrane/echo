"""In-dashboard issue reports: store attachments in S3, write a support_request row."""

from __future__ import annotations

import re
import uuid
from typing import Optional
from logging import getLogger
from urllib.parse import urlparse

from fastapi import File, Form, APIRouter, UploadFile, HTTPException
from fastapi.responses import RedirectResponse

from dembrane.s3 import (
    delete_from_s3,
    get_signed_url,
    get_sanitized_s3_key,
    save_to_s3_from_file_like,
    get_file_size_bytes_from_s3,
)
from dembrane.app_user import get_app_user_or_raise, get_directus_user_profile
from dembrane.settings import get_settings
from dembrane.inheritance import user_can_access
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.directus_async import async_directus
from dembrane.api.v2.bff._access import resolve_project_access
from dembrane.api.dependency_auth import DirectusSession, DependencyDirectusSession

logger = getLogger("api.v2.feedback")

router = APIRouter()

ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_ATTACHMENTS = 4
MAX_ATTACHMENT_MB = 10
MAX_MESSAGE_LENGTH = 5000
# Slack unfurls the preview inline and caches it; S3 caps presigned GETs at 7 days.
PREVIEW_URL_TTL_SECONDS = 7 * 24 * 3600
MAX_RELATED_ID_LENGTH = 255
ATTACHMENT_URL_TTL_SECONDS = 300
REPLAY_HOST_SUFFIX = "posthog.com"

_RATE_LIMITER = create_user_rate_limiter(name="feedback_reports", capacity=5, window_seconds=600)

# ruff B008: keep the File() default out of the signature.
_ATTACHMENTS_FILE = File(default=[])


_UNSAFE_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._-]")

_URL_FORBIDDEN_CHARS = re.compile(r"[<>|\s]")


def _safe_filename(name: Optional[str]) -> str:
    """One S3 key segment and one URL path segment, so allow-list it."""
    safe = _UNSAFE_FILENAME_CHARS.sub("_", (name or "").strip())
    # Any ".." is rejected downstream, so collapse dot runs instead of losing the file.
    safe = re.sub(r"\.{2,}", ".", safe).lstrip(". ")
    return safe or "image"


def _attachment_link_base(api_base_url: str) -> str:
    """API_BASE_URL may or may not end in /api; normalize to without."""
    api_base = api_base_url.rstrip("/")
    if api_base.endswith("/api"):
        api_base = api_base[: -len("/api")]
    return api_base


def _safe_http_url(value: Optional[str]) -> Optional[str]:
    """Only plain http(s) links are worth forwarding."""
    if not value or _URL_FORBIDDEN_CHARS.search(value):
        return None
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return value


def _safe_replay_url(value: Optional[str]) -> Optional[str]:
    """The replay link is rendered as a bare label, so pin it to PostHog."""
    url = _safe_http_url(value)
    if url is None:
        return None
    host = (urlparse(url).hostname or "").lower()
    if host != REPLAY_HOST_SUFFIX and not host.endswith("." + REPLAY_HOST_SUFFIX):
        return None
    return url


def _safe_related_id(value: Optional[str]) -> Optional[str]:
    """support_request relation columns are string(255); ignore anything longer."""
    value = (value or "").strip()
    if not value or len(value) > MAX_RELATED_ID_LENGTH:
        return None
    return value


async def _resolve_report_scope(
    workspace_id: Optional[str],
    project_id: Optional[str],
    auth: DirectusSession,
) -> tuple[Optional[str], Optional[str]]:
    """Keep only scope ids the caller can reach; drop both on any doubt."""
    project_id = _safe_related_id(project_id)
    workspace_id = _safe_related_id(workspace_id)
    if not project_id and not workspace_id:
        return None, None
    try:
        if project_id:
            access = await resolve_project_access(project_id, auth)
            # Workspace comes off the project row, never off the client.
            return _safe_related_id(access.workspace_id), project_id

        if workspace_id:
            app_user = await get_app_user_or_raise(auth.user_id)
            if await user_can_access(workspace_id, app_user["id"]):
                return workspace_id, None
    except Exception as exc:  # noqa: BLE001
        # Broad on purpose: a Directus outage must cost the ids, never the report.
        logger.warning("Dropping feedback scope ids: %s", type(exc).__name__)
        return None, None
    logger.info("Dropping feedback scope ids: caller has no access")
    return None, None


def build_report_message(
    *,
    reporter_name: str,
    reporter_email: str,
    message: str,
    session_replay_url: Optional[str],
    attachment_links: list[tuple[str, str]],
) -> str:
    """Plain text for the outbox; server lines first so free text cannot forge them."""
    lines = [
        "Issue report from the dashboard",
        "",
        f"Reporter: {reporter_name} ({reporter_email})",
    ]
    if attachment_links:
        lines.append("Attachments:")
        for preview, durable in attachment_links:
            lines.append(f"- {preview}")
            lines.append(f"  staff link, no expiry: {durable}")
        lines.append("Previews expire after 7 days; staff links keep working.")
    safe_replay = _safe_replay_url(session_replay_url)
    if safe_replay:
        lines.append(f"Session replay: {safe_replay}")
    lines.extend(["", "Message:", message])
    return "\n".join(lines)


def build_report_page_context(
    *,
    page_url: Optional[str],
    locale: Optional[str],
    user_agent: Optional[str],
) -> str:
    parts = []
    safe_page = _safe_http_url(page_url)
    if safe_page:
        parts.append(f"Page: {safe_page}")
    if locale:
        parts.append(f"Locale: {locale[:32]}")
    if user_agent:
        parts.append(f"Browser: {user_agent[:150]}")
    return " | ".join(parts)


@router.post("/reports", status_code=201)
async def create_feedback_report(
    auth: DependencyDirectusSession,
    message: str = Form(...),
    workspace_id: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
    page_url: Optional[str] = Form(None),
    locale: Optional[str] = Form(None),
    user_agent: Optional[str] = Form(None),
    session_replay_url: Optional[str] = Form(None),
    attachments: list[UploadFile] = _ATTACHMENTS_FILE,
) -> dict:
    settings = get_settings()

    message = message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required.")
    if len(message) > MAX_MESSAGE_LENGTH:
        raise HTTPException(status_code=400, detail="Message is too long.")
    if len(attachments) > MAX_ATTACHMENTS:
        raise HTTPException(status_code=400, detail=f"At most {MAX_ATTACHMENTS} attachments.")
    for upload in attachments:
        if upload.content_type not in ALLOWED_IMAGE_TYPES:
            raise HTTPException(status_code=400, detail="Only image attachments.")
        if upload.size is not None and upload.size > MAX_ATTACHMENT_MB * 1024 * 1024:
            raise HTTPException(
                status_code=400, detail=f"Images must be under {MAX_ATTACHMENT_MB}MB."
            )

    # After validation: a malformed request must not spend rate-limit budget.
    await _RATE_LIMITER.check(auth.user_id)

    workspace_id, project_id = await _resolve_report_scope(workspace_id, project_id, auth)

    profile = await get_directus_user_profile(auth.user_id)
    reporter_email = (profile or {}).get("email") or "unknown"
    reporter_name = (profile or {}).get("display_name") or "unknown"

    report_id = str(uuid.uuid4())
    stored_keys: list[str] = []
    attachment_links: list[tuple[str, str]] = []
    api_base = _attachment_link_base(settings.urls.api_base_url)

    try:
        for index, upload in enumerate(attachments):
            try:
                filename = get_sanitized_s3_key(f"{index}-{_safe_filename(upload.filename)}")
                key = f"feedback/{report_id}/{filename}"
                await run_in_thread_pool(
                    save_to_s3_from_file_like,
                    upload,
                    key,
                    False,
                    MAX_ATTACHMENT_MB,
                    content_type=upload.content_type,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            stored_keys.append(key)
            preview_url = await run_in_thread_pool(get_signed_url, key, PREVIEW_URL_TTL_SECONDS)
            attachment_links.append(
                (preview_url, f"{api_base}/api/v2/feedback/attachments/{report_id}/{filename}")
            )

        try:
            created = await async_directus.create_item(
                "support_request",
                {
                    "directus_user_id": auth.user_id,
                    "workspace_id": workspace_id,
                    "project_id": project_id,
                    "message": build_report_message(
                        reporter_name=reporter_name,
                        reporter_email=reporter_email,
                        message=message,
                        session_replay_url=session_replay_url,
                        attachment_links=attachment_links,
                    ),
                    "page_context": build_report_page_context(
                        page_url=page_url,
                        locale=locale,
                        user_agent=user_agent,
                    ),
                    "status": "new",
                },
            )
        except Exception as exc:
            logger.error(
                "Support request create failed for report %s: %s", report_id, type(exc).__name__
            )
            raise HTTPException(status_code=502, detail="Could not save the report.") from exc
    except Exception:
        # No partial success: drop already-stored objects on any failure.
        for key in stored_keys:
            try:
                await run_in_thread_pool(delete_from_s3, key)
            except Exception:  # noqa: BLE001
                logger.warning("Could not clean up %s", key)
        raise

    created_row = created.get("data") if isinstance(created, dict) else {}
    support_request_id = (created_row or {}).get("id")
    logger.info(
        "Feedback report %s stored as support_request %s (%d attachments)",
        report_id,
        support_request_id,
        len(stored_keys),
    )
    return {
        "report_id": report_id,
        "support_request_id": support_request_id,
        "attachment_count": len(stored_keys),
    }


@router.get("/attachments/{report_id}/{filename}")
async def get_feedback_attachment(
    report_id: str,
    filename: str,
    auth: DependencyDirectusSession,
) -> RedirectResponse:
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff only.")
    if "/" in filename or ".." in filename or "/" in report_id or ".." in report_id:
        raise HTTPException(status_code=400, detail="Invalid path.")

    key = f"feedback/{report_id}/{filename}"
    try:
        await run_in_thread_pool(get_file_size_bytes_from_s3, key)
    except Exception as exc:  # noqa: BLE001
        # Also masks credential and endpoint errors, so log it.
        logger.warning("Attachment head failed for %s: %s", key, exc)
        raise HTTPException(status_code=404, detail="Not found.") from exc

    signed = await run_in_thread_pool(get_signed_url, key, ATTACHMENT_URL_TTL_SECONDS)
    return RedirectResponse(url=signed, status_code=307)
