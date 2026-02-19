"""
Incoming webhook endpoints for third-party service callbacks.

These endpoints are public and authenticated via shared secrets.
"""

import hmac
from logging import getLogger

from fastapi import Request, APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.settings import get_settings

logger = getLogger("api.webhooks")

WebhooksRouter = APIRouter(tags=["webhooks"])


class AssemblyAIWebhookPayload(BaseModel):
    transcript_id: str
    status: str


@WebhooksRouter.post("/webhooks/assemblyai")
async def assemblyai_webhook_callback(
    payload: AssemblyAIWebhookPayload,
    request: Request,
) -> dict[str, str]:
    """Handle AssemblyAI transcript completion callbacks."""
    settings = get_settings()
    expected_secret = settings.transcription.assemblyai_webhook_secret
    if not expected_secret:
        raise HTTPException(status_code=503, detail="AssemblyAI webhook secret is not configured")

    received_secret = request.headers.get("X-AssemblyAI-Webhook-Secret", "")
    if not hmac.compare_digest(received_secret, expected_secret):
        logger.warning("AssemblyAI webhook auth failed for transcript %s", payload.transcript_id)
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    logger.info(
        "AssemblyAI webhook received (transcript_id=%s status=%s)",
        payload.transcript_id,
        payload.status,
    )

    from dembrane.coordination import (
        get_assemblyai_webhook_metadata,
        delete_assemblyai_webhook_metadata,
        mark_assemblyai_webhook_processing,
        clear_assemblyai_webhook_processing,
    )

    metadata = get_assemblyai_webhook_metadata(payload.transcript_id)
    if not metadata:
        logger.warning(
            "AssemblyAI webhook ignored: metadata missing for transcript %s",
            payload.transcript_id,
        )
        return {"status": "ignored"}

    if not mark_assemblyai_webhook_processing(payload.transcript_id):
        logger.info(
            "AssemblyAI webhook duplicate/in-flight ignored for transcript %s",
            payload.transcript_id,
        )
        return {"status": "ignored"}

    try:
        chunk_id = metadata["chunk_id"]
        conversation_id = metadata["conversation_id"]
        normalized_status = payload.status.lower()

        if normalized_status == "error":
            from dembrane.tasks import _on_chunk_transcription_done
            from dembrane.transcribe import _save_chunk_error, fetch_assemblyai_result

            error_detail = f"AssemblyAI error for transcript {payload.transcript_id}"
            try:
                fetch_assemblyai_result(payload.transcript_id)
            except Exception as fetch_exc:
                error_detail = str(fetch_exc)

            _save_chunk_error(chunk_id, error_detail)
            _on_chunk_transcription_done(conversation_id, chunk_id, logger)
            delete_assemblyai_webhook_metadata(payload.transcript_id)
            return {"status": "error_handled"}

        if normalized_status == "completed":
            from dembrane.tasks import task_correct_transcript
            from dembrane.transcribe import _save_transcript, fetch_assemblyai_result

            transcript_text, full_response = fetch_assemblyai_result(payload.transcript_id)
            anonymize_transcripts = bool(metadata.get("anonymize_transcripts", False))

            if not anonymize_transcripts:
                _save_transcript(
                    chunk_id,
                    transcript_text,
                    diarization={
                        "schema": "Dembrane-25-09-assemblyai-partial",
                        "data": full_response,
                    },
                )

            task_correct_transcript.send(
                chunk_id=chunk_id,
                conversation_id=conversation_id,
                audio_file_uri=metadata["audio_file_uri"],
                candidate_transcript=transcript_text,
                hotwords=metadata.get("hotwords"),
                use_pii_redaction=bool(metadata.get("use_pii_redaction", False)),
                custom_guidance_prompt=metadata.get("custom_guidance_prompt"),
                assemblyai_response=full_response,
                anonymize_transcripts=anonymize_transcripts,
            )

            delete_assemblyai_webhook_metadata(payload.transcript_id)
            return {"status": "ok"}

        logger.warning(
            "AssemblyAI webhook ignored unknown status %s for transcript %s",
            payload.status,
            payload.transcript_id,
        )
        return {"status": "ignored"}
    finally:
        clear_assemblyai_webhook_processing(payload.transcript_id)
