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
from typing import Any, List, Literal, Optional

import litellm
import requests

from dembrane.s3 import get_signed_url, get_stream_from_s3
from dembrane.llms import MODELS, get_completion_kwargs
from dembrane.prompts import render_prompt
from dembrane.service import file_service, conversation_service
from dembrane.directus import directus
from dembrane.settings import get_settings

logger = logging.getLogger("transcribe")

settings = get_settings()
transcription_cfg = settings.transcription
GCP_SA_JSON = transcription_cfg.gcp_sa_json
ASSEMBLYAI_API_KEY = transcription_cfg.assemblyai_api_key
ASSEMBLYAI_BASE_URL = transcription_cfg.assemblyai_base_url
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


def transcribe_audio_assemblyai(
    audio_file_uri: str,
    language: Optional[str],  # pyright: ignore[reportUnusedParameter]
    hotwords: Optional[List[str]],
) -> tuple[str, dict[str, Any]]:
    """Transcribe audio through AssemblyAI"""
    logger = logging.getLogger("transcribe.transcribe_audio_assemblyai")
    logger.info("Submitting AssemblyAI transcription request for %s", audio_file_uri)

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

    response = requests.post(f"{ASSEMBLYAI_BASE_URL}/v2/transcript", headers=headers, json=data)

    if response.status_code == 200:
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
                raise TranscriptionError(f"Transcription failed: {transcript['error']}")
            else:
                time.sleep(3)
    elif response.status_code == 400:
        raise TranscriptionError(f"Transcription failed: {response.json()['error']}")
    else:
        raise Exception(f"Transcription failed: {response.json()['error']}")


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
        },
    )

    logger.debug(f"transcript_correction_prompt: {transcript_correction_prompt}")

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

    completion_kwargs = get_completion_kwargs(MODELS.MULTI_MODAL_PRO)
    response = litellm.completion(
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
        **completion_kwargs,
    )

    json_response = json.loads(response.choices[0].message.content)

    corrected_transcript = json_response["corrected_transcript"]
    note = json_response["note"]

    logger.debug(f"corrected_transcript: {len(corrected_transcript)}")
    logger.debug(f"note: {note}")

    return corrected_transcript, note


def transcribe_audio_dembrane_25_09(
    audio_file_uri: str,
    language: Optional[str],  # pyright: ignore[reportUnusedParameter]
    hotwords: Optional[List[str]],
    use_pii_redaction: bool = False,
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

    try:
        transcript, response = transcribe_audio_assemblyai(audio_file_uri, language, hotwords)
        logger.debug(f"transcript from assemblyai: {transcript}")
    except TranscriptionError as e:
        logger.info(
            f"Transcription failed with AssemblyAI. So we will continue with the correction workflow with empty transcript: {e}"
        )
        transcript, response = "[Nothing to transcribe]", {}

    # use correction workflow to correct keyterms and fix missing segments
    corrected_transcript, note = _transcript_correction_workflow(
        audio_file_uri, transcript, hotwords, use_pii_redaction
    )

    if corrected_transcript == "":
        corrected_transcript = "[Nothing to transcribe]"

    return corrected_transcript, {
        "note": note,
        "raw": response,
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
    conversation_chunk_id: str, use_pii_redaction: bool = False
) -> str:
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
        logger.error("Failed to process conversation chunk %s: %s", conversation_chunk_id, e)
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
