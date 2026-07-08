from __future__ import annotations

import re
import json
import asyncio
from uuid import UUID
from typing import Any, Optional, AsyncGenerator
from logging import getLogger

from dembrane.service import chat_service, agentic_run_service
from dembrane.analytics import capture_event
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
MAX_TOOL_CALLS_PER_TURN = 20
MAX_TOOL_CALLS_PER_RUN = MAX_TOOL_CALLS_PER_TURN * 10
TOOL_LIMIT_EXEMPT_TOOL_NAMES = {"sendProgressUpdate"}
# Host-facing, in the agent's own voice. "Tool calls" are an internal concept
# and must never leak into what the host reads.
TOOL_LIMIT_SAFETY_MESSAGE = (
    "I need to pause this pass on your request. Send it again and I'll retry with a fresh pass."
)
RUN_TOOL_LIMIT_SAFETY_MESSAGE = (
    "This chat has accumulated too much work in one live session. Please start a new chat "
    "for the next request."
)
AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL = 4
AUTOMATIC_NUDGE_TEMPLATE = (
    "<Automatic Nudge> You have made {tool_call_count} tool calls without sending an assistant update. "
    "Call `sendProgressUpdate` now with a concise update and next steps, then continue research with "
    "another tool call if evidence is still missing. Only return plain text with no tool call if you "
    "are concluding."
)
HISTORY_PAGE_SIZE = 500
OVERFLOW_RETRY_WINDOW_SIZE = 24

# Internal placeholder the agent injects for Gemini's empty tool-call turns
# (see echo/agent/agent.py `_with_placeholder_content`). It is model-input
# only and must never surface as a host-visible assistant message.
INTERNAL_PLACEHOLDER_CONTENTS = {"(calling tools)"}
TRAILING_CURSOR_ARTIFACT_RE = re.compile(r"([.!?…。！？][\"')\]}»”’]*)(?:[_▁▂▃▔|¦]+)$")
LEADING_STRAY_TOKEN_CLUSTER_RE = re.compile(
    r"^[\s\ufeff\x00-\x1f\u4e00-\u9fff\u3400-\u4dbf]+(?=\s*[\(\[]?[A-Za-z])"
)
SUCCESSFULLY_RE = re.compile(r"\bsuccessfully\s+", re.IGNORECASE)
PARENTHETICAL_PLANNING_RE = re.compile(
    r"^\(\s*(?:i(?:'m| am| will|'ll)|we(?:'re| are| will|'ll)|checking|reading|searching|looking)\b.*\)\s*$",
    re.IGNORECASE | re.DOTALL,
)
STATUS_NARRATION_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")
STATUS_NARRATION_SENTENCE_RE = re.compile(
    r"^\s*(?:"
    r"i\s*(?:am|'m)\s+(?:looking|checking|reviewing|reading|searching)\b.*"
    r"|let\s+me\s+(?:look|check|review|read|search)\b.*"
    # Bare gerund openers count as narration only without a comma clause:
    # "Reviewing the project context." is narration, but "Looking at your
    # transcripts, three themes stand out." is an answer and must survive.
    r"|(?:checking|reviewing|reading|searching|looking)\b[^,]*"
    r"|to\s+help\s+you\b.*\bi\s*(?:will|'ll)\s+"
    r"(?:start|begin|first|now|help|guide|look|check|review|read|search)\b.*"
    r")\s*$",
    re.IGNORECASE | re.DOTALL,
)
OPTION_LINE_RE = re.compile(r"^\s*(?:[-*]|\d+[.)])\s+\S+", re.MULTILINE)


def _is_pure_status_narration(content: str) -> bool:
    if "?" in content or OPTION_LINE_RE.search(content):
        return False
    sentences = [
        chunk.strip() for chunk in STATUS_NARRATION_SPLIT_RE.split(content) if chunk.strip()
    ]
    if not sentences:
        return False
    return all(STATUS_NARRATION_SENTENCE_RE.match(sentence) for sentence in sentences)


def _sanitize_host_visible_assistant_content(content: str) -> Optional[str]:
    """Normalize assistant text before it becomes visible to a host."""
    normalized = content.strip()
    if not normalized or normalized in INTERNAL_PLACEHOLDER_CONTENTS:
        return None
    normalized = LEADING_STRAY_TOKEN_CLUSTER_RE.sub("", normalized).strip()
    removed_successfully = bool(SUCCESSFULLY_RE.match(normalized))
    normalized = SUCCESSFULLY_RE.sub("", normalized).strip()
    if removed_successfully and normalized:
        normalized = normalized[0].upper() + normalized[1:]
    if PARENTHETICAL_PLANNING_RE.match(normalized):
        return None
    if _is_pure_status_narration(normalized):
        return None
    previous = None
    while previous != normalized:
        previous = normalized
        normalized = TRAILING_CURSOR_ARTIFACT_RE.sub(r"\1", normalized).strip()
    return normalized or None


