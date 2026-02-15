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
        *, project_id: str, user_message: str, bearer_token: str, thread_id: str
    ):
        _ = (project_id, user_message, bearer_token)
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
        *, project_id: str, user_message: str, bearer_token: str, thread_id: str
    ):
        _ = (project_id, user_message, bearer_token, thread_id)
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
        *, project_id: str, user_message: str, bearer_token: str, thread_id: str
    ):
        _ = (project_id, user_message, bearer_token, thread_id)
        yield {"type": "assistant.delta", "content": "hel"}
        raise AgenticUpstreamError(
            status_code=401,
            error_code="AGENT_UPSTREAM_401",
            message="token expired",
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
        *, project_id: str, user_message: str, bearer_token: str, thread_id: str
    ):
        _ = (project_id, user_message, bearer_token, thread_id)
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
