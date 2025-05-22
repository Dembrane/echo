import io
import os
import logging
import mimetypes
from typing import Optional

import requests
from litellm import completion, transcription
from langdetect import detect

from dembrane.s3 import get_signed_url, get_stream_from_s3
from dembrane.config import (
    LITELLM_WHISPER_URL,
    SMALL_LITELLM_MODEL,
    RUNPOD_WHISPER_MODEL,
    LITELLM_WHISPER_MODEL,
    SMALL_LITELLM_API_KEY,
    RUNPOD_WHISPER_API_KEY,
    SMALL_LITELLM_API_BASE,
    LITELLM_WHISPER_API_KEY,
    RUNPOD_WHISPER_BASE_URL,
    SMALL_LITELLM_API_VERSION,
    LITELLM_WHISPER_API_VERSION,
    RUNPOD_WHISPER_PRIORITY_BASE_URL,
    ENABLE_RUNPOD_WHISPER_TRANSCRIPTION,
    ENABLE_LITELLM_WHISPER_TRANSCRIPTION,
    RUNPOD_WHISPER_MAX_REQUEST_THRESHOLD,
)

# from dembrane.openai import client
from dembrane.prompts import render_prompt
from dembrane.directus import directus

logger = logging.getLogger("transcribe")


class TranscriptionError(Exception):
    pass


def queue_transcribe_audio_runpod(
    audio_file_uri: str, language: Optional[str], whisper_prompt: Optional[str], is_priority: bool = False
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
            "model": RUNPOD_WHISPER_MODEL,
            "initial_prompt": whisper_prompt,
        }
        if language:
            input_payload["language"] = language

        data = {"input": input_payload}

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
            raise TranscriptionError(
                f"Failed to queue transcription job for RunPod: {e}"
            ) from e
    except Exception as e:
        logger.error(f"Failed to get signed url for {audio_file_uri}: {e}")
        raise TranscriptionError(f"Failed to get signed url for {audio_file_uri}: {e}") from e


def transcribe_audio_litellm(
    audio_file_uri: str, language: Optional[str], whisper_prompt: Optional[str]
) -> str:
    """Transcribe audio using Azure ML Whisper"""
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
        detected_language = detect(response["text"])
        if detected_language != language and language != "multi":
            translation_prompt = render_prompt(
                "translate_transcription",
                str(language),
                {
                    "transcript": response["text"],
                    "detected_language": detected_language,
                    "desired_language": language,
                },
            )
            llm_translation_response = completion(
                model=SMALL_LITELLM_MODEL,
                messages=[{"role": "user", "content": translation_prompt}],
                api_key=SMALL_LITELLM_API_KEY,
                api_base=SMALL_LITELLM_API_BASE,
                api_version=SMALL_LITELLM_API_VERSION,
            )
            return llm_translation_response["choices"][0]["message"]["content"]
        else:
            return response["text"]
    except Exception as e:
        logger.error(f"LiteLLM transcription failed: {e}")
        raise TranscriptionError(f"LiteLLM transcription failed: {e}") from e