def _summarize_request_for_safety_message(user_message: str) -> str:
    normalized = " ".join(user_message.split())
    if len(normalized) > 140:
        return f"{normalized[:137].rstrip()}..."
    return normalized


def _build_turn_tool_limit_message(user_message: str) -> str:
    request_summary = _summarize_request_for_safety_message(user_message)
    if not request_summary:
        return TOOL_LIMIT_SAFETY_MESSAGE
    return (
        f"I need to pause this pass on your request: \"{request_summary}\". "
        "Send it again and I'll retry with a fresh pass."
    )


def _is_host_visible_assistant_content(content: str) -> bool:
    """A turn is worth showing the host only if it carries real text — not an
    empty string and not an internal placeholder token."""
    return _sanitize_host_visible_assistant_content(content) is not None


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


def _is_transient_upstream_error(exc: AgenticUpstreamError) -> bool:
    if exc.error_code == "AGENT_UPSTREAM_TRANSPORT":
        return True

    if exc.status_code in {502, 503, 504}:
        return True

    haystack = f"{exc.error_code} {exc.message}".lower()
    transient_markers = (
        "incomplete chunked read",
        "peer closed connection",
        "connection reset",
        "connection closed",
        "broken pipe",
    )
    return any(marker in haystack for marker in transient_markers)


def _build_automatic_nudge_content(*, tool_calls_without_assistant_message: int) -> str:
    milestone = (
        tool_calls_without_assistant_message // AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
    ) * AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
    return AUTOMATIC_NUDGE_TEMPLATE.format(tool_call_count=milestone)


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
    # Render next steps as their own paragraph; no English "Next steps:" label
    # (the agent writes in the host's language).
    return f"{update_text}\n\n{next_steps}"


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
                if content is not None:
                    content = _sanitize_host_visible_assistant_content(content)

            if content is None:
                continue
            history.append({"role": role, "content": content})

        try:
            last_seq = int(events[-1].get("seq") or 0)
        except (TypeError, ValueError):
            logger.warning(
                "Failed to parse event sequence while building history for run %s", run_id
            )
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
    chat_id: str | None = None,
    app_user_id: str | None = None,
    message_id: str | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    attempts: list[list[dict[str, str]]] = [message_history]
    if len(message_history) > OVERFLOW_RETRY_WINDOW_SIZE:
        attempts.append(message_history[-OVERFLOW_RETRY_WINDOW_SIZE:])

    for index, attempt_history in enumerate(attempts):
        transient_retries_remaining = 1

        while True:
            emitted_events = False
            try:
                async for event in stream_agent_events(
                    project_id=project_id,
                    user_message=user_message,
                    bearer_token=bearer_token,
                    thread_id=thread_id,
                    message_history=attempt_history,
                    chat_id=chat_id,
                    app_user_id=app_user_id,
                    message_id=message_id,
                ):
                    emitted_events = True
                    yield event
                return
            except AgenticUpstreamError as exc:
                should_retry_transient = (
                    transient_retries_remaining > 0
                    and not emitted_events
                    and _is_transient_upstream_error(exc)
                )
                if should_retry_transient:
                    transient_retries_remaining -= 1
                    logger.warning(
                        "Run %s hit transient upstream error (%s); retrying stream once",
                        thread_id,
                        exc.error_code,
                    )
                    continue

                should_retry_overflow = (
                    index == 0
                    and len(attempts) > 1
                    and not emitted_events
                    and _is_context_overflow_error(exc)
                )
                if should_retry_overflow:
                    logger.warning(
                        "Run %s overflowed context with %s messages; retrying with last %s messages",
                        thread_id,
                        len(attempt_history),
                        OVERFLOW_RETRY_WINDOW_SIZE,
                    )
                    break

                raise


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
) -> Optional[str]:
    # Never emit or persist internal placeholders / empty turns as host-facing
    # messages — they only fragment the chat and leak the Gemini crutch text.
    sanitized_content = _sanitize_host_visible_assistant_content(content)
    if sanitized_content is None:
        return None
    await _append_event_and_publish(
        svc,
        run_id,
        "assistant.message",
        {"content": sanitized_content},
    )
    if not project_chat_id:
        return sanitized_content
    try:
        await run_in_thread_pool(
            chat_service.create_message,
            project_chat_id,
            "assistant",
            sanitized_content,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Failed to persist agentic assistant message to chat %s: %s",
            project_chat_id,
            exc,
        )
    return sanitized_content


