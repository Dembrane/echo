"""
File is messy. Need to split implementations of different transcription providers into different classes perhaps.
Add interface for a generic transcription provider. (Which can be sync or async.)
But it is probably not needed.
"""

# transcribe.py
import io
import os
import json
import logging
import mimetypes
from base64 import b64encode
from typing import Any, List, Literal, Optional

import litellm
import requests

from dembrane.s3 import get_signed_url, get_stream_from_s3
from dembrane.llms import MODELS, router_completion
from dembrane.prompts import render_prompt
from dembrane.service import file_service, conversation_service
from dembrane.directus import directus
from dembrane.settings import get_settings
from dembrane.analytics import capture_event_sync

logger = logging.getLogger("transcribe")

settings = get_settings()
transcription_cfg = settings.transcription
GCP_SA_JSON = transcription_cfg.gcp_sa_json
TRANSCRIPTION_PROVIDER = transcription_cfg.provider
LITELLM_TRANSCRIPTION_MODEL = transcription_cfg.litellm_model
LITELLM_TRANSCRIPTION_API_KEY = transcription_cfg.litellm_api_key
LITELLM_TRANSCRIPTION_API_BASE = transcription_cfg.litellm_api_base
LITELLM_TRANSCRIPTION_API_VERSION = transcription_cfg.litellm_api_version


class TranscriptionError(Exception):
    pass


def transcribe_audio_litellm(
    audio_file_uri: str, language: Optional[str], whisper_prompt: Optional[str]
) -> str:
    """Transcribe audio through LiteLLM"""
    logger = logging.getLogger("transcribe.transcribe_audio_litellm")

    try:
        audio_stream = get_stream_from_s3(audio_file_uri)
        audio_bytes = audio_stream.read()
        filename = os.path.basename(audio_file_uri)
        mime_type, _ = mimetypes.guess_type(filename)
        file_upload = (filename, io.BytesIO(audio_bytes), mime_type)
    except Exception as exc:
        logger.error(f"Failed to get audio stream from S3 for {audio_file_uri}: {exc}")
        raise TranscriptionError(f"Failed to get audio stream from S3: {exc}") from exc

    try:
        if not LITELLM_TRANSCRIPTION_MODEL or not LITELLM_TRANSCRIPTION_API_KEY:
            raise TranscriptionError("LiteLLM transcription configuration is incomplete.")

        request_kwargs: dict[str, Any] = {
            "model": LITELLM_TRANSCRIPTION_MODEL,
            "file": file_upload,
            "language": language,
            "prompt": whisper_prompt,
            "api_key": LITELLM_TRANSCRIPTION_API_KEY,
        }

        if LITELLM_TRANSCRIPTION_API_BASE:
            request_kwargs["api_base"] = LITELLM_TRANSCRIPTION_API_BASE
        if LITELLM_TRANSCRIPTION_API_VERSION:
            request_kwargs["api_version"] = LITELLM_TRANSCRIPTION_API_VERSION

        response = litellm.transcription(**request_kwargs)
        return response["text"]
    except Exception as e:
        logger.error(f"LiteLLM transcription failed: {e}")
        raise TranscriptionError(f"LiteLLM transcription failed: {e}") from e


def _get_audio_file_object(audio_file_uri: str) -> Any:
    try:
        audio_stream = file_service.get_stream(audio_file_uri)
        encoded_data = b64encode(audio_stream.read()).decode("utf-8")
        return {
            "type": "file",
            "file": {
                "file_data": "data:audio/mp3;base64,{}".format(encoded_data),
            },
        }
    except Exception as e:
        logger.warning(f"failed to get audio bytes for {audio_file_uri} using file service: {e}")
        logger.info("trying to get audio bytes naively")
        audio_bytes = requests.get(audio_file_uri).content
        encoded_data = b64encode(audio_bytes).decode("utf-8")
        return {
            "type": "file",
            "file": {
                "file_data": "data:audio/mp3;base64,{}".format(encoded_data),
            },
        }


