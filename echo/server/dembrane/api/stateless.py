import os
import re
import json
from typing import Any, Annotated
from logging import getLogger
from datetime import datetime

import nest_asyncio
from fastapi import Form, APIRouter, UploadFile, HTTPException
from pydantic import BaseModel

from dembrane.s3 import delete_from_s3, get_signed_url, save_to_s3_from_file_like
from dembrane.llms import MODELS, router_completion
from dembrane.utils import generate_uuid
from dembrane.prompts import render_prompt
from dembrane.directus import directus
from dembrane.free_tier import workspace_over_cap_active
from dembrane.transcribe import TranscriptionError, transcribe_audio_dembrane_26_07
from dembrane.audio_utils import get_duration_from_s3
from dembrane.cache_utils import invalidate_workspace_and_org_usage
from dembrane.async_helpers import run_in_thread_pool
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

# Enable nested event loops for sync-to-async bridges
nest_asyncio.apply()

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])

# Language code to full name mapping for prompt generation
LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "nl": "Dutch",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
}


def generate_summary(
    transcript: str,
    language: str | None,
    project_context: str | None = None,
    verified_artifacts: list[str] | None = None,
    conversation_title: str | None = None,
) -> str:
    """
    Generate a summary of the transcript using LangChain and a custom API endpoint.

    Args:
        transcript (str): The conversation transcript to summarize.
        language (str | None): The language of the transcript.
        project_context (str | None): Optional project context to include.
        verified_artifacts (list[str] | None): Optional list of verified artifacts.
        conversation_title (str | None): Optional title of the conversation set by the user.

    Returns:
        str: The generated summary.
    """
    # Prepare the prompt template
    prompt = render_prompt(
        "generate_conversation_summary",
        language if language else "en",
        {
            "quote_text_joined": transcript,
            "project_context": project_context,
            # Pass empty list instead of None for Jinja iteration safety
            "verified_artifacts": verified_artifacts or [],
            "conversation_title": conversation_title,
        },
    )

    try:
        # Use router for load balancing and failover
        response = router_completion(
            MODELS.MULTI_MODAL_PRO,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        )
    except Exception as e:
        logger.error(f"LiteLLM completion error: {e}")
        raise

    try:
        response_content = response.choices[0].message.content
        if response_content is None:
            logger.warning("LLM returned None content for summary")
            return ""
        return response_content
    except (IndexError, AttributeError, KeyError) as e:
        logger.error(f"Error getting response content for summary: {e}")
        return ""


def generate_conversation_title(
    summary: str,
    language: str | None,
    existing_titles: list[str] | None = None,
    custom_prompt: str | None = None,
) -> str:
    """
    Generate a 1-3 word title for a conversation based on its summary.

    Args:
        summary (str): The conversation summary to generate a title from.
        language (str | None): The language code (e.g., "en", "nl", "de").
        existing_titles (list[str] | None): Optional list of existing titles for style matching.
        custom_prompt (str | None): Optional custom instructions for title generation.

    Returns:
        str: The generated title.
    """
    language_name = LANGUAGE_NAMES.get(language if language else "en", "English")

    prompt = render_prompt(
        "generate_conversation_title",
        "en",  # Single English prompt that handles multiple languages
        {
            "summary": summary,
            "language_name": language_name,
            "existing_titles": existing_titles or [],
            "custom_prompt": custom_prompt,
        },
    )

    try:
        response = router_completion(
            MODELS.MULTI_MODAL_FAST,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        )
    except Exception as e:
        logger.error(f"LiteLLM completion error for title generation: {e}")
        raise

    try:
        response_content = response.choices[0].message.content
        if response_content is None:
            logger.warning("LLM returned None content for title")
            return ""
        return response_content.strip()
    except (IndexError, AttributeError, KeyError) as e:
        logger.error(f"Error getting response content for title: {e}")
        return ""


def _extract_json_payload(content: str) -> Any:
    stripped = content.strip()
    if stripped.startswith("```"):
        stripped = stripped.removeprefix("```json").removeprefix("```").strip()
        stripped = stripped.removesuffix("```").strip()
    return json.loads(stripped)


