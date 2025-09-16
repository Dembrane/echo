"""
File is messy. Need to split implementations of different transcription providers into different classes perhaps.
Add interface for a generic transcription provider. (Which can be sync or async.)
But it is probably not needed.
Can provide selfhost options through "litellm" and api use through "assembly"
"""

# transcribe.py
import io
import os
import time
import logging
import mimetypes
from typing import Any, List, Literal, Optional

import requests
from litellm import transcription

from dembrane.s3 import get_signed_url, get_stream_from_s3
from dembrane.config import (
    API_BASE_URL,
    ASSEMBLYAI_API_KEY,
    ASSEMBLYAI_BASE_URL,
    LITELLM_WHISPER_URL,
    LITELLM_WHISPER_MODEL,
    RUNPOD_WHISPER_API_KEY,
    LITELLM_WHISPER_API_KEY,
    RUNPOD_WHISPER_BASE_URL,
    LITELLM_WHISPER_API_VERSION,
    ENABLE_ASSEMBLYAI_TRANSCRIPTION,
    RUNPOD_WHISPER_PRIORITY_BASE_URL,
    ENABLE_RUNPOD_WHISPER_TRANSCRIPTION,
    ENABLE_LITELLM_WHISPER_TRANSCRIPTION,
    RUNPOD_WHISPER_MAX_REQUEST_THRESHOLD,
)
from dembrane.prompts import render_prompt
from dembrane.service import conversation_service
from dembrane.directus import directus

logger = logging.getLogger("transcribe")


class TranscriptionError(Exception):
    pass


def queue_transcribe_audio_runpod(
    audio_file_uri: str,
    language: Optional[str],
    hotwords: Optional[List[str]] = None,
    is_priority: bool = False,
    conversation_chunk_id: Optional[str] = "",
) -> str:
    """Transcribe audio using RunPod"""
    logger = logging.getLogger("transcribe.transcribe_audio_runpod")

    try:
        signed_url = get_signed_url(audio_file_uri, expires_in_seconds=3 * 24 * 60 * 60)  # 3 days
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {RUNPOD_WHISPER_API_KEY}",
        }

        input_payload = {
            "audio": signed_url,
            "hotwords": ", ".join(hotwords) if hotwords else None,
            "conversation_chunk_id": conversation_chunk_id,
        }

        if language:
            input_payload["language"] = language

        data = {
            "input": input_payload,
            "webhook": f"{API_BASE_URL}/stateless/webhook/transcribe",
        }

        logger.debug(f"data: {data}")

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


def transcribe_audio_assemblyai(
    audio_file_uri: str,
    language: Optional[str],  # pyright: ignore[reportUnusedParameter]
    hotwords: Optional[List[str]],
) -> tuple[str, dict[str, Any]]:
    """Transcribe audio through AssemblyAI"""
    logger = logging.getLogger("transcribe.transcribe_audio_assemblyai")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ASSEMBLYAI_API_KEY}",
    }

    data: dict[str, Any] = {
        "audio_url": audio_file_uri,
        "speech_model": "universal",
        "language_detection": True,
        "language_detection_options": {
            "expected_languages": [
                "nl",
                "fr",
                "es",
                "de",
                "it",
                "pt",
                "en",
            ],
        },
    }

    if language:
        if language == "auto":
            data["language_detection_options"]["fallback_language"] = "en"
        else:
            data["language_detection_options"]["fallback_language"] = language

    if hotwords:
        data["keyterms_prompt"] = hotwords

    try:
        response = requests.post(f"{ASSEMBLYAI_BASE_URL}/v2/transcript", headers=headers, json=data)
        response.raise_for_status()

        transcript_id = response.json()["id"]
        polling_endpoint = f"{ASSEMBLYAI_BASE_URL}/v2/transcript/{transcript_id}"

        # TODO: using webhooks will be ideal, but this is easy to impl and test for ;)
        # we will be blocking some of our cheap "workers" here with time.sleep
        while True:
            transcript = requests.get(polling_endpoint, headers=headers).json()
            if transcript["status"] == "completed":
                # return both to add the diarization response later...
                return transcript["text"], transcript
            elif transcript["status"] == "error":
                raise RuntimeError(f"Transcription failed: {transcript['error']}")
            else:
                time.sleep(3)

    except Exception as e:
        logger.error(f"AssemblyAI transcription failed: {e}")
        raise TranscriptionError(f"AssemblyAI transcription failed: {e}") from e


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


def _get_transcript_provider() -> Literal["Runpod", "LiteLLM", "AssemblyAI"]:
    if ENABLE_ASSEMBLYAI_TRANSCRIPTION:
        return "AssemblyAI"
    elif ENABLE_RUNPOD_WHISPER_TRANSCRIPTION:
        return "Runpod"
    elif ENABLE_LITELLM_WHISPER_TRANSCRIPTION:
        return "LiteLLM"
    else:
        raise TranscriptionError("No valid transcription configuration found.")


def _get_status_runpod(runpod_job_status_link: str) -> tuple[str, dict]:
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
    hotwords: Optional[List[str]],
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
            },
        )
        return conversation_chunk_id

    # 3. Queue a new transcription job
    is_priority = source == "PORTAL_AUDIO"

    job_id = queue_transcribe_audio_runpod(
        chunk["path"],
        language=language,
        hotwords=hotwords,
        is_priority=is_priority,
        conversation_chunk_id=conversation_chunk_id,
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
    """
    Process conversation chunk for transcription
    matches on _get_transcript_provider()

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

        match transcript_provider:
            case "AssemblyAI":
                logger.info("Using AssemblyAI for transcription")
                hotwords = _build_hotwords(conversation)
                signed_url = get_signed_url(chunk["path"], expires_in_seconds=3 * 24 * 60 * 60)
                transcript, assemblyai_response = transcribe_audio_assemblyai(
                    signed_url, language=language, hotwords=hotwords
                )
                _save_transcript(
                    conversation_chunk_id,
                    transcript,
                    diarization={
                        "schema": "ASSEMBLYAI",
                        "data": assemblyai_response.get("words", {}),
                    },
                )
                return conversation_chunk_id
            case "Runpod":
                logger.info("Using RunPod for transcription")
                hotwords = _build_hotwords(conversation)
                return _process_runpod_transcription(
                    chunk, conversation_chunk_id, language, hotwords
                )
            case "LiteLLM":
                logger.info("Using LITELLM for transcription")
                whisper_prompt = _build_whisper_prompt(conversation, language)
                transcript = transcribe_audio_litellm(
                    chunk["path"], language=language, whisper_prompt=whisper_prompt
                )
                _save_transcript(conversation_chunk_id, transcript, diarization=None)
                return conversation_chunk_id

    except Exception as e:
        logger.error("Failed to process conversation chunk %s: %s", conversation_chunk_id, e)
        raise TranscriptionError(
            "Failed to process conversation chunk %s: %s" % (conversation_chunk_id, e)
        ) from e
