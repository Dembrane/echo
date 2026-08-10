from __future__ import annotations

import re
import json
import time
import asyncio
from uuid import UUID
from typing import Any, Optional, AsyncGenerator
from logging import getLogger

from dembrane.service import chat_service, agentic_run_service
from dembrane.analytics import capture_event
from dembrane.agentic_focus import strip_focus_blocks
from dembrane.async_helpers import run_in_thread_pool
from dembrane.agentic_client import (
    AgenticTimeoutError,
    AgenticUpstreamError,
    stream_agent_events,
)
from dembrane.agentic_runtime import clear_cancel, publish_live_event, is_cancel_requested
from dembrane.service.agentic import AgenticRunService
from dembrane.api.feature_flags import project_canvas_enabled

logger = getLogger("dembrane.agentic_worker")

AGENT_CANCELLED_ERROR_CODE = "AGENT_CANCELLED"
AGENT_CANCELLED_MESSAGE = "Run cancelled by user"
MAX_TOOL_CALLS_PER_TURN = 20
# Full-text snapshots are quadratic in message length, so throttle and back
# off as the text grows; on_chat_model_end always flushes the final snapshot.
DRAFT_PUBLISH_INTERVAL_SECONDS = 0.15
DRAFT_PUBLISH_MEDIUM_TEXT_CHARS = 2_000
DRAFT_PUBLISH_MEDIUM_INTERVAL_SECONDS = 0.5
DRAFT_PUBLISH_LONG_TEXT_CHARS = 8_000
DRAFT_PUBLISH_LONG_INTERVAL_SECONDS = 1.0


def _draft_publish_interval(text_length: int) -> float:
    if text_length >= DRAFT_PUBLISH_LONG_TEXT_CHARS:
        return DRAFT_PUBLISH_LONG_INTERVAL_SECONDS
    if text_length >= DRAFT_PUBLISH_MEDIUM_TEXT_CHARS:
        return DRAFT_PUBLISH_MEDIUM_INTERVAL_SECONDS
    return DRAFT_PUBLISH_INTERVAL_SECONDS
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


def _summarize_request_for_safety_message(user_message: Optional[str]) -> str:
    """Condense the host's own message for quoting back at them.

    This only ever receives the host's raw message, never the assembled agent
    prompt. Keep it that way: the prompt carries the focus block and project
    context, which are not the host's words and must not be echoed.
    """
    if not user_message:
        return ""
    normalized = " ".join(user_message.split())
    if len(normalized) > 140:
        return f"{normalized[:137].rstrip()}..."
    return normalized


def build_run_failure_payload(
    error_code: str,
    *,
    status_code: Optional[int] = None,
) -> dict[str, Any]:
    """Build a host-visible run failure payload: the error code, never the text.

    Upstream and exception messages are unbounded text we do not control. They
    can carry provider internals and, when an upstream echoes its input, the
    prompt itself, which for an agentic run includes transcript context. Only
    `error_code` is a value we produce, so only `error_code` crosses to the
    host. The raw text still reaches `logger` and the run's `latest_error`
    field, so developers lose nothing.

    The host-facing wording lives in the frontend, keyed by this code, so it is
    localised. A server-sent English sentence would not be.
    """
    payload: dict[str, Any] = {"error_code": error_code}
    if status_code is not None:
        payload["status_code"] = status_code
    return payload


