from __future__ import annotations

import json
from typing import Any, AsyncGenerator, Optional
from uuid import uuid4

import httpx

from dembrane.settings import get_settings


class AgenticClientError(Exception):
    pass


class AgenticTimeoutError(AgenticClientError):
    pass


class AgenticUpstreamError(AgenticClientError):
    def __init__(self, *, status_code: int, error_code: str, message: str) -> None:
        self.status_code = status_code
        self.error_code = error_code
        self.message = message
        super().__init__(message)


MessageHistoryEntry = dict[str, str]


def _build_payload_messages(
    *,
    user_message: str,
    message_history: Optional[list[MessageHistoryEntry]],
) -> list[dict[str, str]]:
    payload_messages: list[dict[str, str]] = []
    if isinstance(message_history, list):
        for message in message_history:
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            content = message.get("content")
            if role not in {"user", "assistant"}:
                continue
            if not isinstance(content, str):
                continue
            normalized_content = content.strip()
            if not normalized_content:
                continue

            payload_messages.append(
                {
                    "id": str(uuid4()),
                    "type": "TextMessage",
                    "role": role,
                    "content": normalized_content,
                }
            )

    normalized_user_message = user_message.strip()
    if normalized_user_message:
        latest = payload_messages[-1] if payload_messages else None
        should_append_current_turn = not (
            isinstance(latest, dict)
            and latest.get("role") == "user"
            and latest.get("content") == normalized_user_message
        )
        if should_append_current_turn:
            payload_messages.append(
                {
                    "id": str(uuid4()),
                    "type": "TextMessage",
                    "role": "user",
                    "content": normalized_user_message,
                }
            )

    if payload_messages:
        return payload_messages

    return [
        {
            "id": str(uuid4()),
            "type": "TextMessage",
            "role": "user",
            "content": normalized_user_message or user_message,
        }
    ]


async def stream_agent_events(
    *,
    project_id: str,
    user_message: str,
    bearer_token: str,
    thread_id: Optional[str] = None,
    message_history: Optional[list[MessageHistoryEntry]] = None,
    agent_service_url: Optional[str] = None,
    timeout_seconds: Optional[float] = None,
) -> AsyncGenerator[dict[str, Any], None]:
    settings = get_settings()
    resolved_agent_service_url = agent_service_url or settings.agentic.agent_service_url
    resolved_timeout_seconds = timeout_seconds or settings.agentic.run_timeout_seconds

    headers = {
        "Authorization": f"Bearer {bearer_token}",
        "Accept": "application/x-ndjson",
    }

    payload = {
        "threadId": thread_id,
        "state": {},
        "actions": [],
        "messages": _build_payload_messages(
            user_message=user_message,
            message_history=message_history,
        ),
    }

    try:
        async with httpx.AsyncClient(
            base_url=resolved_agent_service_url,
            timeout=resolved_timeout_seconds,
        ) as client:
            async with client.stream(
                "POST",
                f"/copilotkit/{project_id}",
                json=payload,
                headers=headers,
            ) as response:
                if response.status_code >= 400:
                    raw_error = await response.aread()
                    message = raw_error.decode("utf-8", errors="ignore").strip()
                    if not message:
                        message = "Agent upstream request failed"
                    raise AgenticUpstreamError(
                        status_code=response.status_code,
                        error_code=f"AGENT_UPSTREAM_{response.status_code}",
                        message=message,
                    )

                buffer = ""
                async for chunk in response.aiter_text():
                    buffer += chunk
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        event = _safe_parse_json(line)
                        if event is not None:
                            yield event

                trailing = buffer.strip()
                if trailing:
                    event = _safe_parse_json(trailing)
                    if event is not None:
                        yield event
    except httpx.TimeoutException as exc:
        raise AgenticTimeoutError("Agent request timed out") from exc
    except httpx.TransportError as exc:
        raise AgenticUpstreamError(
            status_code=502,
            error_code="AGENT_UPSTREAM_TRANSPORT",
            message=f"Agent upstream transport error: {exc}",
        ) from exc


def _safe_parse_json(value: str) -> dict[str, Any] | None:
    try:
        data = json.loads(value)
    except json.JSONDecodeError:
        return None

    if not isinstance(data, dict):
        return None
    return data