def _select_valid_tag_ids_from_response(
    response_content: str,
    allowed_tag_ids: set[str],
    max_tags: int = 3,
) -> list[str]:
    try:
        parsed = _extract_json_payload(response_content)
    except json.JSONDecodeError:
        logger.warning("LLM returned invalid JSON for conversation tag assignment")
        return []

    raw_ids: list[Any]
    if isinstance(parsed, dict):
        raw_ids = parsed.get("tag_ids") or parsed.get("tags") or []
    elif isinstance(parsed, list):
        raw_ids = parsed
    else:
        return []

    selected: list[str] = []
    for raw_id in raw_ids:
        tag_id = raw_id.get("id") if isinstance(raw_id, dict) else raw_id
        if not isinstance(tag_id, str):
            continue
        tag_id = tag_id.strip()
        if tag_id in allowed_tag_ids and tag_id not in selected:
            selected.append(tag_id)
        if len(selected) >= max_tags:
            break
    return selected


def generate_conversation_tag_ids(
    summary: str,
    language: str | None,
    project_tags: list[dict[str, str]],
) -> list[str]:
    """Choose existing project tags that fit a conversation summary.

    This never creates tags. It only assigns from the host-defined project tag
    vocabulary so the result remains a draft for human review.
    """
    allowed_tag_ids = {
        tag["id"]
        for tag in project_tags
        if isinstance(tag.get("id"), str) and isinstance(tag.get("text"), str)
    }
    if not summary.strip() or not allowed_tag_ids:
        return []

    language_name = LANGUAGE_NAMES.get(language if language else "en", "English")
    prompt = render_prompt(
        "generate_conversation_tag_ids",
        "en",
        {
            "summary": summary,
            "language_name": language_name,
            "project_tags": project_tags,
            "max_tags": 3,
        },
    )

    try:
        response = router_completion(
            MODELS.MULTI_MODAL_FAST,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
        )
    except Exception as e:
        logger.error(f"LiteLLM completion error for tag assignment: {e}")
        raise

    try:
        response_content = response.choices[0].message.content
        if response_content is None:
            logger.warning("LLM returned None content for tag assignment")
            return []
        return _select_valid_tag_ids_from_response(response_content, allowed_tag_ids)
    except (IndexError, AttributeError, KeyError) as e:
        logger.error(f"Error getting response content for tag assignment: {e}")
        return []


def validate_segment_id(echo_segment_ids: list[str] | None) -> bool:
    if echo_segment_ids is None:
        return True
    try:
        [int(id) for id in echo_segment_ids]
        return True
    except Exception as e:
        logger.exception(f"Invalid segment ID: {e}")
        return False


@StatelessRouter.post("/webhook/transcribe")
async def transcribe_webhook(payload: dict) -> None:
    logger = getLogger("stateless.webhook.transcribe")
    logger.debug(f"Transcribe webhook received: {payload}")
    logger.info("Transcription webhook received but integration is disabled; ignoring payload.")


# Uploaded audio is parked under this prefix only for the duration of the request.
STATELESS_UPLOAD_S3_PREFIX = "stateless-transcription"
STATELESS_UPLOAD_MAX_MB = 100
STATELESS_SIGNED_URL_EXPIRY_SECONDS = 3600
# webm/mp4 recordings often carry a video/* content type; octet-stream covers
# clients that don't set one at all.
ALLOWED_UPLOAD_CONTENT_TYPES = ("audio/", "video/", "application/octet-stream")
# Conversation source for stateless runs. Rows are created already soft-deleted:
# invisible to every deleted_at-filtered listing, but still summed into workspace
# usage (the duration rollups deliberately include deleted rows).
STATELESS_CONVERSATION_SOURCE = "STATELESS"


class StatelessTranscriptionResponse(BaseModel):
    transcript: str
    note: str
    conversation_id: str | None = None


def _parse_hotwords(hotwords: str | None) -> list[str] | None:
    if not hotwords:
        return None
    parsed = [word.strip() for word in hotwords.split(",") if word.strip()]
    return parsed or None


def _stateless_upload_key(filename: str | None) -> str:
    raw_extension = os.path.splitext(filename or "")[1].lower()
    extension = raw_extension if re.fullmatch(r"\.[a-z0-9]{1,9}", raw_extension) else ""
    return f"{STATELESS_UPLOAD_S3_PREFIX}/{generate_uuid()}{extension}"