async def _chat_distinct_id(run: dict, run_id: str) -> str:
    """Resolve a PostHog distinct_id (the chat user's email) so server chat
    events merge with the user's frontend person. Falls back to the directus
    user id, then the run id. Best-effort."""
    directus_user_id = str(run.get("directus_user_id") or "")
    if not directus_user_id:
        return run_id
    try:
        from dembrane.app_user import resolve_app_user

        app_user = await resolve_app_user(directus_user_id)
        return ((app_user or {}).get("email") or "").lower() or directus_user_id
    except Exception:  # noqa: BLE001 — analytics is best-effort
        return directus_user_id


async def _resolve_run_app_user_id(run: dict) -> str | None:
    directus_user_id = str(run.get("directus_user_id") or "")
    if not directus_user_id:
        return None
    try:
        UUID(directus_user_id)
    except ValueError:
        return None
    try:
        from dembrane.app_user import get_app_user_or_raise

        app_user = await get_app_user_or_raise(directus_user_id)
        return str(app_user.get("id") or "") or None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to resolve app_user for run user %s: %s", directus_user_id, exc)
        return None


async def _triggering_message_id(
    *,
    svc: AgenticRunService,
    run_id: str,
    turn_seq: int,
) -> str | None:
    if turn_seq <= 0:
        return None
    events = await run_in_thread_pool(
        svc.list_events,
        run_id,
        after_seq=turn_seq - 1,
        limit=1,
    )
    if not events:
        return None
    event = events[0]
    if event.get("event_type") != "user.message":
        return None
    return str(event.get("id") or "") or None


async def _latest_user_turn_seq(*, svc: AgenticRunService, run_id: str) -> int | None:
    event = await run_in_thread_pool(
        svc.get_latest_event,
        run_id,
        event_type="user.message",
    )
    if event is None:
        return None
    try:
        seq = int(event.get("seq") or 0)
    except (TypeError, ValueError):
        return None
    return seq if seq > 0 else None


