from __future__ import annotations

from typing import Any

import httpx
import pytest

from dembrane.agentic_client import (
    AgenticTimeoutError,
    AgenticUpstreamError,
    stream_agent_events,
)


class _FakeStreamResponse:
    def __init__(
        self,
        status_code: int,
        chunks: list[str] | None = None,
        body: bytes = b"",
        stream_error: Exception | None = None,
    ) -> None:
        self.status_code = status_code
        self._chunks = chunks or []
        self._body = body
        self._stream_error = stream_error

    async def __aenter__(self) -> "_FakeStreamResponse":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        return None

    async def aiter_text(self):  # noqa: ANN201
        for chunk in self._chunks:
            yield chunk
        if self._stream_error is not None:
            raise self._stream_error

    async def aread(self) -> bytes:
        return self._body


class _FakeAsyncClient:
    def __init__(
        self,
        *,
        base_url: str,
        timeout: float,
        capture: dict[str, Any],
        response: _FakeStreamResponse | None = None,
        timeout_error: Exception | None = None,
    ) -> None:
        self._capture = capture
        self._response = response
        self._timeout_error = timeout_error
        self._capture["base_url"] = base_url
        self._capture["timeout"] = timeout

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        return None

    def stream(self, method: str, path: str, *, json: dict[str, Any], headers: dict[str, str]):
        self._capture["method"] = method
        self._capture["path"] = path
        self._capture["json"] = json
        self._capture["headers"] = headers

        if self._timeout_error is not None:
            raise self._timeout_error
        assert self._response is not None
        return self._response