async def _resolve_project_access(project_id: str, auth: DependencyDirectusSession) -> Any:
    """Lazy import: _access pulls in the whole v2 package, which imports this
    module back (api.conversation reuses the summary helpers above)."""
    from dembrane.api.v2.bff._access import resolve_project_access

    return await resolve_project_access(project_id, auth)


def _probe_duration_seconds(s3_key: str) -> float | None:
    """Best effort: a failed probe must not fail the transcription, only the billing."""
    try:
        return get_duration_from_s3(s3_key)
    except Exception:
        logger.exception(f"Failed to probe duration for stateless audio: {s3_key}")
        return None


def _record_stateless_conversation(project_id: str, duration: float | None) -> str:
    """Persist the usage record: a conversation born soft-deleted.

    deleted_at keeps it out of every listing and read path; duration still counts
    toward the workspace's audio hours because the usage rollups sum deleted rows.
    """
    conversation = directus.create_item(
        "conversation",
        item_data={
            "id": generate_uuid(),
            "project_id": project_id,
            "source": STATELESS_CONVERSATION_SOURCE,
            "duration": duration,
            "is_finished": True,
            "deleted_at": datetime.utcnow().isoformat(),
        },
    )["data"]
    return conversation["id"]


def _run_stateless_transcription(
    file: UploadFile | None,
    audio_file_uri: str | None,
    project_id: str,
    language: str | None,
    hotwords: list[str] | None,
    use_pii_redaction: bool,
    anonymize_transcripts: bool,
    custom_guidance_prompt: str | None,
    prompt_override: str | None,
) -> tuple[str, dict[str, Any], str | None]:
    """Blocking pipeline: (optionally) park the upload in S3, transcribe, record
    the usage conversation, clean up.

    Runs in the thread pool; exactly one of file / audio_file_uri is set (the
    endpoint validates that). Returns (transcript, meta, conversation_id).
    """
    s3_key: str | None = None
    duration: float | None = None

    if file is not None:
        s3_key = _stateless_upload_key(file.filename)
        save_to_s3_from_file_like(file, s3_key, public=False, size_limit_mb=STATELESS_UPLOAD_MAX_MB)
        duration = _probe_duration_seconds(s3_key)
        audio_url = get_signed_url(s3_key, expires_in_seconds=STATELESS_SIGNED_URL_EXPIRY_SECONDS)
    elif audio_file_uri and audio_file_uri.startswith(("http://", "https://")):
        # Full URLs (external or already signed) pass through untouched. Duration
        # can't be probed without pulling the file, so these bill as 0 seconds;
        # this input is admin-only for that reason (among others).
        audio_url = audio_file_uri
    elif audio_file_uri:
        # Bare bucket keys get signed, mirroring transcribe_conversation_chunk.
        duration = _probe_duration_seconds(audio_file_uri)
        audio_url = get_signed_url(
            audio_file_uri, expires_in_seconds=STATELESS_SIGNED_URL_EXPIRY_SECONDS
        )
    else:
        raise ValueError("No audio input provided")

    try:
        transcript, meta = transcribe_audio_dembrane_26_07(
            audio_url,
            language=language,
            hotwords=hotwords,
            use_pii_redaction=use_pii_redaction,
            anonymize_transcripts=anonymize_transcripts,
            custom_guidance_prompt=custom_guidance_prompt,
            prompt_override=prompt_override,
        )
        # Only successful runs bill; a failed transcription leaves no record. If
        # this insert fails the request fails too, so usage can't go unrecorded.
        conversation_id = _record_stateless_conversation(project_id, duration)
        return transcript, meta, conversation_id
    finally:
        # Stateless means no residue: drop the parked upload even when the
        # transcription failed. Caller-provided URIs are never deleted.
        if s3_key is not None:
            try:
                delete_from_s3(s3_key)
            except Exception:
                logger.exception(f"Failed to delete stateless upload from S3: {s3_key}")