async def _count_persisted_non_exempt_tool_starts(
    *, svc: AgenticRunService, run_id: str
) -> int:
    total = 0
    after_seq = 0
    while True:
        events = await run_in_thread_pool(
            svc.list_events,
            run_id,
            after_seq=after_seq,
            limit=HISTORY_PAGE_SIZE,
        )
        if not events:
            return total
        for event in events:
            after_seq = max(after_seq, int(event.get("seq") or 0))
            if event.get("event_type") != "on_tool_start":
                continue
            payload = _payload_to_dict(event.get("payload"))
            tool_name = str(payload.get("name") or "tool")
            if tool_name not in TOOL_LIMIT_EXEMPT_TOOL_NAMES:
                total += 1
        if len(events) < HISTORY_PAGE_SIZE:
            return total


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
    chat_distinct_id = await _chat_distinct_id(run, run_id)
    app_user_id = await _resolve_run_app_user_id(run)
    message_id = await _triggering_message_id(
        svc=svc,
        run_id=run_id,
        turn_seq=turn_seq,
    )

    async def _emit_chat_error(error_code: str, message: str) -> None:
        await capture_event(
            chat_distinct_id,
            "server_chat_error",
            {
                "run_id": run_id,
                "project_id": project_id,
                "error_code": error_code,
                "message": message[:300],
                "mode": "agentic",
            },
        )

    latest_output: str | None = None
    total_tool_start_count = 0
    counted_tool_start_count = 0
    persisted_non_exempt_tool_starts = await _count_persisted_non_exempt_tool_starts(
        svc=svc,
        run_id=run_id,
    )
    tool_calls_without_assistant_message = 0
    nudged_tool_call_milestones: set[int] = set()
    has_sent_progress_intro = False

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
            chat_id=project_chat_id or None,
            app_user_id=app_user_id,
            message_id=message_id,
        ):
            await _raise_if_cancelled(run_id, turn_seq)
            event_type = str(event.get("type") or event.get("event") or "agent.event")

            model_text, model_tool_calls = _extract_model_text_and_tool_calls(event)
            model_has_tool_calls = len(model_tool_calls) > 0
            model_has_progress_tool_call = "sendProgressUpdate" in model_tool_calls
            if model_text:
                if model_has_tool_calls:
                    # The model's pre-tool "planning" prose used to be persisted
                    # as its own bubble, which fragmented the aggregated activity
                    # strip (and, with the placeholder crutch, spammed the thread
                    # with "(calling tools)"). Suppress it: the host sees the
                    # aggregated tool activity plus the final summary. We do NOT
                    # reset the nudge counter here, so visible-progress nudges
                    # (sendProgressUpdate) still fire on long runs.
                    if model_has_progress_tool_call:
                        has_sent_progress_intro = True
                else:
                    persisted_content = await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=model_text,
                        project_chat_id=project_chat_id,
                    )
                    if persisted_content is not None:
                        latest_output = persisted_content
                        tool_calls_without_assistant_message = 0
                        nudged_tool_call_milestones.clear()

            if event_type == "on_tool_start":
                tool_name = str(event.get("name") or "tool")
                total_tool_start_count += 1
                if tool_name not in TOOL_LIMIT_EXEMPT_TOOL_NAMES:
                    counted_tool_start_count += 1
                tool_calls_without_assistant_message += 1

                if not has_sent_progress_intro:
                    # Don't post a synthetic "starting with `toolName`" line: it
                    # leaks raw tool names, is English-only, and the frontend
                    # already renders humane tool activity. The agent's own
                    # sendProgressUpdate covers user-facing progress.
                    has_sent_progress_intro = True
                    tool_calls_without_assistant_message = 0
                    nudged_tool_call_milestones.clear()
                else:
                    nudge_milestone = (
                        tool_calls_without_assistant_message // AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
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

                if persisted_non_exempt_tool_starts + counted_tool_start_count >= MAX_TOOL_CALLS_PER_RUN:
                    persisted_content = await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=RUN_TOOL_LIMIT_SAFETY_MESSAGE,
                        project_chat_id=project_chat_id,
                    )
                    latest_output = persisted_content
                    tool_calls_without_assistant_message = 0
                    nudged_tool_call_milestones.clear()
                    break

                if counted_tool_start_count >= MAX_TOOL_CALLS_PER_TURN:
                    persisted_content = await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=_build_turn_tool_limit_message(user_message),
                        project_chat_id=project_chat_id,
                    )
                    # One honest message only. The last substantive assistant
                    # message is already in the chat; don't repeat it verbatim.
                    latest_output = persisted_content
                    tool_calls_without_assistant_message = 0
                    nudged_tool_call_milestones.clear()
                    break

            content = event.get("content")
            if event_type == "assistant.message" and isinstance(content, str):
                sanitized_content = _sanitize_host_visible_assistant_content(content)
                if sanitized_content is None:
                    continue
                event = {**event, "content": sanitized_content}
                content = sanitized_content

            await _append_event_and_publish(svc, run_id, event_type, event)

            if event_type == "on_tool_end":
                progress_message = _extract_progress_message_from_tool_end(event)
                if progress_message:
                    has_sent_progress_intro = True
                    persisted_content = await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=progress_message,
                        project_chat_id=project_chat_id,
                    )
                    if persisted_content is not None:
                        tool_calls_without_assistant_message = 0
                        nudged_tool_call_milestones.clear()

            if isinstance(content, str) and event_type == "assistant.message":
                latest_output = content
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
        latest_user_seq = await _latest_user_turn_seq(svc=svc, run_id=run_id)
        if latest_user_seq and latest_user_seq > turn_seq:
            await run_in_thread_pool(
                svc.set_status,
                run_id,
                "queued",
                latest_output=latest_output,
            )
        else:
            await run_in_thread_pool(
                svc.set_status,
                run_id,
                "completed",
                latest_output=latest_output,
            )
        await capture_event(
            chat_distinct_id,
            "server_chat_response_received",
            {
                "run_id": run_id,
                "project_id": project_id,
                "has_output": latest_output is not None,
                "mode": "agentic",
            },
        )
    except (AgenticRunCancelledError, asyncio.CancelledError):
        logger.info("Run %s cancelled for turn %s", run_id, turn_seq)
        await _emit_chat_error(AGENT_CANCELLED_ERROR_CODE, AGENT_CANCELLED_MESSAGE)
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
        await _emit_chat_error("AGENT_TIMEOUT", str(exc))
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
        await _emit_chat_error(exc.error_code, exc.message)
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
        await _emit_chat_error("AGENT_UNEXPECTED_ERROR", str(exc))
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
