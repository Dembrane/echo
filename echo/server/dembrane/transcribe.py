import logging
from typing import Optional

from dembrane.s3 import get_stream_from_s3, get_sanitized_s3_key
from dembrane.openai import client
from dembrane.directus import directus

logger = logging.getLogger("transcribe")


class TranscriptionError(Exception):
    pass


def transcribe_audio(
    audio_file_path: str, language: Optional[str], whisper_prompt: Optional[str]
) -> str:
    return transcribe_audio_openai(audio_file_path, language, whisper_prompt)


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


def transcribe_audio_openai(
    audio_file_uri: str, language: Optional[str], whisper_prompt: Optional[str]
) -> str:
    try:
        audio_stream = get_stream_from_s3(audio_file_uri)
    except Exception as exc:
        logger.error(f"Failed to get audio stream from S3 for {audio_file_uri}: {exc}")
        raise TranscriptionError(f"Failed to get audio stream from S3: {exc}") from exc

    with audio_stream as f:
        options = {
            "model": "whisper-1",
            "file": (get_sanitized_s3_key(audio_file_uri), f.read()),
            "response_format": "text",
            "language": language if language not in [None, "multi", ""] else None,
            "prompt": whisper_prompt if whisper_prompt else None,
        }

        try:
            transcription = client.audio.transcriptions.create(**options)  # type: ignore
        except Exception as exc:
            logger.error(f"Failed to transcribe audio: {exc}")
            raise TranscriptionError(f"Failed to transcribe audio: {exc}") from exc

        if transcription is None or transcription == "":
            logger.info("Transcription is empty!")

    return str(transcription)


# def transcribe_audio_azure_whisper(
#     audio_file_path: str, language: Optional[str], whisper_prompt: Optional[str]
# ) -> str:
#     base_url = "https://whisper-asr-service.westeurope.azurecontainer.io/v1"
#     endpoint = f"{base_url}/asr"

#     try:
#         with open(audio_file_path, "rb") as audio_file:
#             files = {"audio_file": audio_file}
#             params = {
#                 "output": "json",
#                 "task": "transcribe",
#                 "language": language if language not in [None, "multi", ""] else None,
#                 "word_timestamps": "false",
#                 "encode": "true",
#             }

#             response = requests.post(endpoint, files=files, data=params)
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


DEFAULT_WHISPER_PROMPTS = {
    "en": "Hi, lets get started. First we'll have a round of introductions and then we can get into the topic for today.",
    "nl": "Hallo, laten we beginnen. Eerst even een introductieronde en dan kunnen we aan de slag met de thema van vandaag.",
    "de": "Hallo, lasst uns beginnen. Zuerst ein paar Einführungen und dann können wir mit dem Thema des Tages beginnen.",
    "fr": "Bonjour, commençons. D'abord un tour de table et ensuite nous pourrons aborder le sujet du jour.",
    "es": "Hola, comencemos. Primero, un round de introducción y luego podremos empezar con el tema de hoy.",
}


def transcribe_conversation_chunk(conversation_chunk_id: str) -> str:
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
    previous_chunk = directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {
                    "conversation_id": {"_eq": chunk["conversation_id"]},
                    "timestamp": {"_lt": chunk["timestamp"]},
                },
                "fields": ["transcript"],
                "limit": 1,
            },
        },
    )

    previous_chunk_transcript = ""

    if previous_chunk and len(previous_chunk) > 0:
        previous_chunk_transcript = previous_chunk[0]["transcript"]

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

    default_prompt = DEFAULT_WHISPER_PROMPTS.get(language, "")

    whisper_prompt = (
        default_prompt
        + " "
        + (
            conversation["project_id"]["default_conversation_transcript_prompt"] + "."
            if conversation["project_id"]["default_conversation_transcript_prompt"]
            else ""
        )
        + " "
        + previous_chunk_transcript
    )

    logger.debug(f"whisper_prompt: {whisper_prompt}")

    transcription = transcribe_audio(
        chunk["path"], language=language, whisper_prompt=whisper_prompt
    )
    logger.debug(f"transcription: {transcription}")

    directus.update_item(
        "conversation_chunk",
        conversation_chunk_id,
        {
            "transcript": transcription,
        },
    )

    logger.info(f"Processed chunk for transcription: {conversation_chunk_id}")
    return conversation_chunk_id


if __name__ == "__main__":
    transcribe_conversation_chunk("12e47a43-7c2d-4264-b58f-bff87516fb03")
