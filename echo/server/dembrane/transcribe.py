import io
import os
import logging
import mimetypes
from typing import Optional

import requests
from litellm import transcription

from dembrane.s3 import get_signed_url, get_stream_from_s3
from dembrane.config import (
    LITELLM_WHISPER_URL,
    LITELLM_WHISPER_MODEL,
    RUNPOD_WHISPER_API_KEY,
    LITELLM_WHISPER_API_KEY,
    RUNPOD_WHISPER_BASE_URL,
    LITELLM_WHISPER_API_VERSION,
    RUNPOD_WHISPER_PRIORITY_BASE_URL,
    ENABLE_RUNPOD_WHISPER_TRANSCRIPTION,
    ENABLE_LITELLM_WHISPER_TRANSCRIPTION,
    RUNPOD_WHISPER_MAX_REQUEST_THRESHOLD,
    ENABLE_ENGLISH_TRANSCRIPTION_WITH_LITELLM,
)
from dembrane.prompts import render_prompt
from dembrane.directus import directus
from dembrane.processing_status_utils import ProcessingStatus

logger = logging.getLogger("transcribe")


class TranscriptionError(Exception):
    pass


def queue_transcribe_audio_runpod(
    audio_file_uri: str,
    language: Optional[str],
    whisper_prompt: Optional[str],
    is_priority: bool = False,
) -> str:
    """Transcribe audio using RunPod"""
    logger = logging.getLogger("transcribe.transcribe_audio_runpod")

    try:
        signed_url = get_signed_url(audio_file_uri)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {RUNPOD_WHISPER_API_KEY}",
        }

        input_payload = {
            "audio": signed_url,
            "initial_prompt": whisper_prompt,
        }
        if language:
            input_payload["language"] = language

        data = {
            "input": input_payload
        }

        logger.debug(f"***data: {data}")
        try:
            if is_priority:
                url = f"{str(RUNPOD_WHISPER_PRIORITY_BASE_URL).rstrip('/')}/run"
            else:
                url = f"{str(RUNPOD_WHISPER_BASE_URL).rstrip('/')}/run"
            response = requests.post(url, headers=headers, json=data, timeout=600)
            response.raise_for_status()
            job_id = response.json()["id"]
            return job_id
        except Exception as e:
            logger.error(f"Failed to queue transcription job for RunPod: {e}")
            raise TranscriptionError(f"Failed to queue transcription job for RunPod: {e}") from e
    except Exception as e:
        logger.error(f"Failed to get signed url for {audio_file_uri}: {e}")
        raise TranscriptionError(f"Failed to get signed url for {audio_file_uri}: {e}") from e


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
        response = transcription(
            model=LITELLM_WHISPER_MODEL,
            file=file_upload,
            api_key=LITELLM_WHISPER_API_KEY,
            api_base=LITELLM_WHISPER_URL,
            api_version=LITELLM_WHISPER_API_VERSION,
            language=language,
            prompt=whisper_prompt,
        )
        return response["text"]
    except Exception as e:
        logger.error(f"LiteLLM transcription failed: {e}")
        raise TranscriptionError(f"LiteLLM transcription failed: {e}") from e


# Helper functions extracted to simplify `transcribe_conversation_chunk`
# NOTE: These are internal helpers ‑ they should **not** be considered part of the public API.

def _fetch_chunk(conversation_chunk_id: str):
    """Return a single conversation_chunk row or raise a descriptive ValueError."""
    try:
        chunks = directus.get_items(
            "conversation_chunk",
            {
                "query": {
                    "filter": {"id": {"_eq": conversation_chunk_id}},
                    "fields": [
                        "id",
                        "path",
                        "conversation_id",
                        "timestamp",
                        "source",
                        "runpod_job_status_link",
                        "runpod_request_count",
                    ],
                },
            },
        )

    except Exception as exc:
        logger.error("Failed to get chunks for %s: %s", conversation_chunk_id, exc)
        raise ValueError(f"Failed to get chunks for {conversation_chunk_id}: {exc}") from exc

    if not chunks or not chunks[0]:
        raise ValueError(f"Chunk {conversation_chunk_id} not found")

    chunk = dict(chunks[0])

    # validate
    if not chunk.get("path"):
        raise ValueError(f"chunk {conversation_chunk_id} has no path")

    return chunk


def _fetch_conversation(conversation_id: str):
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