def transcribe_conversation_chunk(conversation_chunk_id: str) -> str | None:
    """Process conversation chunk for transcription"""
    logger = logging.getLogger("transcribe.transcribe_conversation_chunk")

    chunks = directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"id": {"_eq": conversation_chunk_id}},
                "fields": ["id", "path", "conversation_id", "timestamp"],
            },
        },
    )

    if not chunks:
        logger.info(f"Chunk {conversation_chunk_id} not found")
        raise ValueError(f"Chunk {conversation_chunk_id} not found")

    chunk = chunks[0]

    if not chunk["path"]:
        logger.info(f"Chunk {conversation_chunk_id} has no path")
        raise ValueError(f"chunk {conversation_chunk_id} has no path")

    # get the exact previous chunk transcript if available
    # previous_chunk = directus.get_items(
    #     "conversation_chunk",
    #     {
    #         "query": {
    #             "filter": {
    #                 "conversation_id": {"_eq": chunk["conversation_id"]},
    #                 "timestamp": {"_lt": chunk["timestamp"]},
    #             },
    #             "fields": ["transcript"],
    #             "limit": 1,
    #         },
    #     },
    # )

    # previous_chunk_transcript = ""

    # if previous_chunk and len(previous_chunk) > 0:
    #     previous_chunk_transcript = previous_chunk[0]["transcript"]

    # fetch conversation details
    conversation = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"id": {"_eq": chunk["conversation_id"]}},
                "fields": [
                    "id",
                    "project_id",
                    "project_id.language",
                    "project_id.default_conversation_transcript_prompt",
                ],
            },
        },
    )

    if not conversation or len(conversation) == 0:
        raise ValueError("Conversation not found")

    conversation = conversation[0]

    language = conversation["project_id"]["language"] or "en"
    logger.debug(f"using language: {language}")

    default_prompt = render_prompt("default_whisper_prompt", language, {})

    # Build whisper prompt more robustly
    prompt_parts = []

    if default_prompt:
        prompt_parts.append(default_prompt)

    if conversation["project_id"]["default_conversation_transcript_prompt"]:
        prompt_parts.append(
            "\n\nuser: Project prompt: \n\n"
            + conversation["project_id"]["default_conversation_transcript_prompt"]
            + "."
        )

    # if previous_chunk_transcript:
    #     prompt_parts.append("\n\nuser: Previous transcript: \n\n" + previous_chunk_transcript)

    whisper_prompt = " ".join(prompt_parts)

    logger.debug(f"whisper_prompt: {whisper_prompt}")

    if ENABLE_RUNPOD_WHISPER_TRANSCRIPTION:
        directus_response = directus.get_items(
            "conversation_chunk",
            {
                "query": {"filter": {"id": {"_eq": conversation_chunk_id}}, 
                "fields": ["source","runpod_request_count"]},
            },
        )
        runpod_request_count = (directus_response[0]["runpod_request_count"])
        source = (directus_response[0]["source"])
        if runpod_request_count < RUNPOD_WHISPER_MAX_REQUEST_THRESHOLD:
            if source == "PORTAL_AUDIO":
                is_priority = True
            else:
                is_priority = False
            job_id = queue_transcribe_audio_runpod(
                chunk["path"], language=language, whisper_prompt=whisper_prompt, is_priority=is_priority
            )
            # Update job_id on directus
            directus.update_item(
                collection_name="conversation_chunk",
                item_id=conversation_chunk_id,
                item_data={
                    "runpod_job_status_link": str(RUNPOD_WHISPER_BASE_URL) + "/status/" + job_id,
                    "runpod_request_count": runpod_request_count + 1,
                },
            )
        else:
            logger.info(f"RunPod request count threshold reached for chunk {conversation_chunk_id}")
            directus.update_item(
                collection_name="conversation_chunk",
                item_id=conversation_chunk_id,
                item_data={
                    "runpod_job_status_link": None,
                },
            )
        return None

    elif ENABLE_LITELLM_WHISPER_TRANSCRIPTION:
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
        raise TranscriptionError("No valid transcription configuration found")


# def transcribe_audio_aiconl(
#     audio_file_path: str,
#     language: Optional[str],  # noqa
#     whisper_prompt: Optional[str],  # noqa
# ) -> str:
#     import requests

#     API_BASE_URL = "https://whisper.ai-hackathon.haven.vng.cloud"
#     API_KEY = "JOUW_VEILIGE_API_SLEUTEL"

#     try:
#         with open(audio_file_path, "rb") as f:
#             headers = {"accept": "application/json", "access_token": API_KEY}
#             files = {"file": f}

#             response = requests.post(f"{API_BASE_URL}/transcribe", headers=headers, files=files)
#             response.raise_for_status()

#             result = response.json()
#             transcription = result.get("text", "")

#             if not transcription:
#                 logger.info("Transcription is empty!")

#             return transcription

#     except FileNotFoundError as exc:
#         logger.error(f"File not found: {audio_file_path}")
#         raise FileNotFoundError from exc
#     except requests.RequestException as exc:
#         logger.error(f"Failed to transcribe audio: {exc}")
#         raise TranscriptionError(f"Failed to transcribe audio: {exc}") from exc
#     except Exception as exc:
#         logger.error(f"Unexpected error: {exc}")
#         raise TranscriptionError(f"Unexpected error: {exc}") from exc
