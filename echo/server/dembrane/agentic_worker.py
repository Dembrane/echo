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
MAX_TOOL_CALLS_PER_RUN = 12
PLANNING_MESSAGE_MAX_CHARS = 280


class AgenticRunCancelledError(Exception):
    pass


def _coerce_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()

    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                if item.strip():
                    parts.append(item.strip())
                continue
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        return "\n".join(parts).strip()

    return ""


def _extract_model_text_and_tool_flag(event: dict[str, Any]) -> tuple[Optional[str], bool]:
    if str(event.get("type") or event.get("event") or "") != "on_chat_model_end":
        return None, False

    data = event.get("data")
    if not isinstance(data, dict):
        return None, False

    output = data.get("output")
    if not isinstance(output, dict):
        return None, False

    kwargs = output.get("kwargs")
    if not isinstance(kwargs, dict):
        return None, False

    content = _coerce_text(kwargs.get("content"))
    has_tool_calls = False

    tool_calls = kwargs.get("tool_calls")
    if isinstance(tool_calls, list) and len(tool_calls) > 0:
        has_tool_calls = True

    additional_kwargs = kwargs.get("additional_kwargs")
    if isinstance(additional_kwargs, dict):
        if additional_kwargs.get("function_call"):
            has_tool_calls = True
        nested_tool_calls = additional_kwargs.get("tool_calls")
        if isinstance(nested_tool_calls, list) and len(nested_tool_calls) > 0:
            has_tool_calls = True

    return (content or None), has_tool_calls


def _condense_planning_message(content: str) -> str:
    first_paragraph = content.split("\n\n", 1)[0].strip()
    if len(first_paragraph) <= PLANNING_MESSAGE_MAX_CHARS:
        return first_paragraph

    shortened = first_paragraph[: PLANNING_MESSAGE_MAX_CHARS - 3].rstrip()
    if " " in shortened:
        shortened = shortened.rsplit(" ", 1)[0]
    return f"{shortened}..."


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


async def _append_assistant_message(
    *,
    svc: AgenticRunService,
    run_id: str,
    content: str,
    project_chat_id: str,
) -> None:
    await _append_event_and_publish(
        svc,
        run_id,
        "assistant.message",
        {"content": content},
    )
    if not project_chat_id:
        return
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
    tool_start_count = 0
    has_sent_progress_intro = False
    has_sent_progress_midpoint = False

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

            model_text, model_has_tool_calls = _extract_model_text_and_tool_flag(event)
            if model_text:
                if model_has_tool_calls:
                    if not has_sent_progress_intro:
                        has_sent_progress_intro = True
                        intro_message = _condense_planning_message(model_text)
                        if intro_message:
                            await _append_assistant_message(
                                svc=svc,
                                run_id=run_id,
                                content=intro_message,
                                project_chat_id=project_chat_id,
                            )
                else:
                    await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=model_text,
                        project_chat_id=project_chat_id,
                    )
                    latest_output = model_text

            if event_type == "on_tool_start":
                tool_start_count += 1
                tool_name = str(event.get("name") or "tool")

                if not has_sent_progress_intro:
                    has_sent_progress_intro = True
                    progress_message = (
                        f"I'll first gather evidence before answering. "
                        f"Starting with `{tool_name}`."
                    )
                    await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=progress_message,
                        project_chat_id=project_chat_id,
                    )

                elif tool_start_count >= 4 and not has_sent_progress_midpoint:
                    has_sent_progress_midpoint = True
                    progress_message = (
                        "I have a rough picture now. "
                        "I'll run a couple more checks, then summarize clearly."
                    )
                    await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=progress_message,
                        project_chat_id=project_chat_id,
                    )

                if tool_start_count >= MAX_TOOL_CALLS_PER_RUN:
                    safety_message = (
                        "I've reached my tool-call limit for this turn. "
                        "I’ll stop searching here and summarize what I can reliably infer."
                    )
                    await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=safety_message,
                        project_chat_id=project_chat_id,
                    )
                    latest_output = safety_message
                    break

            await _append_event_and_publish(svc, run_id, event_type, event)

            content = event.get("content")
            if isinstance(content, str) and event_type == "assistant.message":
                latest_output = content
                if project_chat_id:
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