def _transcribe_audio_gemini(
    audio_file_uri: str,
    language: Optional[str],
    hotwords: Optional[List[str]],
    use_pii_redaction: bool,
    custom_guidance_prompt: Optional[str] = None,
) -> tuple[str, str]:
    """Single Gemini pass: transcribe audio directly, normalize hotwords, optional PII redaction."""
    logger = logging.getLogger("transcribe.transcribe_audio_gemini")

    prompt = render_prompt(
        "transcript_from_audio_workflow",
        "en",
        {
            "hotwords_str": ", ".join(hotwords) if hotwords else "",
            "pii_redaction": use_pii_redaction,
            "custom_guidance_prompt": custom_guidance_prompt,
            "language": language,
        },
    )

    response_schema = {
        "type": "object",
        "properties": {
            "corrected_transcript": {"type": "string"},
            "note": {"type": "string"},
        },
        "required": ["corrected_transcript", "note"],
    }

    assert GCP_SA_JSON, "GCP_SA_JSON is not set"

    # Use router for load balancing and failover across Gemini EU regions
    response = router_completion(
        MODELS.MULTI_MODAL_PRO,
        messages=[
            {"role": "system", "content": [{"type": "text", "text": prompt}]},
            {"role": "user", "content": [_get_audio_file_object(audio_file_uri)]},
        ],
        response_format={"type": "json_object", "response_schema": response_schema},
    )

    json_response = json.loads(response.choices[0].message.content)
    transcript = json_response["corrected_transcript"]
    note = json_response["note"]
    logger.debug(f"gemini transcript: {len(transcript)} chars; note: {note}")
    return transcript, note


def _transcript_correction_workflow(
    audio_file_uri: str,
    candidate_transcript: str,
    hotwords: Optional[List[str]],
    use_pii_redaction: bool,
    custom_guidance_prompt: Optional[str] = None,
) -> tuple[str, str]:
    """Correction and PII-redaction pass over a candidate transcript plus its audio.

    This is the same pass that ran under the AssemblyAI pipeline. It reliably redacts
    because the model works on a provided transcript (with audio for reference) as a
    dedicated correct-and-redact task, rather than transcribing and redacting at once.
    """
    logger = logging.getLogger("transcribe.transcript_correction_workflow")

    transcript_correction_prompt = render_prompt(
        "transcript_correction_workflow",
        "en",
        {
            "hotwords_str": ", ".join(hotwords) if hotwords else "",
            "pii_redaction": use_pii_redaction,
            "custom_guidance_prompt": custom_guidance_prompt,
        },
    )

    response_schema = {
        "type": "object",
        "properties": {
            "corrected_transcript": {"type": "string"},
            "note": {"type": "string"},
        },
        "required": ["corrected_transcript", "note"],
    }

    assert GCP_SA_JSON, "GCP_SA_JSON is not set"

    # Use router for load balancing and failover across Gemini EU regions
    response = router_completion(
        MODELS.MULTI_MODAL_PRO,
        messages=[
            {"role": "system", "content": [{"type": "text", "text": transcript_correction_prompt}]},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": candidate_transcript},
                    _get_audio_file_object(audio_file_uri),
                ],
            },
        ],
        response_format={"type": "json_object", "response_schema": response_schema},
    )

    json_response = json.loads(response.choices[0].message.content)
    corrected_transcript = json_response["corrected_transcript"]
    note = json_response["note"]
    logger.debug(f"corrected_transcript: {len(corrected_transcript)} chars; note: {note}")
    return corrected_transcript, note


def transcribe_audio_dembrane_26_07(
    audio_file_uri: str,
    language: Optional[str] = "en",
    hotwords: Optional[List[str]] = None,
    use_pii_redaction: bool = False,
    anonymize_transcripts: bool = False,
    custom_guidance_prompt: Optional[str] = None,
) -> tuple[str, dict[str, Any]]:
    """Transcribe audio through the Dembrane-26-07 workflow: one Gemini EU pass.

    Mirrors the AssemblyAI-era redaction exactly, with Gemini replacing AssemblyAI as
    the transcript source:
    1. Gemini transcribes the audio (pass 1).
    2. When anonymize_transcripts is True, regex_redact_pii is applied to that transcript
       first (same order as the old pipeline).
    3. When redaction is requested (use_pii_redaction or anonymize_transcripts), the
       original correction-and-redaction pass runs on the audio plus that transcript.
    No raw response is stored.

    Returns:
        0: The transcript
        1: {"note": str, "raw": dict, "error": None}
    """
    pii_on = use_pii_redaction or anonymize_transcripts

    # Pass 1: transcription only, no redaction.
    transcript, note = _transcribe_audio_gemini(
        audio_file_uri, language, hotwords, False, custom_guidance_prompt
    )

    # Regex runs before correction, matching the old pipeline order.
    if anonymize_transcripts:
        from dembrane.pii_regex import regex_redact_pii

        transcript = regex_redact_pii(transcript)

    # Never pass keyterms: an empty allow-list is load-bearing so all PII (including
    # hotword names) is redacted, not exempted.
    if pii_on:
        transcript, note = _transcript_correction_workflow(
            audio_file_uri, transcript, hotwords, True, custom_guidance_prompt
        )

    if transcript == "":
        transcript = "[Nothing to transcribe]"

    return transcript, {"note": note, "raw": {}, "error": None}


