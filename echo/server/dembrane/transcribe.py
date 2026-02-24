"""
File is messy. Need to split implementations of different transcription providers into different classes perhaps.
Add interface for a generic transcription provider. (Which can be sync or async.)
But it is probably not needed.
Can provide selfhost options through "litellm" and api use through "assembly"
"""

# transcribe.py
import io
import os
import json
import time
import logging
import mimetypes
from base64 import b64encode
from typing import Any, List, Literal, Callable, Optional

import litellm
import requests
import sentry_sdk

from dembrane.s3 import get_signed_url, get_stream_from_s3
from dembrane.llms import MODELS, router_completion
from dembrane.prompts import render_prompt
from dembrane.service import file_service, conversation_service
from dembrane.directus import directus
from dembrane.settings import get_settings
from dembrane.service.project import get_allowed_languages

logger = logging.getLogger("transcribe")

settings = get_settings()
transcription_cfg = settings.transcription
GCP_SA_JSON = transcription_cfg.gcp_sa_json
ASSEMBLYAI_API_KEY = transcription_cfg.assemblyai_api_key
ASSEMBLYAI_BASE_URL = transcription_cfg.assemblyai_base_url
ASSEMBLYAI_WEBHOOK_URL = transcription_cfg.assemblyai_webhook_url
ASSEMBLYAI_WEBHOOK_SECRET = transcription_cfg.assemblyai_webhook_secret
TRANSCRIPTION_PROVIDER = transcription_cfg.provider
LITELLM_TRANSCRIPTION_MODEL = transcription_cfg.litellm_model
LITELLM_TRANSCRIPTION_API_KEY = transcription_cfg.litellm_api_key
LITELLM_TRANSCRIPTION_API_BASE = transcription_cfg.litellm_api_base
LITELLM_TRANSCRIPTION_API_VERSION = transcription_cfg.litellm_api_version

ASSEMBLYAI_MAX_HOTWORDS = 40


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


def transcribe_audio_assemblyai(
    audio_file_uri: str,
    language: Optional[str],  # pyright: ignore[reportUnusedParameter]
    hotwords: Optional[List[str]],
    webhook_url: Optional[str] = None,
    webhook_secret: Optional[str] = None,
) -> tuple[Optional[str], dict[str, Any]]:
    """Transcribe audio through AssemblyAI"""
    logger = logging.getLogger("transcribe.transcribe_audio_assemblyai")
    logger.info("Submitting AssemblyAI transcription request for %s", audio_file_uri)

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ASSEMBLYAI_API_KEY}",
    }

    data: dict[str, Any] = {
        "audio_url": audio_file_uri,
        "speech_models": ["universal-3-pro"],
        "language_detection": True,
        "language_detection_options": {
            "expected_languages": list(set(get_allowed_languages()) | {"pt"}),
        },
    }

    if language:
        if language == "auto":
            data["language_detection_options"]["fallback_language"] = "en"
        else:
            data["language_detection_options"]["fallback_language"] = language

    if hotwords:
        # AssemblyAI supports up to 1000 hotwords
        # We slice to ensure we don't exceed the limit
        data["keyterms_prompt"] = hotwords[:ASSEMBLYAI_MAX_HOTWORDS]

    # Webhook mode: submit and return immediately.
    if webhook_url:
        logger.info("AssemblyAI submit payload uses speech_models=%s", data["speech_models"])
        data["webhook_url"] = webhook_url
        if webhook_secret:
            data["webhook_auth_header_name"] = "X-AssemblyAI-Webhook-Secret"
            data["webhook_auth_header_value"] = webhook_secret

        response = requests.post(f"{ASSEMBLYAI_BASE_URL}/v2/transcript", headers=headers, json=data)
        if response.status_code == 200:
            transcript_id = response.json()["id"]
            logger.info(
                "AssemblyAI job submitted in webhook mode (transcript_id=%s)",
                transcript_id,
            )
            return None, {"transcript_id": transcript_id}
        if response.status_code == 400:
            raise TranscriptionError(f"Transcription failed: {response.json()['error']}")
        raise Exception(f"Transcription failed: {response.json()['error']}")

    logger.info("AssemblyAI submit payload uses speech_models=%s", data["speech_models"])
    response = requests.post(f"{ASSEMBLYAI_BASE_URL}/v2/transcript", headers=headers, json=data)

    if response.status_code == 200:
        transcript_id = response.json()["id"]
        polling_endpoint = f"{ASSEMBLYAI_BASE_URL}/v2/transcript/{transcript_id}"

        # TODO: using webhooks will be ideal, but this is easy to impl and test for ;)
        # we will be blocking some of our cheap "workers" here with time.sleep
        max_polling_duration = 30 * 60  # 30 minutes max
        poll_interval = 3  # seconds between polls
        start_time = time.time()
        poll_count = 0

        while True:
            elapsed = time.time() - start_time
            if elapsed > max_polling_duration:
                raise TranscriptionError(
                    f"Transcription timed out after {max_polling_duration / 60:.0f} minutes "
                    f"(transcript_id: {transcript_id})"
                )

            transcript = requests.get(polling_endpoint, headers=headers).json()
            poll_count += 1

            if transcript["status"] == "completed":
                logger.info(
                    f"Transcription completed in {elapsed:.1f}s after {poll_count} polls "
                    f"(transcript_id: {transcript_id})"
                )
                return transcript["text"], transcript
            elif transcript["status"] == "error":
                raise TranscriptionError(f"Transcription failed: {transcript['error']}")
            else:
                # Log progress every 30 seconds
                if poll_count % 10 == 0:
                    logger.debug(
                        f"Transcription in progress: {transcript['status']} "
                        f"({elapsed:.0f}s elapsed, transcript_id: {transcript_id})"
                    )
                time.sleep(poll_interval)

    elif response.status_code == 400:
        raise TranscriptionError(f"Transcription failed: {response.json()['error']}")
    else:
        raise Exception(f"Transcription failed: {response.json()['error']}")


