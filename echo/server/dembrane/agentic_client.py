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


async def stream_agent_events(
    *,
    project_id: str,
    user_message: str,
    bearer_token: str,
    thread_id: Optional[str] = None,
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
        "messages": [
            {
                "id": str(uuid4()),
                "type": "TextMessage",
                "role": "user",
                "content": user_message,
            }
        ],
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


def _safe_parse_json(value: str) -> dict[str, Any] | None:
    try:
        data = json.loads(value)
    except json.JSONDecodeError:
        return None

    if not isinstance(data, dict):
        return None
    return data
