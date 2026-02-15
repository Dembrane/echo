import pytest

from tests.agentic.fakes import InMemoryDirectus
from dembrane.agentic_client import AgenticTimeoutError, AgenticUpstreamError
from dembrane.agentic_worker import AGENT_CANCELLED_ERROR_CODE, process_agentic_run
from dembrane.service.agentic import AgenticRunService


def _build_service() -> AgenticRunService:
    return AgenticRunService(directus_client=InMemoryDirectus())


class _FakeChatService:
    def __init__(self) -> None:
        self.created_messages: list[dict[str, str]] = []

    def create_message(self, chat_id: str, message_from: str, text: str) -> dict[str, str]:
        message = {
            "id": f"msg-{len(self.created_messages) + 1}",
            "project_chat_id": chat_id,
            "message_from": message_from,
            "text": text,
        }
        self.created_messages.append(message)
        return message


@pytest.mark.asyncio
async def test_process_agentic_run_completes_persists_and_publishes(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(
        project_id="project-1",
        project_chat_id="chat-1",
        directus_user_id="user-1",
    )
    fake_chat_service = _FakeChatService()
    published_events: list[str] = []

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token, message_history)
        assert thread_id == run["id"]
        yield {"type": "assistant.delta", "content": "hel"}
        yield {"type": "assistant.message", "content": "hello"}

    async def _fake_publish(run_id: str, event_json: str) -> None:
        assert run_id == run["id"]
        published_events.append(event_json)

    async def _never_cancel(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        return False

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.chat_service", fake_chat_service)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _never_cancel)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        turn_seq=1,
        owner_token="owner-1",
        run_service=service,
    )

    stored_run = service.get_by_id_or_raise(run["id"])
    events = service.list_events(run["id"])

    assert stored_run["status"] == "completed"
    assert stored_run["latest_output"] == "hello"
    assert [event["seq"] for event in events] == [1, 2]
    assert len(published_events) == 2
    assert fake_chat_service.created_messages == [
        {
            "id": "msg-1",
            "project_chat_id": "chat-1",
            "message_from": "assistant",
            "text": "hello",
        }
    ]


@pytest.mark.asyncio
async def test_process_agentic_run_handles_timeout(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token, thread_id, message_history)
        raise AgenticTimeoutError("timed out")
        yield  # pragma: no cover

    async def _fake_publish(run_id: str, event_json: str) -> None:  # noqa: ARG001
        return None

    async def _never_cancel(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        return False

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _never_cancel)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        turn_seq=1,
        owner_token="owner-1",
        run_service=service,
    )

    stored_run = service.get_by_id_or_raise(run["id"])
    events = service.list_events(run["id"])

    assert stored_run["status"] == "timeout"
    assert stored_run["latest_error_code"] == "AGENT_TIMEOUT"
    assert events[-1]["event_type"] == "run.timeout"


@pytest.mark.asyncio
async def test_process_agentic_run_persists_partial_stream_before_upstream_failure(
    monkeypatch,
) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token, thread_id, message_history)
        yield {"type": "assistant.delta", "content": "hel"}
        raise AgenticUpstreamError(
            status_code=401,
            error_code="AGENT_UPSTREAM_401",
            message="token expired",
        )
        yield  # pragma: no cover

    async def _fake_publish(run_id: str, event_json: str) -> None:  # noqa: ARG001
        return None

    async def _never_cancel(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        return False

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _never_cancel)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        turn_seq=1,
        owner_token="owner-1",
        run_service=service,
    )

    stored_run = service.get_by_id_or_raise(run["id"])
    events = service.list_events(run["id"])

    assert stored_run["status"] == "failed"
    assert stored_run["latest_error_code"] == "AGENT_UPSTREAM_401"
    assert [event["event_type"] for event in events] == ["assistant.delta", "run.failed"]


@pytest.mark.asyncio
async def test_process_agentic_run_handles_cancel_request(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token, thread_id, message_history)
        yield {"type": "assistant.delta", "content": "hel"}
        yield {"type": "assistant.message", "content": "hello"}

    state = {"calls": 0}

    async def _cancel_after_first(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        state["calls"] += 1
        return state["calls"] >= 2

    async def _fake_publish(run_id: str, event_json: str) -> None:  # noqa: ARG001
        return None

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _cancel_after_first)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        turn_seq=1,
        owner_token="owner-1",
        run_service=service,
    )

    stored_run = service.get_by_id_or_raise(run["id"])
    events = service.list_events(run["id"])

    assert stored_run["status"] == "failed"
    assert stored_run["latest_error_code"] == AGENT_CANCELLED_ERROR_CODE
    assert events[-1]["event_type"] == "run.failed"
    assert events[-1]["payload"]["error_code"] == AGENT_CANCELLED_ERROR_CODE


