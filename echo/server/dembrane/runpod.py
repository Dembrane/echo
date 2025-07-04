from logging import getLogger

from dembrane.tasks import task_finish_conversation_hook
from dembrane.service import conversation_service
from dembrane.processing_status_utils import ProcessingStatusContext

logger = getLogger("dembrane.runpod")


def load_runpod_transcription_response(payload: dict) -> None:
    try:
        chunk = conversation_service.get_chunk_by_id_or_raise(
            payload["output"]["conversation_chunk_id"]
        )

        conversation_id = chunk["conversation_id"]

        with ProcessingStatusContext(
            conversation_chunk_id=chunk["id"],
            conversation_id=conversation_id,
            event_prefix="load_runpod_transcription_response",
        ):
            conversation_service.update_chunk(
                chunk_id=chunk["id"],
                transcript=payload["output"]["joined_text"],
                runpod_job_status_link=None,
            )

            counts = conversation_service.get_chunk_counts(conversation_id)
            logger.debug(counts)

            if counts["processed"] == counts["total"]:
                logger.info(f"got all the chunks for conversation {conversation_id}")
                task_finish_conversation_hook.send(conversation_id)

            logger.info(
                f"updated chunk with transcript: {chunk['id']} - length: {len(payload['output']['joined_text'])}"
            )

    except Exception as e:
        logger.exception("Failed to update conversation chunk")
        raise e from e