def fetch_assemblyai_result(transcript_id: str) -> tuple[str, dict[str, Any]]:
    """Fetch a completed AssemblyAI transcript by ID."""
    fetch_logger = logging.getLogger("transcribe.fetch_assemblyai_result")
    headers = {"Authorization": f"Bearer {ASSEMBLYAI_API_KEY}"}
    url = f"{ASSEMBLYAI_BASE_URL}/v2/transcript/{transcript_id}"
    response = requests.get(url, headers=headers)

    if response.status_code != 200:
        raise TranscriptionError(
            f"Failed to fetch transcript {transcript_id}: HTTP {response.status_code}"
        )

    data = response.json()
    status = data.get("status")
    if status == "error":
        raise TranscriptionError(f"Transcript {transcript_id} failed: {data.get('error')}")
    if status != "completed":
        raise TranscriptionError(
            f"Transcript {transcript_id} not completed: status={status}"
        )

    text = data.get("text", "")
    fetch_logger.info("Fetched transcript %s (%d chars)", transcript_id, len(text))
    return text, data


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


def _transcript_correction_workflow(
    audio_file_uri: str,
    candidate_transcript: str,
    hotwords: Optional[List[str]],
    use_pii_redaction: bool,
    custom_guidance_prompt: Optional[str] = None,
) -> tuple[str, str]:
    """
    Correct the transcript using the transcript correction workflow
    """
    logger = logging.getLogger("transcribe.transcript_correction_workflow")

    logger.debug(f"candidate_transcript: {len(candidate_transcript)}")
    logger.debug(f"hotwords: {hotwords}")
    logger.debug(f"audio_file_uri: {audio_file_uri}")

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
            "corrected_transcript": {
                "type": "string",
            },
            "note": {
                "type": "string",
            },
        },
        "required": ["corrected_transcript", "note"],
    }

    assert GCP_SA_JSON, "GCP_SA_JSON is not set"

    # Use router for load balancing and failover across Gemini regions
    response = router_completion(
        MODELS.MULTI_MODAL_PRO,
        messages=[
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": transcript_correction_prompt,
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": candidate_transcript,
                    },
                    _get_audio_file_object(audio_file_uri),
                ],
            },
        ],
        response_format={
            "type": "json_object",
            "response_schema": response_schema,
        },
    )

    json_response = json.loads(response.choices[0].message.content)

    corrected_transcript = json_response["corrected_transcript"]
    note = json_response["note"]

    logger.debug(f"corrected_transcript: {len(corrected_transcript)}")
    logger.debug(f"note: {note}")

    return corrected_transcript, note


