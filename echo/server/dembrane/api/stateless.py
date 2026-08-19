import os
import re
import json
from typing import Any, Annotated
from logging import getLogger
from datetime import datetime, timezone

import sentry_sdk
import nest_asyncio
from fastapi import Form, APIRouter, UploadFile, HTTPException
from pydantic import BaseModel

from dembrane.s3 import delete_from_s3, get_signed_url, save_to_s3_from_file_like
from dembrane.llms import MODELS, router_completion
from dembrane.utils import generate_uuid
from dembrane.prompts import render_prompt
from dembrane.transcribe import TranscriptionError, transcribe_audio_dembrane_26_07
from dembrane.audio_utils import get_duration_from_url
from dembrane.async_helpers import run_in_thread_pool
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DirectusSession, DependencyDirectusSession

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


def _clean_generated_title(content: str) -> str:
    # The model occasionally returns a list of options or wraps the title in
    # quotes/markdown; keep only the first candidate as plain text.
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if not lines:
        return ""

    list_item = re.compile(r"^(?:[-*•]\s+|\d+[.):]\s+)(.+)$")
    candidate = ""
    for line in lines:
        match = list_item.match(line)
        if match:
            candidate = match.group(1)
            break
    if not candidate:
        for i, line in enumerate(lines):
            # Skip preamble like "Here are some options:" when more lines follow
            if line.endswith(":") and i < len(lines) - 1:
                continue
            candidate = line
            break

    candidate = re.sub(r"^\*\*(.+?)\*\*$", r"\1", candidate)
    return candidate.strip().strip("\"'“”‘’").strip()


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
        return _clean_generated_title(response_content)
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

# Marker on the metering row. conversation.source is a plain varchar whose choices
# are a Directus UI hint, not a database constraint, so a new value needs no
# migration; the snapshot's source.json carries the same value so the admin
# dropdown stays truthful.
STATELESS_CONVERSATION_SOURCE = "STATELESS_TRANSCRIPTION"
# There is no participant on a stateless call. A fixed label keeps these rows
# self-describing to anyone who finds one in the database.
STATELESS_PARTICIPANT_NAME = "Voice note"


class StatelessTranscriptionResponse(BaseModel):
    transcript: str
    note: str


async def _assert_project_access(project_id: str, session: DirectusSession) -> None:
    """Gate the endpoint on write access to the named project.

    Mirrors agentic._assert_project_access: staff admins bypass the app-layer model
    (they may have no app_user row) and non-members get 404 rather than 403, matching
    the access ladder's don't-confirm-existence rule.

    The policy is project:update, not conversation:read, because this call spends the
    workspace's audio hours. Read-only observers can see a project's conversations and
    must not be able to bill against it.
    """
    if session.is_admin:
        return

    from dembrane.api.v2.bff._access import resolve_project_access

    access = await resolve_project_access(project_id, session)
    access.require("project:update")


def _probe_duration_seconds(audio_url: str) -> float | None:
    """Audio duration in seconds, or None when it cannot be established.

    The transcription pipeline returns only {"note", "raw", "error"} and no duration,
    so this is the same ffprobe read the normal recording path uses when it stamps
    conversation.duration after merging chunks.

    None is deliberate rather than 0.0: a metering row carrying a made-up duration is
    worse than one carrying a gap, because a written number gets believed.
    """
    try:
        duration = get_duration_from_url(audio_url)
    except Exception:
        logger.exception("Failed to probe audio duration for stateless transcription")
        return None

    if duration <= 0:
        logger.error(
            "ffprobe returned a non-positive duration (%s) for a stateless transcription",
            duration,
        )
        return None
    return duration


async def _record_stateless_usage(project_id: str, duration_seconds: float | None) -> str:
    """Meter one stateless transcription as a conversation row that is born deleted.

    Billing sums conversation.duration across a workspace *including* soft-deleted rows
    (free_tier._workspace_lifetime_audio_hours: "delete preserves billable duration"),
    so setting deleted_at at creation makes the row count for hours while staying out of
    every listing, which all filter on deleted_at.

    Deliberately not conversation_service.create. That helper raises
    ConversationNotOpenForParticipationException when the project is closed to
    participants, which is a portal toggle and has nothing to do with a host
    transcribing their own audio, and it dispatches a conversation.started webhook,
    which would be a lie for a conversation that never started.

    Returns the new conversation id.
    """
    conversation_id = generate_uuid()

    await async_directus.create_item(
        "conversation",
        {
            "id": conversation_id,
            "project_id": project_id,
            "participant_name": STATELESS_PARTICIPANT_NAME,
            "source": STATELESS_CONVERSATION_SOURCE,
            "duration": duration_seconds,
            "is_finished": True,
            "deleted_at": datetime.now(timezone.utc).isoformat(),
        },
    )

    # New duration → bust usage cache, same as the participant upload path, so hours
    # don't wait out the cache TTL before they surface.
    try:
        from dembrane.api.conversation import _invalidate_usage_cache_for_conversation

        await _invalidate_usage_cache_for_conversation(conversation_id)
    except Exception as exc:
        logger.warning(
            "usage cache invalidation failed for stateless conversation %s: %s",
            conversation_id,
            exc,
        )

    return conversation_id


