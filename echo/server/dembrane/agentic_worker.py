from __future__ import annotations

import json
import asyncio
from typing import Any, Optional
from logging import getLogger

from dembrane.service import chat_service, agentic_run_service
from dembrane.async_helpers import run_in_thread_pool
from dembrane.agentic_client import (
    AgenticTimeoutError,
    AgenticUpstreamError,
    stream_agent_events,
)
from dembrane.agentic_runtime import clear_cancel, publish_live_event, is_cancel_requested
from dembrane.service.agentic import AgenticRunService

logger = getLogger("dembrane.agentic_worker")

AGENT_CANCELLED_ERROR_CODE = "AGENT_CANCELLED"
AGENT_CANCELLED_MESSAGE = "Run cancelled by user"


class AgenticRunCancelledError(Exception):
    pass


async def _append_event_and_publish(
    svc: AgenticRunService,
    run_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    event = await run_in_thread_pool(svc.append_event, run_id, event_type, payload)
    try:
        await publish_live_event(run_id, json.dumps(event, default=str))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to publish live event for run %s: %s", run_id, exc)


async def _raise_if_cancelled(run_id: str, turn_seq: int) -> None:
    if await is_cancel_requested(run_id, turn_seq):
        raise AgenticRunCancelledError(AGENT_CANCELLED_MESSAGE)


async def process_agentic_run(
    *,
    run_id: str,
    project_id: str,
    user_message: str,
    bearer_token: str,
    turn_seq: int,
    owner_token: str,
    run_service: Optional[AgenticRunService] = None,
) -> None:
    svc = run_service or agentic_run_service
    run = await run_in_thread_pool(svc.get_by_id_or_raise, run_id)
    project_chat_id = str(run.get("project_chat_id") or "")
    latest_output: str | None = None

    logger.info("Processing run %s turn %s (owner=%s)", run_id, turn_seq, owner_token)
    await run_in_thread_pool(svc.set_status, run_id, "running")

    try:
        await _raise_if_cancelled(run_id, turn_seq)

        async for event in stream_agent_events(
            project_id=project_id,
            user_message=user_message,
            bearer_token=bearer_token,
            thread_id=run_id,
        ):
            await _raise_if_cancelled(run_id, turn_seq)
            event_type = str(event.get("type") or event.get("event") or "agent.event")
            await _append_event_and_publish(svc, run_id, event_type, event)

            content = event.get("content")
            if isinstance(content, str):
                latest_output = content
                if event_type == "assistant.message" and project_chat_id:
                    try:
                        await run_in_thread_pool(
                            chat_service.create_message,
                            project_chat_id,
                            "assistant",
                            content,
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "Failed to persist agentic assistant message to chat %s: %s",
                            project_chat_id,
                            exc,
                        )

        await _raise_if_cancelled(run_id, turn_seq)
        await run_in_thread_pool(
            svc.set_status,
            run_id,
            "completed",
            latest_output=latest_output,
        )
    except (AgenticRunCancelledError, asyncio.CancelledError):
        logger.info("Run %s cancelled for turn %s", run_id, turn_seq)
        await _append_event_and_publish(
            svc,
            run_id,
            "run.failed",
            {
                "error_code": AGENT_CANCELLED_ERROR_CODE,
                "message": AGENT_CANCELLED_MESSAGE,
            },
        )
        await run_in_thread_pool(
            svc.set_status,
            run_id,
            "failed",
            latest_error=AGENT_CANCELLED_MESSAGE,
            latest_error_code=AGENT_CANCELLED_ERROR_CODE,
        )
    except AgenticTimeoutError as exc:
        logger.warning("Run %s timed out: %s", run_id, exc)
        await _append_event_and_publish(
            svc,
            run_id,
            "run.timeout",
            {"error_code": "AGENT_TIMEOUT", "message": str(exc)},
        )
        await run_in_thread_pool(
            svc.set_status,
            run_id,
            "timeout",
            latest_error=str(exc),
            latest_error_code="AGENT_TIMEOUT",
        )
    except AgenticUpstreamError as exc:
        logger.warning("Run %s failed upstream: %s", run_id, exc)
        await _append_event_and_publish(
            svc,
            run_id,
            "run.failed",
            {
                "error_code": exc.error_code,
                "message": exc.message,
                "status_code": exc.status_code,
            },
        )
        await run_in_thread_pool(
            svc.set_status,
            run_id,
            "failed",
            latest_error=exc.message,
            latest_error_code=exc.error_code,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Run %s failed unexpectedly", run_id)
        await _append_event_and_publish(
            svc,
            run_id,
            "run.failed",
            {
                "error_code": "AGENT_UNEXPECTED_ERROR",
                "message": str(exc),
            },
        )
        await run_in_thread_pool(
            svc.set_status,
            run_id,
            "failed",
            latest_error=str(exc),
            latest_error_code="AGENT_UNEXPECTED_ERROR",
        )
    finally:
        await clear_cancel(run_id, turn_seq)
