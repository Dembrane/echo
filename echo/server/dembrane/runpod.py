from logging import getLogger

import backoff
import requests

from dembrane.tasks import task_finish_conversation_hook
from dembrane.config import RUNPOD_WHISPER_API_KEY
from dembrane.service import conversation_service
from dembrane.service.conversation import ConversationChunkNotFoundException
from dembrane.processing_status_utils import ProcessingStatusContext, set_error_status

logger = getLogger("dembrane.runpod")


@backoff.on_exception(
    backoff.expo,
    requests.exceptions.RequestException,
    max_tries=3,
    max_time=30,
)
def get_runpod_transcription_response(status_link: str) -> dict:
    headers = {
        "Authorization": f"Bearer {RUNPOD_WHISPER_API_KEY}",
        "Content-Type": "application/json",
    }
    response = requests.get(status_link, headers=headers)

    if response.status_code == 200:
        return response.json()

    raise requests.exceptions.RequestException(
        f"Non-200 response for status link {status_link}: {response.status_code}"
    )


def load_runpod_transcription_response(payload: dict) -> None:
    logger.debug("=== ENTERING load_runpod_transcription_response ===")
    logger.debug(f"Loading runpod transcription response: {payload}")

    # Validate payload structure
    if not isinstance(payload, dict):
        logger.error(f"Invalid payload type - expected dict, got {type(payload)}: {payload}")
        return

    if "output" not in payload:
        logger.error(f"Invalid payload structure - missing 'output' key: {payload}")
        return

    output = payload["output"]

    # Handle case where output might be a list instead of dict
    if isinstance(output, list):
        logger.error(
            f"Unexpected payload structure - 'output' is a list instead of dict. This might be an error response: {payload}"
        )
        # Try to extract error information from the list if possible
        if output and isinstance(output[0], dict) and "error" in output[0]:
            error_msg = output[0].get("error", "Unknown error from RunPod")
            logger.error(f"RunPod returned error in list format: {error_msg}")
        return

    if not isinstance(output, dict):
        logger.error(
            f"Unexpected payload structure - 'output' is not a dict: {type(output)}, payload: {payload}"
        )
        return

    # Check if this is an error response
    if "error" in output and output.get("error"):
        logger.error(f"RunPod returned error in output: {output.get('error')}")
        # Try to get conversation_chunk_id to set error status
        conversation_chunk_id = output.get("conversation_chunk_id")
        if conversation_chunk_id:
            set_error_status(
                conversation_chunk_id=conversation_chunk_id,
                error=f"RunPod error: {output.get('error')}",
            )
        return

    # Extract conversation_chunk_id with proper error handling
    conversation_chunk_id = output.get("conversation_chunk_id")
    if not conversation_chunk_id:
        logger.error(f"Missing conversation_chunk_id in payload output: {payload}")
        return

    logger.debug(f"Found conversation_chunk_id: {conversation_chunk_id}")
    # Check if status indicates failure
    status = payload.get("status")
    logger.debug(f"Status: {status}")
    if status == "FAILED":
        logger.error(f"RunPod job failed for chunk {conversation_chunk_id}: {payload}")
        set_error_status(
            conversation_chunk_id=conversation_chunk_id,
            error=f"RunPod job failed: {output.get('error', 'Unknown error')}",
        )
        return

    # Only proceed if status is COMPLETED
    if status != "COMPLETED":
        logger.warning(
            f"RunPod job not completed for chunk {conversation_chunk_id}, status: {status}"
        )
        return

    try:
        chunk = conversation_service.get_chunk_by_id_or_raise(conversation_chunk_id)

    # exit early
    except (ConversationChunkNotFoundException, KeyError) as e:
        logger.error(f"Chunk {conversation_chunk_id} not found, skipping - {str(e)}")
        return

    # retry if we failed to fetch the chunk
    except Exception as e:
        set_error_status(
            conversation_chunk_id=conversation_chunk_id,
            error=f"Failed to fetch conversation chunk: {e}",
        )
        raise e from e

    conversation_id = chunk["conversation_id"]

    with ProcessingStatusContext(
        conversation_chunk_id=chunk["id"],
        conversation_id=conversation_id,
        event_prefix="load_runpod_transcription_response",
    ):
        """
        Example payload:
        {
            "metadata_str": "optional string",
            "enable_timestamps": true,
            "language": "nl",
            "detected_language": "nl",
            "detected_language_confidence": 0.9805044531822205,
            "joined_text": "... full transcription ...",
            "translation_text": "...full translation...",
            "translation_error": false,
            "hallucination_score": 0.2,
            "hallucination_reason": "Minor repetitions detected",
            "segments": [
                {
                    "text": "Segment text",
                    "start": 0.0,
                    "end": 2.5
                }
            ]
        }
        """

        # Now we know output is a dict, so we can safely access its properties
        hallucination_reason = output.get("hallucination_reason", None)
        hallucination_score = output.get("hallucination_score", None)
        translation_error = output.get("translation_error", False)

        if translation_error and hallucination_score is None:
            hallucination_score = 0.5
            hallucination_reason = "There seems to be an internal model error with translation."

        joined_text = output.get("joined_text", "")
        translation_text = output.get("translation_text")

        # transcript should always be there - use translation_text if available, otherwise joined_text
        transcript = translation_text if translation_text else joined_text
        logger.debug(f"Transcript: {len(transcript) if transcript else 0}")

        # raw_transcript is null if translation_text is null or if they are the same
        if translation_text is None or translation_text == joined_text:
            raw_transcript = None
            logger.debug("Setting raw_transcript to None (no translation or same as original)")
        else:
            raw_transcript = joined_text
            logger.debug(f"Raw transcript: {len(raw_transcript)}")

        desired_language = output.get("language")
        detected_language = output.get("detected_language")
        detected_language_confidence = output.get("detected_language_confidence")

        error = output.get("error", None)
        if not transcript:
            error = error or ""
            error += "No transcript"

        logger.debug("Updating chunk in database...")
        conversation_service.update_chunk(
            chunk_id=chunk["id"],
            raw_transcript=raw_transcript,
            transcript=transcript,
            runpod_job_status_link=None,
            hallucination_reason=hallucination_reason,
            hallucination_score=hallucination_score,
            error=error,
            desired_language=desired_language,
            detected_language=detected_language,
            detected_language_confidence=detected_language_confidence,
        )

        counts = conversation_service.get_chunk_counts(conversation_id)
        logger.debug(counts)

        # Trigger follow-up processing only when either:
        #   a) the participant signalled they are done (conversation.is_finished == True), _and_
        #   b) we have processed all currently known chunks.
        # This prevents finishing the conversation too early when the participant is still uploading.
        if counts["processed"] == counts["total"]:
            try:
                conversation = conversation_service.get_by_id_or_raise(conversation_id)
                is_finished = conversation.get("is_finished", False)
                if is_finished:
                    logger.info(
                        f"All chunks processed _and_ conversation {conversation_id} marked finished; running follow-up tasks."
                    )
                    task_finish_conversation_hook.send(conversation_id)
                else:
                    logger.debug(
                        f"All currently known chunks processed for conversation {conversation_id}, but it is not marked finished yet. Skipping finish hook for now."
                    )
            except Exception as e:
                logger.error(
                    f"Could not verify conversation status for {conversation_id}: {e} – skipping finish hook for now"
                )

        logger.debug(
            f"Updated chunk with transcript: {chunk['id']} - length: {len(output.get('joined_text', ''))}"
        )