def _parse_hotwords(hotwords: str | None) -> list[str] | None:
    if not hotwords:
        return None
    parsed = [word.strip() for word in hotwords.split(",") if word.strip()]
    return parsed or None


def _stateless_upload_key(filename: str | None) -> str:
    raw_extension = os.path.splitext(filename or "")[1].lower()
    extension = raw_extension if re.fullmatch(r"\.[a-z0-9]{1,9}", raw_extension) else ""
    return f"{STATELESS_UPLOAD_S3_PREFIX}/{generate_uuid()}{extension}"


def _run_stateless_transcription(
    file: UploadFile | None,
    audio_file_uri: str | None,
    language: str | None,
    hotwords: list[str] | None,
    use_pii_redaction: bool,
    anonymize_transcripts: bool,
    custom_guidance_prompt: str | None,
    prompt_override: str | None,
) -> tuple[str, dict[str, Any], float | None]:
    """Blocking pipeline: (optionally) park the upload in S3, transcribe, clean up.

    Runs in the thread pool; exactly one of file / audio_file_uri is set (the
    endpoint validates that).

    Returns (transcript, metadata, duration_seconds). The duration is probed here
    rather than by the caller because a parked upload only exists inside this
    function: the finally below deletes it.
    """
    s3_key: str | None = None

    if file is not None:
        s3_key = _stateless_upload_key(file.filename)
        save_to_s3_from_file_like(file, s3_key, public=False, size_limit_mb=STATELESS_UPLOAD_MAX_MB)
        audio_url = get_signed_url(s3_key, expires_in_seconds=STATELESS_SIGNED_URL_EXPIRY_SECONDS)
    elif audio_file_uri and audio_file_uri.startswith(("http://", "https://")):
        # Full URLs (external or already signed) pass through untouched.
        audio_url = audio_file_uri
    elif audio_file_uri:
        # Bare bucket keys get signed, mirroring transcribe_conversation_chunk.
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
        # After transcription so a probe failure can never cost the caller a
        # transcript, and before the finally so the parked upload is still there.
        return transcript, meta, _probe_duration_seconds(audio_url)
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
    summary="Transcribe one audio file synchronously, storing nothing",
)
async def transcribe_stateless(
    session: DependencyDirectusSession,
    file: UploadFile | None = None,
    project_id: Annotated[str | None, Form()] = None,
    audio_file_uri: Annotated[str | None, Form()] = None,
    language: Annotated[str | None, Form()] = "en",
    hotwords: Annotated[str | None, Form()] = None,
    use_pii_redaction: Annotated[bool, Form()] = False,
    anonymize_transcripts: Annotated[bool, Form()] = False,
    custom_guidance_prompt: Annotated[str | None, Form()] = None,
    prompt_override: Annotated[str | None, Form()] = None,
) -> StatelessTranscriptionResponse:
    """Run the Dembrane-26-07 transcription pipeline on one audio input and return the
    transcript in the response. No transcript, audio or conversation content is stored.

    Provide exactly one of:
    - file: multipart audio upload. It is parked in S3 for the duration of the request
      and deleted afterwards, whether transcription worked or not.
    - audio_file_uri: an S3 key (signed automatically) or a full URL. Never deleted.

    project_id names the project to bill. Any caller with write access to it may use
    this endpoint; the audio duration is metered against that project's workspace as a
    soft-deleted conversation row, which counts for hours and shows up nowhere. Staff
    admins may omit project_id, which is how the endpoint originally worked, and such
    calls are not metered because there is no project to bill.

    hotwords is a comma-separated list. custom_guidance_prompt is appended to the
    default transcription prompt; prompt_override replaces that prompt entirely (the
    PII redaction pass keeps its own dedicated prompt either way).
    """
    if project_id:
        await _assert_project_access(project_id, session)
    elif not session.is_admin:
        raise HTTPException(status_code=403, detail="project_id is required")

    if (file is None) == (audio_file_uri is None):
        raise HTTPException(status_code=400, detail="Provide exactly one of file or audio_file_uri")

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
        transcript, meta, duration_seconds = await run_in_thread_pool(
            _run_stateless_transcription,
            file,
            audio_file_uri,
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

    if project_id:
        if duration_seconds is None:
            # The row is still written: it records that the workspace spent a
            # transcription, and a null duration is queryable as "unknown" in a way
            # that a zero never would be. Loud, because this under-bills.
            logger.error(
                "Metering a stateless transcription for project %s with no duration: "
                "ffprobe could not read the audio",
                project_id,
            )
            sentry_sdk.capture_message(
                "stateless transcription metered without a duration",
                level="error",
            )
        try:
            conversation_id = await _record_stateless_usage(project_id, duration_seconds)
            logger.info(
                "Metered stateless transcription for project %s as conversation %s (%s s)",
                project_id,
                conversation_id,
                duration_seconds,
            )
        except Exception as exc:
            # The caller did the work and gets the transcript. Losing the metering row
            # is our problem to fix, not theirs to retry.
            logger.exception("Failed to meter stateless transcription for project %s", project_id)
            sentry_sdk.capture_exception(exc)

    return StatelessTranscriptionResponse(transcript=transcript, note=meta.get("note") or "")