# Helper functions extracted to simplify `transcribe_conversation_chunk`
# NOTE: These are internal helpers ‑ they should **not** be considered part of the public API.


def _fetch_chunk(conversation_chunk_id: str) -> dict:
    from dembrane.service import conversation_service

    chunk = conversation_service.get_chunk_by_id_or_raise(conversation_chunk_id)

    if not chunk.get("path"):
        raise ValueError(f"chunk {conversation_chunk_id} has no path")

    return chunk


def _fetch_conversation(conversation_id: str) -> dict:
    """Return conversation row (including nested project) or raise ValueError."""
    try:
        conversation_rows = directus.get_items(
            "conversation",
            {
                "query": {
                    "filter": {"id": {"_eq": conversation_id}},
                    "fields": [
                        "id",
                        "project_id",
                        "project_id.language",
                        "project_id.default_conversation_transcript_prompt",
                    ],
                },
            },
        )
    except Exception as exc:
        logger.error("Failed to get conversation for %s: %s", conversation_id, exc)
        raise ValueError(f"Failed to get conversation for {conversation_id}: {exc}") from exc

    if not conversation_rows:
        raise ValueError("Conversation not found")

    return conversation_rows[0]


def _save_transcript(
    conversation_chunk_id: str, transcript: str, diarization: Optional[dict] = None
) -> None:
    conversation_service.update_chunk(
        conversation_chunk_id, transcript=transcript, diarization=diarization
    )


def _save_chunk_error(conversation_chunk_id: str, error_message: str) -> None:
    """Save an error to a chunk's error field."""
    try:
        conversation_service.update_chunk(conversation_chunk_id, error=error_message)
        logger.info(f"Saved error to chunk {conversation_chunk_id}: {error_message[:100]}")
    except Exception as e:
        logger.error(f"Failed to save error to chunk {conversation_chunk_id}: {e}")


# Errors that indicate the chunk has no usable audio content
# These should NOT be retried - the chunk is processed, just has no speech
RECOVERABLE_ERRORS = [
    "no spoken audio",
    "language_detection cannot be performed",
    "audio duration is too short",
    "file size",  # catches various file size errors
    "empty file",
]


def _is_recoverable_error(error: Exception) -> bool:
    """Check if an error is recoverable (chunk should be marked as failed, not retried)."""
    error_str = str(error).lower()
    return any(pattern in error_str for pattern in RECOVERABLE_ERRORS)


def _report_transcription_failure(
    conversation_chunk_id: str, error: Exception, conversation_id: Optional[str] = None
) -> None:
    """Fire-and-forget analytics for a chunk that failed transcription, keyed by conversation_id."""
    error_str = str(error).lower()
    recoverable = _is_recoverable_error(error)
    reason = next((pattern for pattern in RECOVERABLE_ERRORS if pattern in error_str), "other")
    capture_event_sync(
        conversation_id or conversation_chunk_id,
        "server_chunk_transcription_failed",
        {
            "chunk_id": conversation_chunk_id,
            "conversation_id": conversation_id,
            "recoverable": recoverable,
            "error_reason": reason,
        },
    )


def _build_whisper_prompt(conversation: dict, language: str) -> str:
    """Compose the whisper prompt from defaults and project-specific overrides."""
    default_prompt = render_prompt("default_whisper_prompt", language, {})
    prompt_parts: list[str] = []

    if default_prompt:
        prompt_parts.append(default_prompt)

    project_prompt = conversation["project_id"].get("default_conversation_transcript_prompt")
    if project_prompt:
        prompt_parts.append(" " + project_prompt + ".")

    return " ".join(prompt_parts)