@StatelessRouter.post(
    "/transcribe",
    response_model=StatelessTranscriptionResponse,
    summary="Transcribe one audio file synchronously, storing only a usage record",
)
async def transcribe_stateless(
    session: DependencyDirectusSession,
    project_id: Annotated[str, Form()],
    file: UploadFile | None = None,
    audio_file_uri: Annotated[str | None, Form()] = None,
    language: Annotated[str | None, Form()] = "en",
    hotwords: Annotated[str | None, Form()] = None,
    use_pii_redaction: Annotated[bool, Form()] = False,
    anonymize_transcripts: Annotated[bool, Form()] = False,
    custom_guidance_prompt: Annotated[str | None, Form()] = None,
    prompt_override: Annotated[str | None, Form()] = None,
) -> StatelessTranscriptionResponse:
    """Run the Dembrane-26-07 transcription pipeline on one audio input and return the
    transcript in the response.

    Neither the audio nor the transcript is kept. The only thing written is a
    usage record: a conversation under project_id with source STATELESS, the audio
    duration, and deleted_at pre-set, so the run counts toward workspace hours
    without ever appearing in the dashboard.

    Registered users need edit access to the project; free-tier workspaces past
    their included hours get a 402. Provide exactly one of:
    - file: multipart audio upload. It is parked in S3 for the duration of the request
      and deleted afterwards, whether transcription worked or not.
    - audio_file_uri (admin-only): an S3 key (signed automatically) or a full URL.
      Never deleted.

    hotwords is a comma-separated list. custom_guidance_prompt is appended to the
    default transcription prompt; prompt_override replaces that prompt entirely (the
    PII redaction pass keeps its own dedicated prompt either way).
    """
    if (file is None) == (audio_file_uri is None):
        raise HTTPException(status_code=400, detail="Provide exactly one of file or audio_file_uri")

    # Signing arbitrary bucket keys or fetching arbitrary URLs is an
    # exfiltration/SSRF vector, so that input stays admin-only.
    if audio_file_uri is not None and not session.is_admin:
        raise HTTPException(status_code=403, detail="audio_file_uri is admin-only; upload a file")

    workspace_id: str | None = None
    org_id: str | None = None
    if session.is_admin:
        project = await async_directus.get_item(
            "project",
            project_id,
            params={"fields": "id,deleted_at,workspace_id.id,workspace_id.org_id"},
        )
        if not isinstance(project, dict) or project.get("deleted_at"):
            raise HTTPException(status_code=404, detail="Project not found")
        workspace = project.get("workspace_id")
        if isinstance(workspace, dict):
            workspace_id = workspace.get("id")
            org_id = workspace.get("org_id")
    else:
        access = await _resolve_project_access(project_id, session)
        access.require("project:update")
        workspace_id = access.workspace_id
        org_id = access.org_id
        if await workspace_over_cap_active(workspace_id, access.tier):
            raise HTTPException(
                status_code=402,
                detail="Workspace is over its included audio hours",
            )

    if file is not None:
        if file.content_type and not file.content_type.startswith(ALLOWED_UPLOAD_CONTENT_TYPES):
            raise HTTPException(
                status_code=400, detail=f"Unsupported content type: {file.content_type}"
            )
        file.file.seek(0, 2)
        file_size = file.file.tell()
        file.file.seek(0)
        if file_size == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        if file_size > STATELESS_UPLOAD_MAX_MB * 1024 * 1024:
            raise HTTPException(
                status_code=413,
                detail=f"File size exceeds {STATELESS_UPLOAD_MAX_MB}MB limit",
            )

    try:
        transcript, meta, conversation_id = await run_in_thread_pool(
            _run_stateless_transcription,
            file,
            audio_file_uri,
            project_id,
            language,
            _parse_hotwords(hotwords),
            use_pii_redaction,
            anonymize_transcripts,
            custom_guidance_prompt,
            prompt_override,
        )
    except ValueError as e:
        # Invalid S3 key (path traversal) or an input that failed sanitization.
        raise HTTPException(status_code=400, detail=str(e)) from e
    except TranscriptionError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    if workspace_id:
        await invalidate_workspace_and_org_usage(workspace_id, org_id)

    return StatelessTranscriptionResponse(
        transcript=transcript,
        note=meta.get("note") or "",
        conversation_id=conversation_id,
    )