def _build_turn_tool_limit_message(user_message: Optional[str]) -> str:
    request_summary = _summarize_request_for_safety_message(user_message)
    if not request_summary:
        return TOOL_LIMIT_SAFETY_MESSAGE
    return (
        f'I need to pause this pass on your request: "{request_summary}". '
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


def _coerce_chunk_text(value: Any) -> str:
    """Whitespace-preserving _coerce_text: chunk boundaries fall on spaces."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
                continue
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def _extract_stream_chunk(event: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    """Return (chunk_text, model_invocation_id) for an on_chat_model_stream event."""
    data = event.get("data")
    if not isinstance(data, dict):
        return None, None
    chunk = data.get("chunk")
    if not isinstance(chunk, dict):
        return None, None
    kwargs = chunk.get("kwargs")
    if not isinstance(kwargs, dict):
        return None, None
    text = _coerce_chunk_text(kwargs.get("content"))
    message_id = str(event.get("run_id") or "") or None
    return (text or None), message_id


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
    """Replay this run's turns as model history.

    User turns prefer the stored `agent_prompt_content` because it carries the
    project framing the raw message lacks. That stored text also baked in the
    focus selection that was current at the time, so every replayed turn used to
    re-assert "prioritize these conversations" with nothing superseding it: after
    the host cleared the focus, the agent kept narrowing to the old selection.
    The current turn's focus governs the current turn, so stale focus blocks are
    dropped from every earlier user turn.
    """
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

    # The last user turn is the one being answered now, so its focus block is
    # current and stays. Anything earlier is history: keep the turn, drop its
    # focus block.
    latest_user_index = next(
        (index for index in range(len(history) - 1, -1, -1) if history[index]["role"] == "user"),
        None,
    )
    for index, message in enumerate(history):
        if message["role"] != "user" or index == latest_user_index:
            continue
        stripped = strip_focus_blocks(message["content"]).strip()
        if stripped:
            message["content"] = stripped

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
    canvas_enabled: bool = False,
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
                    canvas_enabled=canvas_enabled,
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


async def _publish_draft_snapshot(run_id: str, message_id: str, text: str) -> None:
    """Ephemeral streaming snapshot: Redis pub/sub only, never persisted."""
    payload = json.dumps(
        {"event_type": "assistant.draft", "payload": {"message_id": message_id, "text": text}},
        default=str,
    )
    try:
        await publish_live_event(run_id, payload)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to publish draft snapshot for run %s: %s", run_id, exc)


async def _raise_if_cancelled(run_id: str, turn_seq: int) -> None:
    if await is_cancel_requested(run_id, turn_seq):
        raise AgenticRunCancelledError(AGENT_CANCELLED_MESSAGE)


async def _append_assistant_message(
    *,
    svc: AgenticRunService,
    run_id: str,
    content: str,
    project_chat_id: str,
    message_id: Optional[str] = None,
) -> Optional[str]:
    # Never emit or persist internal placeholders / empty turns as host-facing
    # messages — they only fragment the chat and leak the Gemini crutch text.
    sanitized_content = _sanitize_host_visible_assistant_content(content)
    if sanitized_content is None:
        return None
    event_payload: dict[str, Any] = {"content": sanitized_content}
    if message_id:
        event_payload["message_id"] = message_id
    await _append_event_and_publish(
        svc,
        run_id,
        "assistant.message",
        event_payload,
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


async def _count_persisted_non_exempt_tool_starts(*, svc: AgenticRunService, run_id: str) -> int:
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
    host_user_message: Optional[str] = None,
    run_service: Optional[AgenticRunService] = None,
) -> None:
    # `user_message` is model input: the assembled prompt, carrying project
    # context and the focus block. `host_user_message` is what the host
    # actually typed, and is the only thing we may quote back at them. When a
    # caller does not supply it we quote nothing rather than guess, so a
    # missing argument degrades to a generic message instead of leaking.
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

    async def _emit_chat_error(error_code: str) -> None:
        # Code only. Free-form upstream text is the same risk in analytics as
        # it is in the chat: it can carry prompt input, which here includes
        # transcript context. The code is the dimension worth grouping on.
        await capture_event(
            chat_distinct_id,
            "server_chat_error",
            {
                "run_id": run_id,
                "project_id": project_id,
                "error_code": error_code,
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
        canvas_enabled = await project_canvas_enabled(project_id)
        # Streamed text per model invocation; its run_id doubles as message_id.
        draft_texts: dict[str, str] = {}
        draft_last_publish_at: dict[str, float] = {}
        draft_published_texts: dict[str, str] = {}
        # Model turn whose narration a pending sendProgressUpdate result replaces.
        pending_progress_message_id: Optional[str] = None

        async def _maybe_publish_draft(message_id: str, *, flush: bool = False) -> None:
            now = time.monotonic()
            last_publish_at = draft_last_publish_at.get(message_id)
            if (
                not flush
                and last_publish_at is not None
                and now - last_publish_at
                < _draft_publish_interval(len(draft_texts[message_id]))
            ):
                return
            sanitized = _sanitize_host_visible_assistant_content(draft_texts[message_id])
            if not sanitized or sanitized == draft_published_texts.get(message_id):
                return
            if any(
                placeholder.startswith(sanitized)
                for placeholder in INTERNAL_PLACEHOLDER_CONTENTS
            ):
                # A growing draft hits placeholder prefixes ("(calling") before
                # the sanitizer can match the full string; hold those back.
                return
            draft_last_publish_at[message_id] = now
            draft_published_texts[message_id] = sanitized
            await _publish_draft_snapshot(run_id, message_id, sanitized)

        async for event in _stream_with_overflow_retry(
            project_id=project_id,
            user_message=user_message,
            bearer_token=bearer_token,
            thread_id=run_id,
            message_history=message_history,
            chat_id=project_chat_id or None,
            app_user_id=app_user_id,
            message_id=message_id,
            canvas_enabled=canvas_enabled,
        ):
            await _raise_if_cancelled(run_id, turn_seq)
            event_type = str(event.get("type") or event.get("event") or "agent.event")

            if event_type == "on_chat_model_stream":
                # Redis only, never persisted: one Directus row per chunk is bloat.
                chunk_text, stream_message_id = _extract_stream_chunk(event)
                if chunk_text and stream_message_id:
                    draft_texts[stream_message_id] = (
                        draft_texts.get(stream_message_id, "") + chunk_text
                    )
                    await _maybe_publish_draft(stream_message_id)
                continue

            model_text, model_tool_calls = _extract_model_text_and_tool_calls(event)
            model_message_id = (
                str(event.get("run_id") or "") or None
                if event_type == "on_chat_model_end"
                else None
            )
            if model_message_id and model_message_id in draft_texts:
                # Flush the throttled tail; the final snapshot carries the full text.
                await _maybe_publish_draft(model_message_id, flush=True)
            model_has_progress_tool_call = "sendProgressUpdate" in model_tool_calls
            if model_has_progress_tool_call:
                # The tool's output is this turn's visible message; sharing the
                # message_id lets the streamed narration draft resolve into it.
                pending_progress_message_id = model_message_id
            if model_text:
                if model_has_progress_tool_call:
                    # The narration repeats the tool's words; keeping both double-posts.
                    has_sent_progress_intro = True
                else:
                    # Text shown as a draft must get a durable copy (no flicker),
                    # even when the turn ends in tool calls.
                    persisted_content = await _append_assistant_message(
                        svc=svc,
                        run_id=run_id,
                        content=model_text,
                        project_chat_id=project_chat_id,
                        message_id=model_message_id,
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

                if (
                    persisted_non_exempt_tool_starts + counted_tool_start_count
                    >= MAX_TOOL_CALLS_PER_RUN
                ):
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
                        content=_build_turn_tool_limit_message(host_user_message),
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
                        message_id=pending_progress_message_id,
                    )
                    pending_progress_message_id = None
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
        await _emit_chat_error(AGENT_CANCELLED_ERROR_CODE)
        await _append_event_and_publish(
            svc,
            run_id,
            "run.failed",
            build_run_failure_payload(AGENT_CANCELLED_ERROR_CODE),
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
        await _emit_chat_error("AGENT_TIMEOUT")
        await _append_event_and_publish(
            svc,
            run_id,
            "run.timeout",
            build_run_failure_payload("AGENT_TIMEOUT"),
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
        await _emit_chat_error(exc.error_code)
        await _append_event_and_publish(
            svc,
            run_id,
            "run.failed",
            build_run_failure_payload(exc.error_code, status_code=exc.status_code),
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
        exc_str = str(exc)
        await _emit_chat_error("AGENT_UNEXPECTED_ERROR")
        await _append_event_and_publish(
            svc,
            run_id,
            "run.failed",
            build_run_failure_payload("AGENT_UNEXPECTED_ERROR"),
        )
        await run_in_thread_pool(
            svc.set_status,
            run_id,
            "failed",
            latest_error=exc_str,
            latest_error_code="AGENT_UNEXPECTED_ERROR",
        )
    finally:
        await clear_cancel(run_id, turn_seq)
