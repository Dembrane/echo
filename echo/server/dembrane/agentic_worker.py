from __future__ import annotations

import json
import asyncio
from typing import Any, AsyncGenerator, Optional
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
TOOL_LIMIT_EXEMPT_TOOL_NAMES = {"sendProgressUpdate"}
TOOL_LIMIT_SAFETY_MESSAGE = (
    "I've reached my tool-call limit for this turn. "
    "I'll stop searching here and summarize what I can reliably infer."
)
TOOL_LIMIT_FALLBACK_SUMMARY_MESSAGE = (
    "I reached the tool-call limit before gathering enough additional evidence for a fuller synthesis. "
    "If you want, send `go on` and I'll continue from this exact point."
)
AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL = 4
AUTOMATIC_NUDGE_TEMPLATE = (
    "<Automatic Nudge> You have made {tool_call_count} tool calls without sending an assistant update. "
    "Call `sendProgressUpdate` now with a concise update and next steps, then continue research with "
    "another tool call if evidence is still missing. Only return plain text with no tool call if you "
    "are concluding."
)
PLANNING_MESSAGE_MAX_CHARS = 280
HISTORY_PAGE_SIZE = 500
OVERFLOW_RETRY_WINDOW_SIZE = 24


class AgenticRunCancelledError(Exception):
    pass


