import pytest

from tests.agentic.fakes import InMemoryDirectus
from dembrane.service.agentic import (
    AgenticRunService,
    AgenticRunNotFoundException,
)


def _build_service() -> AgenticRunService:
    return AgenticRunService(directus_client=InMemoryDirectus())


def test_create_run_defaults_to_queued() -> None:
    service = _build_service()
    run = service.create_run(
        project_id="project-1",
        directus_user_id="user-1",
        project_chat_id="chat-1",
    )

    assert run["status"] == "queued"
    assert run["last_event_seq"] == 0
    assert run["project_id"] == "project-1"
    assert run["project_chat_id"] == "chat-1"
    assert run["directus_user_id"] == "user-1"


def test_append_event_uses_monotonic_seq() -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")

    first = service.append_event(run["id"], "run.started", {"status": "running"})
    second = service.append_event(run["id"], "assistant.message", {"content": "hello"})

    assert first["seq"] == 1
    assert second["seq"] == 2

    stored_run = service.get_by_id_or_raise(run["id"])
    assert stored_run["last_event_seq"] == 2


def test_list_events_after_seq_returns_delta() -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")
    service.append_event(run["id"], "run.started", {"status": "running"})
    service.append_event(run["id"], "assistant.message", {"content": "hello"})
    service.append_event(run["id"], "run.completed", {"status": "completed"})

    events = service.list_events(run["id"], after_seq=1)

    assert [event["seq"] for event in events] == [2, 3]


def test_run_lifecycle_status_transitions() -> None:
    service = _build_service()
    run = service.create_run(project_id="project-1", directus_user_id="user-1")

    running = service.set_status(run["id"], "running")
    assert running["status"] == "running"
    assert running["started_at"] is not None

    completed = service.set_status(
        run["id"],
        "completed",
        latest_output="final-answer",
    )
    assert completed["status"] == "completed"
    assert completed["completed_at"] is not None
    assert completed["latest_output"] == "final-answer"


def test_concurrent_runs_are_isolated() -> None:
    service = _build_service()
    run_1 = service.create_run(project_id="project-1", directus_user_id="user-1")
    run_2 = service.create_run(project_id="project-1", directus_user_id="user-1")

    service.append_event(run_1["id"], "assistant.message", {"content": "one"})
    service.append_event(run_2["id"], "assistant.message", {"content": "two"})
    service.append_event(run_1["id"], "assistant.message", {"content": "three"})

    run_1_events = service.list_events(run_1["id"])
    run_2_events = service.list_events(run_2["id"])

    assert [event["seq"] for event in run_1_events] == [1, 2]
    assert [event["seq"] for event in run_2_events] == [1]


def test_get_by_id_or_raise_missing_run() -> None:
    service = _build_service()

    with pytest.raises(AgenticRunNotFoundException):
        service.get_by_id_or_raise("missing-run")