def transcribe_audio_dembrane_25_09(
    audio_file_uri: str,
    language: Optional[str] = "en",
    hotwords: Optional[List[str]] = None,
    use_pii_redaction: bool = False,
    custom_guidance_prompt: Optional[str] = None,
    # the other option was to pass in a conversation_chunk_id and save the transcript there
    # didn't want to leak conversation_chunk_id implementation details here
    on_assemblyai_response: Callable[[str, dict[str, Any]], None] = lambda _, __: None,
) -> tuple[str, dict[str, Any]]:
    """Transcribe audio through custom Dembrane-25-09 workflow

    Returns:
        0: The corrected transcript
        1: Object
        {
            "note": The note to the user
            "raw": AssemblyAI response
        }
    """
    logger = logging.getLogger("transcribe.transcribe_audio_dembrane_25_09")

    assemblyai_response_failed = False
    try:
        transcript, response = transcribe_audio_assemblyai(audio_file_uri, language, hotwords)
        if transcript is None:
            raise TranscriptionError(
                "AssemblyAI returned webhook-mode response without transcript text in sync workflow."
            )
        logger.debug(f"transcript from assemblyai: {transcript}")
    except TranscriptionError as e:
        assemblyai_response_failed = True
        logger.info(
            f"Transcription failed with AssemblyAI. So we will continue with the correction workflow with empty transcript: {e}"
        )
        transcript, response = "[Nothing to transcribe]", {}

    try:
        if not assemblyai_response_failed and bool(on_assemblyai_response):
            logger.debug("calling on_assemblyai_response")
            on_assemblyai_response(transcript, response)
    except Exception as e:
        logger.error(f"Error in on_assemblyai_response: {e}")
        sentry_sdk.capture_exception(e)

    # use correction workflow to correct keyterms and fix missing segments
    note = None
    try:
        corrected_transcript, note = _transcript_correction_workflow(
            audio_file_uri, transcript, hotwords, use_pii_redaction, custom_guidance_prompt
        )
    except Exception as e:
        logger.error(f"Error in transcript correction workflow: {e}")
        # if the gemini step fail, just use the assemblyai transcript
        if assemblyai_response_failed:
            raise e from e
        else:
            corrected_transcript = transcript

    if corrected_transcript == "":
        corrected_transcript = "[Nothing to transcribe]"

    return corrected_transcript, {
        "note": note,
        "raw": response,
        "error": None,
    }


def transcribe_audio_dembrane_26_01_redaction(
    audio_file_uri: str,
    language: Optional[str] = "en",
    hotwords: Optional[List[str]] = None,
    custom_guidance_prompt: Optional[str] = None,
) -> tuple[str, dict[str, Any]]:
    """Transcribe audio with full PII redaction pipeline (Dembrane-26-01-redaction).

    Unlike the standard pipeline:
    - No intermediate transcript save (on_assemblyai_response callback is skipped)
    - Regex PII redaction is applied to the raw transcript before correction
    - Only the final fully-redacted transcript is returned/saved

    Returns:
        0: The corrected and PII-redacted transcript
        1: Metadata object
    """
    from dembrane.pii_regex import regex_redact_pii

    logger = logging.getLogger("transcribe.transcribe_audio_dembrane_26_01_redaction")

    assemblyai_response_failed = False
    try:
        transcript, _ = transcribe_audio_assemblyai(audio_file_uri, language, hotwords)
        if transcript is None:
            raise TranscriptionError(
                "AssemblyAI returned webhook-mode response without transcript text in sync workflow."
            )
        logger.debug(f"transcript from assemblyai: {transcript}")
    except TranscriptionError as e:
        assemblyai_response_failed = True
        logger.info(
            f"Transcription failed with AssemblyAI. Continuing with empty transcript: {e}"
        )
        transcript = "[Nothing to transcribe]"

    # Apply regex PII redaction BEFORE the correction workflow
    if not assemblyai_response_failed:
        transcript = regex_redact_pii(transcript)
        logger.info("Applied regex PII redaction to raw transcript")

    # Use correction workflow WITH PII redaction enabled
    note = None
    try:
        corrected_transcript, note = _transcript_correction_workflow(
            audio_file_uri, transcript, hotwords, True, custom_guidance_prompt
        )
    except Exception as e:
        logger.error(f"Error in transcript correction workflow: {e}")
        if assemblyai_response_failed:
            raise e from e
        else:
            corrected_transcript = transcript

    if corrected_transcript == "":
        corrected_transcript = "[Nothing to transcribe]"

    return corrected_transcript, {
        "note": note,
        "raw": {},  # Don't store raw response to avoid leaking un-redacted data
        "error": None,
    }


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