def _should_use_runpod(language: str) -> bool:
    """Decide whether RunPod should be used for the given language."""
    if not ENABLE_RUNPOD_WHISPER_TRANSCRIPTION:
        return False
    # When English + override -> prefer LiteLLM, not RunPod
    if language == "en" and ENABLE_ENGLISH_TRANSCRIPTION_WITH_LITELLM:
        return False
    return True

def _should_use_litellm() -> bool:
    """Decide whether LiteLLM should be used for the given language."""
    if not ENABLE_LITELLM_WHISPER_TRANSCRIPTION:
        return False
    return True

def _get_status_runpod(runpod_job_status_link: str) -> str:
    """Get the status of a RunPod job."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {RUNPOD_WHISPER_API_KEY}",
    }
    response = requests.get(runpod_job_status_link, headers=headers, timeout=30)
    response.raise_for_status()

    response_data = response.json()

    return response_data["status"], response_data

def _process_runpod_transcription(
    chunk: dict,
    conversation_chunk_id: str,
    language: str,
    whisper_prompt: str,
) -> str:
    """Handle RunPod status checking, queuing new jobs and Directus updates.

    Returns:
        str: The conversation chunk ID if successful
    """
    runpod_request_count = chunk["runpod_request_count"]
    source = chunk["source"]
    runpod_job_status_link = chunk["runpod_job_status_link"]

    # 1. Check status of an existing job, if any
    if runpod_job_status_link:
        try:
            job_status, _ = _get_status_runpod(runpod_job_status_link)

            if job_status == "IN_PROGRESS":
                logger.info("RunPod job %s is still in progress", runpod_job_status_link)
                return conversation_chunk_id

        except Exception as exc:  # Broad catch – any issue we continue to (re)queue
            logger.error("Unable to fetch RunPod status from %s: %s", runpod_job_status_link, exc)

    # 2. Respect max-request threshold
    if runpod_request_count >= RUNPOD_WHISPER_MAX_REQUEST_THRESHOLD:
        logger.info("RunPod request threshold reached for chunk %s", conversation_chunk_id)
        directus.update_item(
            collection_name="conversation_chunk",
            item_id=conversation_chunk_id,
            item_data={
                "runpod_job_status_link": None,
                "processing_status": ProcessingStatus.FAILED.value,
                "processing_message": "RunPod request threshold reached",
            },
        )
        return conversation_chunk_id

    # 3. Queue a new transcription job
    is_priority = source == "PORTAL_AUDIO"

    job_id = queue_transcribe_audio_runpod(
        chunk["path"],
        language=language,
        whisper_prompt=whisper_prompt,
        is_priority=is_priority,
    )

    directus.update_item(
        collection_name="conversation_chunk",
        item_id=conversation_chunk_id,
        item_data={
            "runpod_job_status_link": f"{str(RUNPOD_WHISPER_BASE_URL)}/status/{job_id}",
            "runpod_request_count": runpod_request_count + 1,
        },
    )

    return conversation_chunk_id


def transcribe_conversation_chunk(conversation_chunk_id: str) -> str:
    """Process conversation chunk for transcription

    Note: If RunPod is enabled / LiteLLM is disabled / English is enabled with LiteLLM,
    then it errors out.

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
        logger.debug(f"using language: {language}")

        whisper_prompt = _build_whisper_prompt(conversation, language)

        logger.debug(f"whisper_prompt: {whisper_prompt}")

        if _should_use_runpod(language):
            logger.info("Using RunPod for transcription")
            return _process_runpod_transcription(
                chunk, conversation_chunk_id, language, whisper_prompt
            )

        elif _should_use_litellm():
            logger.info("Using LITELLM for transcription")

            transcript = transcribe_audio_litellm(
                chunk["path"], language=language, whisper_prompt=whisper_prompt
            )
            logger.debug(f"transcript: {transcript}")

            directus.update_item(
                "conversation_chunk",
                conversation_chunk_id,
                {
                    "transcript": transcript,
                },
            )

            logger.info(f"Processed chunk for transcription: {conversation_chunk_id}")
            return conversation_chunk_id

        else:
            raise TranscriptionError(
                "No valid transcription configuration found."
                "If `ENABLE_ENGLISH_TRANSCRIPTION_WITH_LITELLM` is enabled, "
                "then `ENABLE_LITELLM_WHISPER_TRANSCRIPTION` must be enabled."
            )

    except Exception as e:
        logger.error(f"Failed to process conversation chunk {conversation_chunk_id}: {e}")
        raise TranscriptionError(f"Failed to process conversation chunk {conversation_chunk_id}: {e}") from e