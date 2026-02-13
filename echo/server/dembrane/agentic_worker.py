from __future__ import annotations

from logging import getLogger
from typing import Optional

from dembrane.agentic_client import (
    AgenticTimeoutError,
    AgenticUpstreamError,
    stream_agent_events,
)
from dembrane.service.agentic import AgenticRunService
from dembrane.service import agentic_run_service

logger = getLogger("dembrane.agentic_worker")


async def process_agentic_run(
    *,
    run_id: str,
    project_id: str,
    user_message: str,
    bearer_token: str,
    run_service: Optional[AgenticRunService] = None,
) -> None:
    svc = run_service or agentic_run_service
    latest_output: str | None = None

    svc.set_status(run_id, "running")

    try:
        async for event in stream_agent_events(
            project_id=project_id,
            user_message=user_message,
            bearer_token=bearer_token,
            thread_id=run_id,
        ):
            event_type = str(event.get("type") or event.get("event") or "agent.event")
            svc.append_event(run_id, event_type, event)

            content = event.get("content")
            if isinstance(content, str):
                latest_output = content

        svc.set_status(run_id, "completed", latest_output=latest_output)
    except AgenticTimeoutError as exc:
        logger.warning("Run %s timed out: %s", run_id, exc)
        svc.append_event(
            run_id,
            "run.timeout",
            {"error_code": "AGENT_TIMEOUT", "message": str(exc)},
        )
        svc.set_status(
            run_id,
            "timeout",
            latest_error=str(exc),
            latest_error_code="AGENT_TIMEOUT",
        )
    except AgenticUpstreamError as exc:
        logger.warning("Run %s failed upstream: %s", run_id, exc)
        svc.append_event(
            run_id,
            "run.failed",
            {
                "error_code": exc.error_code,
                "message": exc.message,
                "status_code": exc.status_code,
            },
        )
        svc.set_status(
            run_id,
            "failed",
            latest_error=exc.message,
            latest_error_code=exc.error_code,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Run %s failed unexpectedly", run_id)
        svc.append_event(
            run_id,
            "run.failed",
            {
                "error_code": "AGENT_UNEXPECTED_ERROR",
                "message": str(exc),
            },
        )
        svc.set_status(
            run_id,
            "failed",
            latest_error=str(exc),
            latest_error_code="AGENT_UNEXPECTED_ERROR",
        )