def _get_transcript_provider() -> Literal["LiteLLM", "AssemblyAI", "Dembrane-25-09"]:
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
    try:
        chunk = _fetch_chunk(conversation_chunk_id)
        conversation = _fetch_conversation(chunk["conversation_id"])
        language = conversation["project_id"]["language"] or "en"

        transcript_provider = _get_transcript_provider()

        # If anonymize_transcripts is enabled, use the redaction pipeline
        if anonymize_transcripts and transcript_provider == "Dembrane-25-09":
            logger.info("Using Dembrane-26-01-redaction pipeline (anonymize_transcripts=True)")
            hotwords = _build_hotwords(conversation)
            signed_url = get_signed_url(chunk["path"], expires_in_seconds=3 * 24 * 60 * 60)
            transcript, response = transcribe_audio_dembrane_26_01_redaction(
                signed_url,
                language=language,
                hotwords=hotwords,
            )
            # Only one save — the final redacted transcript
            _save_transcript(
                conversation_chunk_id,
                transcript,
                diarization={"schema": "Dembrane-26-01-redaction", "data": response},
            )
            return conversation_chunk_id

        if use_pii_redaction and transcript_provider != "Dembrane-25-09":
            logger.warning(
                f"PII redaction is not supported for {transcript_provider}. Ignoring use_pii_redaction."
            )

        match transcript_provider:
            case "Dembrane-25-09":
                logger.info("Using Dembrane-25-09 for transcription")
                hotwords = _build_hotwords(conversation)
                signed_url = get_signed_url(chunk["path"], expires_in_seconds=3 * 24 * 60 * 60)
                transcript, response = transcribe_audio_dembrane_25_09(
                    signed_url,
                    language=language,
                    hotwords=hotwords,
                    use_pii_redaction=use_pii_redaction,
                    on_assemblyai_response=lambda transcript, response: _save_transcript(
                        conversation_chunk_id,
                        transcript,
                        diarization={
                            "schema": "Dembrane-25-09-assemblyai-partial",
                            "data": response,
                        },
                    ),
                )
                _save_transcript(
                    conversation_chunk_id,
                    transcript,
                    # repurpose of legacy field. It's not a "diarization". This contains the raw transcription response and word lvl timestamps from Assembly
                    diarization={"schema": "Dembrane-25-09", "data": response},
                )
                return conversation_chunk_id

            case "AssemblyAI":
                logger.info("Using AssemblyAI for transcription")
                hotwords = _build_hotwords(conversation)
                signed_url = get_signed_url(chunk["path"], expires_in_seconds=3 * 24 * 60 * 60)
                assemblyai_transcript, assemblyai_response = transcribe_audio_assemblyai(
                    signed_url, language=language, hotwords=hotwords
                )
                if assemblyai_transcript is None:
                    raise TranscriptionError(
                        "AssemblyAI returned webhook-mode response without transcript text in sync workflow."
                    )
                _save_transcript(
                    conversation_chunk_id,
                    assemblyai_transcript,
                    diarization={
                        "schema": "ASSEMBLYAI",
                        "data": assemblyai_response.get("words", {}),
                    },
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


if __name__ == "__main__":
    transcript, response = transcribe_audio_dembrane_25_09(
        "https://ams3.digitaloceanspaces.com/dbr-echo-dev-uploads/2.wav?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=DO00KZG7DP4VR6VAKQKE%2F20251012%2Fams3%2Fs3%2Faws4_request&X-Amz-Date=20251012T224032Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=ea500dfe3e883259d1ccb4f948a0bd8eeb16646e461a213b081f9b85bd4ca6ea",
        language="en",
        hotwords=["Dembrane", "Sameer"],
        use_pii_redaction=True,
    )

    gemini_transcript = transcript
    assemblyai_transcript = response["raw"]["text"]

    def print_diff(a: str, b: str) -> None:
        for a_line, b_line in zip(a.split("\n"), b.split("\n"), strict=False):
            if a_line != b_line:
                print("Gemini")
                print(a_line)
                print("-" * 10)
                print("AssemblyAI")
                print(b_line)
                print("-" * 10)

    print_diff(gemini_transcript, assemblyai_transcript)
