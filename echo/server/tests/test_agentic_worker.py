import pytest

from tests.agentic.fakes import InMemoryDirectus
from dembrane.agentic_client import AgenticTimeoutError, AgenticUpstreamError
from dembrane.agentic_worker import process_agentic_run
from dembrane.service.agentic import AgenticRunService


def _build_service() -> AgenticRunService:
    return AgenticRunService(directus_client=InMemoryDirectus())


@pytest.mark.asyncio
async def test_process_agentic_run_completes_and_persists_events(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")

    async def _fake_stream(  # noqa: ARG001
        *, project_id: str, user_message: str, bearer_token: str, thread_id: str
    ):
        assert thread_id == run["id"]
        yield {"type": "assistant.delta", "content": "hel"}
        yield {"type": "assistant.message", "content": "hello"}

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        run_service=service,
    )

    stored_run = service.get_by_id_or_raise(run["id"])
    events = service.list_events(run["id"])

    assert stored_run["status"] == "completed"
    assert stored_run["latest_output"] == "hello"
    assert [event["seq"] for event in events] == [1, 2]


@pytest.mark.asyncio
async def test_process_agentic_run_handles_timeout(monkeypatch) -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")

    async def _fake_stream(  # noqa: ARG001
        *, project_id: str, user_message: str, bearer_token: str, thread_id: str
    ):
        raise AgenticTimeoutError("timed out")
        yield  # pragma: no cover

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
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

    async def _fake_stream(  # noqa: ARG001
        *, project_id: str, user_message: str, bearer_token: str, thread_id: str
    ):
        yield {"type": "assistant.delta", "content": "hel"}
        raise AgenticUpstreamError(
            status_code=401,
            error_code="AGENT_UPSTREAM_401",
            message="token expired",
        )

    monkeypatch.setattr("dembrane.agentic_worker.stream_agent_events", _fake_stream)

    await process_agentic_run(
        run_id=run["id"],
        project_id="project-1",
        user_message="hello",
        bearer_token="token-1",
        run_service=service,
    )

    stored_run = service.get_by_id_or_raise(run["id"])
    events = service.list_events(run["id"])

    assert stored_run["status"] == "failed"
    assert stored_run["latest_error_code"] == "AGENT_UPSTREAM_401"
    assert [event["event_type"] for event in events] == ["assistant.delta", "run.failed"]