@pytest.mark.asyncio
async def test_process_agentic_run_splits_planning_and_final_synthesis(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(
        project_id="project-1",
        project_chat_id="chat-1",
        directus_user_id="user-1",
    )
    fake_chat_service = _FakeChatService()

    planning_content = (
        "I will investigate halftime discussions and gather evidence.\n\n"
        "### Summary of Perspectives\nThis part should not be emitted in the planning message."
    )

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token, message_history)
        assert thread_id == run["id"]
        yield {
            "type": "on_chat_model_end",
            "data": {
                "output": {
                    "kwargs": {
                        "content": [{"type": "text", "text": planning_content}],
                        "additional_kwargs": {
                            "function_call": {
                                "name": "findConvosByKeywords",
                                "arguments": "{\"keywords\":\"half time show\"}",
                            }
                        },
                    }
                }
            },
        }
        yield {"type": "on_tool_start", "name": "findConvosByKeywords"}
        yield {"type": "on_tool_end", "name": "findConvosByKeywords", "data": {"output": {}}}
        yield {
            "type": "on_chat_model_end",
            "data": {
                "output": {
                    "kwargs": {
                        "content": [{"type": "text", "text": "Final synthesis message."}],
                        "additional_kwargs": {},
                    }
                }
            },
        }

    async def _fake_publish(run_id: str, event_json: str) -> None:  # noqa: ARG001
        return None

    async def _never_cancel(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        return False

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.chat_service", fake_chat_service)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _never_cancel)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        turn_seq=1,
        owner_token="owner-1",
        run_service=service,
    )

    stored_run = service.get_by_id_or_raise(run["id"])
    events = service.list_events(run["id"])
    assistant_events = [event for event in events if event["event_type"] == "assistant.message"]

    assert stored_run["status"] == "completed"
    assert stored_run["latest_output"] == "Final synthesis message."
    assert len(assistant_events) == 2
    assert assistant_events[0]["payload"]["content"] == "I will investigate halftime discussions and gather evidence."
    assert "Summary of Perspectives" not in assistant_events[0]["payload"]["content"]
    assert assistant_events[1]["payload"]["content"] == "Final synthesis message."
    assert fake_chat_service.created_messages == [
        {
            "id": "msg-1",
            "project_chat_id": "chat-1",
            "message_from": "assistant",
            "text": "I will investigate halftime discussions and gather evidence.",
        },
        {
            "id": "msg-2",
            "project_chat_id": "chat-1",
            "message_from": "assistant",
            "text": "Final synthesis message.",
        },
    ]


@pytest.mark.asyncio
async def test_process_agentic_run_falls_back_to_default_intro_when_model_has_no_plan(
    monkeypatch,
) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token, thread_id, message_history)
        yield {"type": "on_tool_start", "name": "listProjectConversations"}
        yield {"type": "on_tool_end", "name": "listProjectConversations", "data": {"output": {}}}
        yield {
            "type": "on_chat_model_end",
            "data": {
                "output": {
                    "kwargs": {
                        "content": [{"type": "text", "text": "Final answer only."}],
                        "additional_kwargs": {},
                    }
                }
            },
        }

    async def _fake_publish(run_id: str, event_json: str) -> None:  # noqa: ARG001
        return None

    async def _never_cancel(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        return False

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _never_cancel)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        turn_seq=1,
        owner_token="owner-1",
        run_service=service,
    )

    events = service.list_events(run["id"])
    assistant_events = [event for event in events if event["event_type"] == "assistant.message"]

    assert assistant_events[0]["payload"]["content"] == (
        "I'll first gather evidence before answering. Starting with `listProjectConversations`."
    )
    assert assistant_events[1]["payload"]["content"] == "Final answer only."


@pytest.mark.asyncio
async def test_process_agentic_run_passes_persisted_message_history(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")
    service.append_event(
        run["id"],
        "user.message",
        {
            "content": "hello raw",
            "agent_prompt_content": (
                "Project Name: Helix\nProject Context: politics\n\nUser Message: hello"
            ),
        },
    )
    service.append_event(run["id"], "assistant.message", {"content": "hello back"})
    service.append_event(run["id"], "user.message", {"content": "follow up"})

    captured: dict[str, list[dict[str, str]] | None] = {"message_history": None}

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token)
        assert thread_id == run["id"]
        captured["message_history"] = message_history
        yield {"type": "assistant.message", "content": "final answer"}

    async def _fake_publish(run_id: str, event_json: str) -> None:  # noqa: ARG001
        return None

    async def _never_cancel(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        return False

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _never_cancel)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="follow up",
        bearer_token="token-1",
        turn_seq=3,
        owner_token="owner-1",
        run_service=service,
    )

    assert captured["message_history"] == [
        {"role": "user", "content": "Project Name: Helix\nProject Context: politics\n\nUser Message: hello"},
        {"role": "assistant", "content": "hello back"},
        {"role": "user", "content": "follow up"},
    ]
    stored_run = service.get_by_id_or_raise(run["id"])
    assert stored_run["status"] == "completed"
    assert stored_run["latest_output"] == "final answer"