@pytest.mark.asyncio
async def test_stream_agent_events_forwards_headers_body_and_path(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    response = _FakeStreamResponse(
        status_code=200,
        chunks=['{"type":"assistant.delta","content":"hel"}\n', '{"type":"assistant.message","content":"hello"}\n'],
    )

    def _build_client(*, base_url: str, timeout: float) -> _FakeAsyncClient:
        return _FakeAsyncClient(
            base_url=base_url,
            timeout=timeout,
            capture=capture,
            response=response,
        )

    monkeypatch.setattr("dembrane.agentic_client.httpx.AsyncClient", _build_client)

    events = [
        event
        async for event in stream_agent_events(
            project_id="project-1",
            user_message="hello",
            bearer_token="token-1",
            thread_id="run-1",
            agent_service_url="http://agent.test",
            timeout_seconds=42,
        )
    ]

    assert capture["base_url"] == "http://agent.test"
    assert capture["timeout"] == 42
    assert capture["method"] == "POST"
    assert capture["path"] == "/copilotkit/project-1"
    assert capture["json"]["threadId"] == "run-1"
    assert capture["json"]["state"] == {}
    assert capture["json"]["actions"] == []
    assert len(capture["json"]["messages"]) == 1
    assert capture["json"]["messages"][0]["type"] == "TextMessage"
    assert capture["json"]["messages"][0]["role"] == "user"
    assert capture["json"]["messages"][0]["content"] == "hello"
    assert capture["json"]["messages"][0]["id"]
    assert capture["headers"]["Authorization"] == "Bearer token-1"
    assert events == [
        {"type": "assistant.delta", "content": "hel"},
        {"type": "assistant.message", "content": "hello"},
    ]


@pytest.mark.asyncio
async def test_stream_agent_events_serializes_message_history_in_order(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    response = _FakeStreamResponse(status_code=200, chunks=['{"type":"assistant.message","content":"done"}\n'])

    def _build_client(*, base_url: str, timeout: float) -> _FakeAsyncClient:
        return _FakeAsyncClient(
            base_url=base_url,
            timeout=timeout,
            capture=capture,
            response=response,
        )

    monkeypatch.setattr("dembrane.agentic_client.httpx.AsyncClient", _build_client)

    events = [
        event
        async for event in stream_agent_events(
            project_id="project-1",
            user_message="latest-user",
            bearer_token="token-1",
            thread_id="run-1",
            message_history=[
                {"role": "user", "content": "first-user"},
                {"role": "assistant", "content": "first-assistant"},
                {"role": "user", "content": "second-user"},
            ],
            agent_service_url="http://agent.test",
            timeout_seconds=42,
        )
    ]

    assert [message["role"] for message in capture["json"]["messages"]] == [
        "user",
        "assistant",
        "user",
        "user",
    ]
    assert [message["content"] for message in capture["json"]["messages"]] == [
        "first-user",
        "first-assistant",
        "second-user",
        "latest-user",
    ]
    assert all(message["id"] for message in capture["json"]["messages"])
    assert events == [{"type": "assistant.message", "content": "done"}]


@pytest.mark.asyncio
async def test_stream_agent_events_dedupes_latest_user_if_already_in_history(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    response = _FakeStreamResponse(status_code=200, chunks=['{"type":"assistant.message","content":"done"}\n'])

    def _build_client(*, base_url: str, timeout: float) -> _FakeAsyncClient:
        return _FakeAsyncClient(
            base_url=base_url,
            timeout=timeout,
            capture=capture,
            response=response,
        )

    monkeypatch.setattr("dembrane.agentic_client.httpx.AsyncClient", _build_client)

    events = [
        event
        async for event in stream_agent_events(
            project_id="project-1",
            user_message="follow up",
            bearer_token="token-1",
            thread_id="run-1",
            message_history=[
                {"role": "user", "content": "first-user"},
                {"role": "assistant", "content": "first-assistant"},
                {"role": "user", "content": "follow up"},
            ],
            agent_service_url="http://agent.test",
            timeout_seconds=42,
        )
    ]

    assert [message["role"] for message in capture["json"]["messages"]] == [
        "user",
        "assistant",
        "user",
    ]
    assert [message["content"] for message in capture["json"]["messages"]] == [
        "first-user",
        "first-assistant",
        "follow up",
    ]
    assert all(message["id"] for message in capture["json"]["messages"])
    assert events == [{"type": "assistant.message", "content": "done"}]


@pytest.mark.asyncio
async def test_stream_agent_events_raises_upstream_error(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    response = _FakeStreamResponse(status_code=503, body=b"service unavailable")

    def _build_client(*, base_url: str, timeout: float) -> _FakeAsyncClient:
        return _FakeAsyncClient(
            base_url=base_url,
            timeout=timeout,
            capture=capture,
            response=response,
        )

    monkeypatch.setattr("dembrane.agentic_client.httpx.AsyncClient", _build_client)

    with pytest.raises(AgenticUpstreamError) as exc:
        events = stream_agent_events(
            project_id="project-1",
            user_message="hello",
            bearer_token="token-1",
            agent_service_url="http://agent.test",
            timeout_seconds=42,
        )
        async for _ in events:
            pass

    assert exc.value.status_code == 503
    assert exc.value.error_code == "AGENT_UPSTREAM_503"


@pytest.mark.asyncio
async def test_stream_agent_events_converts_timeout(monkeypatch) -> None:
    capture: dict[str, Any] = {}

    def _build_client(*, base_url: str, timeout: float) -> _FakeAsyncClient:
        return _FakeAsyncClient(
            base_url=base_url,
            timeout=timeout,
            capture=capture,
            timeout_error=httpx.TimeoutException("timed out"),
        )

    monkeypatch.setattr("dembrane.agentic_client.httpx.AsyncClient", _build_client)

    with pytest.raises(AgenticTimeoutError):
        events = stream_agent_events(
            project_id="project-1",
            user_message="hello",
            bearer_token="token-1",
            agent_service_url="http://agent.test",
            timeout_seconds=42,
        )
        async for _ in events:
            pass


@pytest.mark.asyncio
async def test_stream_agent_events_converts_transport_errors_to_upstream_error(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    response = _FakeStreamResponse(
        status_code=200,
        stream_error=httpx.RemoteProtocolError(
            "peer closed connection without sending complete message body (incomplete chunked read)"
        ),
    )

    def _build_client(*, base_url: str, timeout: float) -> _FakeAsyncClient:
        return _FakeAsyncClient(
            base_url=base_url,
            timeout=timeout,
            capture=capture,
            response=response,
        )

    monkeypatch.setattr("dembrane.agentic_client.httpx.AsyncClient", _build_client)

    with pytest.raises(AgenticUpstreamError) as exc:
        events = stream_agent_events(
            project_id="project-1",
            user_message="hello",
            bearer_token="token-1",
            agent_service_url="http://agent.test",
            timeout_seconds=42,
        )
        async for _ in events:
            pass

    assert exc.value.status_code == 502
    assert exc.value.error_code == "AGENT_UPSTREAM_TRANSPORT"
    assert "incomplete chunked read" in exc.value.message.lower()