def _build_hotwords(conversation: dict) -> Optional[List[str]]:
    """Build the hotwords from the conversation"""
    hotwords_str = conversation["project_id"].get("default_conversation_transcript_prompt")
    if hotwords_str:
        return [str(word.strip()) for word in hotwords_str.split(",")]
    return None


def _get_transcript_provider() -> Literal["LiteLLM", "Dembrane-26-07"]:
    if TRANSCRIPTION_PROVIDER:
        return TRANSCRIPTION_PROVIDER
    raise TranscriptionError("No valid transcription configuration found.")


def transcribe_conversation_chunk(
    conversation_chunk_id: str, use_pii_redaction: bool = False, anonymize_transcripts: bool = False
) -> str:
    """
    Process conversation chunk for transcription
    matches on _get_transcript_provider()

    Args:
        conversation_chunk_id: The ID of the chunk to transcribe.
        use_pii_redaction: Enable PII redaction in the correction workflow.
        anonymize_transcripts: Enable full anonymization pipeline (regex pre-redaction,
            no intermediate save, only final redacted transcript stored).

    Returns:
        str: The conversation chunk ID if successful

    Raises:
        ValueError: If the conversation chunk is not found or has no path.
        TranscriptionError: If the transcription fails.
    """
    logger = logging.getLogger("transcribe.transcribe_conversation_chunk")
    conversation_id: Optional[str] = None
    try:
        chunk = _fetch_chunk(conversation_chunk_id)
        conversation_id = chunk.get("conversation_id")
        conversation = _fetch_conversation(chunk["conversation_id"])
        language = conversation["project_id"]["language"] or "en"

        transcript_provider = _get_transcript_provider()

        if use_pii_redaction and transcript_provider != "Dembrane-26-07":
            logger.warning(
                f"PII redaction is not supported for {transcript_provider}. Ignoring use_pii_redaction."
            )

        match transcript_provider:
            case "Dembrane-26-07":
                logger.info("Using Dembrane-26-07 for transcription")
                hotwords = _build_hotwords(conversation)
                signed_url = get_signed_url(chunk["path"], expires_in_seconds=3 * 24 * 60 * 60)
                transcript, response = transcribe_audio_dembrane_26_07(
                    signed_url,
                    language=language,
                    hotwords=hotwords,
                    use_pii_redaction=use_pii_redaction,
                    anonymize_transcripts=anonymize_transcripts,
                    custom_guidance_prompt=conversation["project_id"].get(
                        "default_conversation_transcript_prompt"
                    ),
                )
                _save_transcript(
                    conversation_chunk_id,
                    transcript,
                    diarization={"schema": "Dembrane-26-07-gemini", "data": response},
                )
                return conversation_chunk_id

            case "LiteLLM":
                logger.info("Using LITELLM for transcription")
                whisper_prompt = _build_whisper_prompt(conversation, language)
                transcript = transcribe_audio_litellm(
                    chunk["path"], language=language, whisper_prompt=whisper_prompt
                )
                _save_transcript(conversation_chunk_id, transcript, diarization=None)
                return conversation_chunk_id
            case _:
                raise TranscriptionError(
                    f"Unsupported transcription provider: {transcript_provider}"
                )

    except Exception as e:
        error_message = str(e)
        logger.error("Failed to process conversation chunk %s: %s", conversation_chunk_id, e)

        # Always save the error to the chunk for visibility
        _save_chunk_error(conversation_chunk_id, error_message)
        _report_transcription_failure(conversation_chunk_id, e, conversation_id)

        if _is_recoverable_error(e):
            # Recoverable errors: chunk has no usable content, but that's okay
            # Don't raise - let the pipeline continue with other chunks
            logger.info(
                f"Recoverable transcription error for chunk {conversation_chunk_id}, "
                f"marked as failed but not retrying: {error_message[:100]}"
            )
            return conversation_chunk_id  # Return normally so task completes

        # Non-recoverable errors: something went wrong that might be worth retrying
        raise TranscriptionError(
            "Failed to process conversation chunk %s: %s" % (conversation_chunk_id, e)
        ) from e