@pytest.mark.asyncio
async def test_process_agentic_run_retries_once_on_context_overflow(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")
    for index in range(15):
        service.append_event(run["id"], "user.message", {"content": f"user-{index}"})
        service.append_event(run["id"], "assistant.message", {"content": f"assistant-{index}"})
    service.append_event(run["id"], "user.message", {"content": "latest-user"})

    histories: list[list[dict[str, str]]] = []

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token, thread_id)
        assert message_history is not None
        histories.append([dict(item) for item in message_history])

        if len(histories) == 1:
            raise AgenticUpstreamError(
                status_code=400,
                error_code="AGENT_UPSTREAM_400",
                message="maximum context length exceeded",
            )

        yield {"type": "assistant.message", "content": "retry success"}

    async def _fake_publish(run_id: str, event_json: str) -> None:  # noqa: ARG001
        return None

    async def _never_cancel(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        return False

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _never_cancel)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="latest-user",
        bearer_token="token-1",
        turn_seq=31,
        owner_token="owner-1",
        run_service=service,
    )

    assert len(histories) == 2
    assert len(histories[1]) == 24
    assert histories[1] == histories[0][-24:]
    stored_run = service.get_by_id_or_raise(run["id"])
    assert stored_run["status"] == "completed"
    assert stored_run["latest_output"] == "retry success"


@pytest.mark.asyncio
async def test_process_agentic_run_does_not_retry_non_overflow_upstream_errors(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")
    service.append_event(run["id"], "user.message", {"content": "hello"})

    state = {"calls": 0}

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token, thread_id, message_history)
        state["calls"] += 1
        raise AgenticUpstreamError(
            status_code=401,
            error_code="AGENT_UPSTREAM_401",
            message="token expired",
        )
        yield  # pragma: no cover

    async def _fake_publish(run_id: str, event_json: str) -> None:  # noqa: ARG001
        return None

    async def _never_cancel(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        return False

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _never_cancel)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        turn_seq=1,
        owner_token="owner-1",
        run_service=service,
    )

    assert state["calls"] == 1
    stored_run = service.get_by_id_or_raise(run["id"])
    assert stored_run["status"] == "failed"
    assert stored_run["latest_error_code"] == "AGENT_UPSTREAM_401"


@pytest.mark.asyncio
async def test_process_agentic_run_does_not_retry_after_stream_events(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")
    service.append_event(run["id"], "user.message", {"content": "hello"})

    state = {"calls": 0}

    async def _fake_stream(
        *,
        project_id: str,
        user_message: str,
        bearer_token: str,
        thread_id: str,
        message_history: list[dict[str, str]] | None = None,
    ):
        _ = (project_id, user_message, bearer_token, thread_id, message_history)
        state["calls"] += 1
        yield {"type": "assistant.delta", "content": "partial"}
        raise AgenticUpstreamError(
            status_code=400,
            error_code="AGENT_UPSTREAM_400",
            message="maximum context length exceeded",
        )

    async def _fake_publish(run_id: str, event_json: str) -> None:  # noqa: ARG001
        return None

    async def _never_cancel(run_id: str, turn_seq: int) -> bool:  # noqa: ARG001
        return False

    async def _clear_cancel(run_id: str, turn_seq: int) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)
    monkeypatch.setattr("dembrane.agentic_worker.publish_live_event", _fake_publish)
    monkeypatch.setattr("dembrane.agentic_worker.is_cancel_requested", _never_cancel)
    monkeypatch.setattr("dembrane.agentic_worker.clear_cancel", _clear_cancel)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        turn_seq=1,
        owner_token="owner-1",
        run_service=service,
    )

    assert state["calls"] == 1
    stored_run = service.get_by_id_or_raise(run["id"])
    events = service.list_events(run["id"])
    assert stored_run["status"] == "failed"
    assert stored_run["latest_error_code"] == "AGENT_UPSTREAM_400"
    assert [event["event_type"] for event in events] == ["user.message", "assistant.delta", "run.failed"]
