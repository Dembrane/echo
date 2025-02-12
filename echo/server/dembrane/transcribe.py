import os
import logging
from typing import Optional

from dembrane.openai import client
from dembrane.database import DatabaseSession, ConversationModel, ConversationChunkModel

logger = logging.getLogger("transcribe")


class TranscriptionError(Exception):
    pass


def transcribe_audio(
    audio_file_path: str, language: Optional[str], whisper_prompt: Optional[str]
) -> str:
    return transcribe_audio_openai(audio_file_path, language, whisper_prompt)


def transcribe_audio_aiconl(
    audio_file_path: str, language: Optional[str], whisper_prompt: Optional[str]
) -> str:
    import requests

    API_BASE_URL = "https://whisper.ai-hackathon.haven.vng.cloud"
    API_KEY = "JOUW_VEILIGE_API_SLEUTEL"

    try:
        with open(audio_file_path, "rb") as f:
            headers = {"accept": "application/json", "access_token": API_KEY}
            files = {"file": f}

            response = requests.post(f"{API_BASE_URL}/transcribe", headers=headers, files=files)
            response.raise_for_status()

            result = response.json()
            transcription = result.get("text", "")

            if not transcription:
                logger.info("Transcription is empty!")

            return transcription

    except FileNotFoundError as exc:
        logger.error(f"File not found: {audio_file_path}")
        raise FileNotFoundError from exc
    except requests.RequestException as exc:
        logger.error(f"Failed to transcribe audio: {exc}")
        raise TranscriptionError(f"Failed to transcribe audio: {exc}") from exc
    except Exception as exc:
        logger.error(f"Unexpected error: {exc}")
        raise TranscriptionError(f"Unexpected error: {exc}") from exc


def transcribe_audio_openai(
    audio_file_path: str, language: Optional[str], whisper_prompt: Optional[str]
) -> str:
    try:
        f = open(audio_file_path, "rb")
    except FileNotFoundError as exc:
        logger.error(f"File not found: {audio_file_path}")
        raise FileNotFoundError from exc
    except Exception as exc:
        raise TranscriptionError(f"Failed to open audio file: {exc}") from exc

    with f:
        options = {
            "model": "whisper-1",
            "file": f,
            "response_format": "text",
            "language": language if language not in [None, "multi", ""] else None,
            "prompt": whisper_prompt if whisper_prompt else None,
        }

        try:
            transcription = client.audio.transcriptions.create(**options)  # type: ignore
        except Exception as exc:
            logger.error(f"Failed to transcribe audio: {exc}")
            # TODO: handle audio too short
            raise TranscriptionError(f"Failed to transcribe audio: {exc}") from exc

        if transcription is None or transcription == "":
            # TODO: track if the transcription is empty
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


def transcribe_conversation_chunk(conversation_chunk_id: str) -> None:
    """Process conversation chunk for transcription"""
    with DatabaseSession() as db:
        try:
            chunk = db.get(ConversationChunkModel, conversation_chunk_id)

            if chunk is None:
                return

            if not chunk.path:
                logger.info(f"Chunk {conversation_chunk_id} has no path")
                return

            if not os.path.exists(chunk.path):
                raise FileNotFoundError(f"File not found: {chunk.path}")

            # fetch conversation details
            conversation = (
                db.query(ConversationModel)
                .filter(ConversationModel.id == chunk.conversation_id)
                .first()
            )
            if conversation is None:
                raise ValueError("Conversation not found")

            project = conversation.project
            language = project.language or "en"
            default_prompt = DEFAULT_WHISPER_PROMPTS.get(language, "")
            whisper_prompt = (
                default_prompt
                + " "
                + (
                    project.default_conversation_transcript_prompt
                    if project.default_conversation_transcript_prompt
                    else ""
                )
            )

            transcription = transcribe_audio(
                chunk.path, language=language, whisper_prompt=whisper_prompt
            )

            chunk.transcript = transcription
            db.commit()

            logger.debug(f"Processed chunk: {conversation_chunk_id}")
            return

        except Exception as exc:
            logger.error(f"Unexpected error: {exc}")
            db.rollback()
            raise exc