def _payload_to_dict(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        try:
            value = json.loads(payload)
        except json.JSONDecodeError:
            return {}
        if isinstance(value, dict):
            return value
    return {}


def _coerce_non_empty_text(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized:
        return None
    return normalized


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


def _extract_tool_call_name(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        direct_name = value.get("name")
        if isinstance(direct_name, str) and direct_name.strip():
            return direct_name.strip()

        nested_function = value.get("function")
        if isinstance(nested_function, dict):
            nested_name = nested_function.get("name")
            if isinstance(nested_name, str) and nested_name.strip():
                return nested_name.strip()
    return None


def _extract_model_text_and_tool_calls(event: dict[str, Any]) -> tuple[Optional[str], set[str]]:
    if str(event.get("type") or event.get("event") or "") != "on_chat_model_end":
        return None, set()

    data = event.get("data")
    if not isinstance(data, dict):
        return None, set()

    output = data.get("output")
    if not isinstance(output, dict):
        return None, set()

    kwargs = output.get("kwargs")
    if not isinstance(kwargs, dict):
        return None, set()

    content = _coerce_text(kwargs.get("content"))
    tool_call_names: set[str] = set()

    tool_calls = kwargs.get("tool_calls")
    if isinstance(tool_calls, list):
        for call in tool_calls:
            tool_name = _extract_tool_call_name(call)
            if tool_name:
                tool_call_names.add(tool_name)

    additional_kwargs = kwargs.get("additional_kwargs")
    if isinstance(additional_kwargs, dict):
        function_call = additional_kwargs.get("function_call")
        function_name = _extract_tool_call_name(function_call)
        if function_name:
            tool_call_names.add(function_name)

        nested_tool_calls = additional_kwargs.get("tool_calls")
        if isinstance(nested_tool_calls, list):
            for call in nested_tool_calls:
                tool_name = _extract_tool_call_name(call)
                if tool_name:
                    tool_call_names.add(tool_name)

    return (content or None), tool_call_names


def _condense_planning_message(content: str) -> str:
    first_paragraph = content.split("\n\n", 1)[0].strip()
    if len(first_paragraph) <= PLANNING_MESSAGE_MAX_CHARS:
        return first_paragraph

    shortened = first_paragraph[: PLANNING_MESSAGE_MAX_CHARS - 3].rstrip()
    if " " in shortened:
        shortened = shortened.rsplit(" ", 1)[0]
    return f"{shortened}..."


def _is_context_overflow_error(exc: AgenticUpstreamError) -> bool:
    if exc.status_code == 413:
        return True

    haystack = f"{exc.error_code} {exc.message}".lower()
    if "prompt too long" in haystack:
        return True
    if "context" in haystack and any(
        marker in haystack for marker in ("length", "window", "limit", "too long", "maximum")
    ):
        return True
    if "token" in haystack and any(
        marker in haystack for marker in ("limit", "maximum", "too many", "context", "length")
    ):
        return True
    if "maximum" in haystack and ("context" in haystack or "token" in haystack):
        return True
    return False


def _build_automatic_nudge_content(*, tool_calls_without_assistant_message: int) -> str:
    milestone = (
        tool_calls_without_assistant_message // AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
    ) * AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
    return AUTOMATIC_NUDGE_TEMPLATE.format(tool_call_count=milestone)


def _build_post_limit_summary(*, last_substantive_assistant_message: Optional[str]) -> str:
    summary_source = _coerce_non_empty_text(last_substantive_assistant_message)
    if summary_source is None:
        return TOOL_LIMIT_FALLBACK_SUMMARY_MESSAGE
    return f"Here is my best synthesis from the evidence gathered so far:\n\n{summary_source}"


def _extract_progress_message_from_tool_end(event: dict[str, Any]) -> Optional[str]:
    if str(event.get("name") or "") != "sendProgressUpdate":
        return None

    data = event.get("data")
    if not isinstance(data, dict):
        return None

    output = data.get("output")
    output_payloads: list[dict[str, Any]] = []
    direct_output_payload = _payload_to_dict(output)
    if direct_output_payload:
        output_payloads.append(direct_output_payload)

        nested_output = _payload_to_dict(direct_output_payload.get("output"))
        if nested_output:
            output_payloads.append(nested_output)

        output_content_payload = _payload_to_dict(direct_output_payload.get("content"))
        if output_content_payload:
            output_payloads.append(output_content_payload)

        kwargs_payload = _payload_to_dict(direct_output_payload.get("kwargs"))
        if kwargs_payload:
            output_payloads.append(kwargs_payload)

            kwargs_content_payload = _payload_to_dict(kwargs_payload.get("content"))
            if kwargs_content_payload:
                output_payloads.append(kwargs_content_payload)

    if not output_payloads:
        return None

    output_payload = next(
        (
            candidate
            for candidate in output_payloads
            if candidate.get("kind") == "progress_update"
            or _coerce_non_empty_text(candidate.get("update")) is not None
        ),
        output_payloads[0],
    )

    visible_to_user = output_payload.get("visible_to_user")
    if visible_to_user is False:
        return None

    update_text = _coerce_non_empty_text(output_payload.get("update"))
    if update_text is None:
        return None

    next_steps = _coerce_non_empty_text(output_payload.get("next_steps"))
    if next_steps is None:
        return update_text
    return f"{update_text}\n\nNext steps: {next_steps}"


async def _build_message_history(
    *,
    svc: AgenticRunService,
    run_id: str,
) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    after_seq = 0

    while True:
        events = await run_in_thread_pool(
            svc.list_events,
            run_id,
            after_seq=after_seq,
            limit=HISTORY_PAGE_SIZE,
        )
        if not events:
            break

        for event in events:
            event_type = str(event.get("event_type") or "")
            if event_type not in {"user.message", "assistant.message"}:
                continue

            payload = _payload_to_dict(event.get("payload"))
            role = "user" if event_type == "user.message" else "assistant"

            if role == "user":
                content = _coerce_non_empty_text(payload.get("agent_prompt_content"))
                if content is None:
                    content = _coerce_non_empty_text(payload.get("content"))
            else:
                content = _coerce_non_empty_text(payload.get("content"))

            if content is None:
                continue
            history.append({"role": role, "content": content})

        try:
            last_seq = int(events[-1].get("seq") or 0)
        except (TypeError, ValueError):
            logger.warning("Failed to parse event sequence while building history for run %s", run_id)
            break

        if last_seq <= after_seq:
            break
        after_seq = last_seq

        if len(events) < HISTORY_PAGE_SIZE:
            break

    return history


async def _stream_with_overflow_retry(
    *,
    project_id: str,
    user_message: str,
    bearer_token: str,
    thread_id: str,
    message_history: list[dict[str, str]],
) -> AsyncGenerator[dict[str, Any], None]:
    attempts: list[list[dict[str, str]]] = [message_history]
    if len(message_history) > OVERFLOW_RETRY_WINDOW_SIZE:
        attempts.append(message_history[-OVERFLOW_RETRY_WINDOW_SIZE:])

    for index, attempt_history in enumerate(attempts):
        emitted_events = False
        try:
            async for event in stream_agent_events(
                project_id=project_id,
                user_message=user_message,
                bearer_token=bearer_token,
                thread_id=thread_id,
                message_history=attempt_history,
            ):
                emitted_events = True
                yield event
            return
        except AgenticUpstreamError as exc:
            should_retry = (
                index == 0
                and len(attempts) > 1
                and not emitted_events
                and _is_context_overflow_error(exc)
            )
            if not should_retry:
                raise

            logger.warning(
                "Run %s overflowed context with %s messages; retrying with last %s messages",
                thread_id,
                len(attempt_history),
                OVERFLOW_RETRY_WINDOW_SIZE,
            )


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
    total_tool_start_count = 0
    counted_tool_start_count = 0
    tool_calls_without_assistant_message = 0
    nudged_tool_call_milestones: set[int] = set()
    has_sent_progress_intro = False
    last_substantive_assistant_message: str | None = None

    logger.info("Processing run %s turn %s (owner=%s)", run_id, turn_seq, owner_token)
    await run_in_thread_pool(svc.set_status, run_id, "running")

    try:
        await _raise_if_cancelled(run_id, turn_seq)
        message_history = await _build_message_history(
            svc=svc,
            run_id=run_id,
        )

        async for event in _stream_with_overflow_retry(
            project_id=project_id,
            user_message=user_message,
            bearer_token=bearer_token,
            thread_id=run_id,
            message_history=message_history,
        ):
            await _raise_if_cancelled(run_id, turn_seq)
            event_type = str(event.get("type") or event.get("event") or "agent.event")

            model_text, model_tool_calls = _extract_model_text_and_tool_calls(event)
            model_has_tool_calls = len(model_tool_calls) > 0
            model_has_progress_tool_call = "sendProgressUpdate" in model_tool_calls
            if model_text:
                if model_has_tool_calls:
                    if model_has_progress_tool_call:
                        has_sent_progress_intro = True
                    else:
                        planning_message = _condense_planning_message(model_text)
                        if planning_message:
                            has_sent_progress_intro = True
                            await _append_assistant_message(
                                svc=svc,
                                run_id=run_id,
                                content=planning_message,
                                project_chat_id=project_chat_id,
                            )
                            last_substantive_assistant_message = planning_message
                            tool_calls_without_assistant_message = 0
                            nudged_tool_call_milestones.clear()
                else:
                    await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=model_text,
                        project_chat_id=project_chat_id,
                    )
                    latest_output = model_text
                    last_substantive_assistant_message = model_text
                    tool_calls_without_assistant_message = 0
                    nudged_tool_call_milestones.clear()

            if event_type == "on_tool_start":
                tool_name = str(event.get("name") or "tool")
                total_tool_start_count += 1
                if tool_name not in TOOL_LIMIT_EXEMPT_TOOL_NAMES:
                    counted_tool_start_count += 1
                tool_calls_without_assistant_message += 1

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
                    tool_calls_without_assistant_message = 0
                    nudged_tool_call_milestones.clear()
                else:
                    nudge_milestone = (
                        tool_calls_without_assistant_message
                        // AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
                    ) * AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
                    should_emit_nudge = (
                        tool_calls_without_assistant_message >= AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
                        and nudge_milestone not in nudged_tool_call_milestones
                    )
                    if should_emit_nudge:
                        nudged_tool_call_milestones.add(nudge_milestone)
                        nudge_content = _build_automatic_nudge_content(
                            tool_calls_without_assistant_message=tool_calls_without_assistant_message
                        )
                        await _append_event_and_publish(
                            svc,
                            run_id,
                            "agent.nudge",
                            {
                                "hidden": True,
                                "origin": "automatic_nudge",
                                "role": "user",
                                "content": nudge_content,
                                "tool_calls_without_assistant_message": tool_calls_without_assistant_message,
                                "total_tool_calls": total_tool_start_count,
                            },
                        )

                if counted_tool_start_count >= MAX_TOOL_CALLS_PER_RUN:
                    await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=TOOL_LIMIT_SAFETY_MESSAGE,
                        project_chat_id=project_chat_id,
                    )
                    post_limit_summary = _build_post_limit_summary(
                        last_substantive_assistant_message=last_substantive_assistant_message
                    )
                    await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=post_limit_summary,
                        project_chat_id=project_chat_id,
                    )
                    latest_output = post_limit_summary
                    tool_calls_without_assistant_message = 0
                    nudged_tool_call_milestones.clear()
                    break

            await _append_event_and_publish(svc, run_id, event_type, event)

            if event_type == "on_tool_end":
                progress_message = _extract_progress_message_from_tool_end(event)
                if progress_message:
                    has_sent_progress_intro = True
                    await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=progress_message,
                        project_chat_id=project_chat_id,
                    )
                    last_substantive_assistant_message = progress_message
                    tool_calls_without_assistant_message = 0
                    nudged_tool_call_milestones.clear()

            content = event.get("content")
            if isinstance(content, str) and event_type == "assistant.message":
                latest_output = content
                last_substantive_assistant_message = content
                tool_calls_without_assistant_message = 0
                nudged_tool_call_milestones.clear()
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
