"""Fact-checks for Map claims: one state per claim revision, attempt-guarded."""

from __future__ import annotations

from typing import Any
from datetime import datetime, timezone

import pytest

from dembrane.map import model, service
from tests.map_fakes import (
    PROJECT,
    OTHER_PROJECT,
    FakeMapStore,
    ready_result,
    manifest_argument,
)
from dembrane.map.fact_check import (
    STALE_SECONDS,
    run_fact_check,
    fact_check_state,
    mark_interrupted,
)

CLAIM = "The bridge opened in 1932."
QUOTES = ["it opened in 1932"]


def _arguments(quotes: list[str] | None = None, statement: str = CLAIM) -> list[dict[str, Any]]:
    return [
        manifest_argument("a-claim", statement, kind="claim", valence="neutral", quotes=quotes or QUOTES),
        manifest_argument("a-arg", "Bridges hold the city together."),
    ]


class _Harness:
    def __init__(self, store: FakeMapStore) -> None:
        self.store = store
        self.dispatched: list[tuple[str, int, str, str]] = []
        self.checks: list[dict[str, Any]] = []
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.outcome: dict[str, Any] = {
            "verdict": "false",
            "justification": "It opened in 1934.",
            "sources": [{"url": "https://archive.example", "title": "Archive"}],
        }
        self.error: BaseException | None = None
        self.during_check: Any = None

    def dispatch(self, fact_check_id: str, attempt: int, result_id: str, node_id: str) -> str:
        self.dispatched.append((fact_check_id, attempt, result_id, node_id))
        return f"msg-{len(self.dispatched)}"

    async def check(self, **kwargs: Any) -> dict[str, Any]:
        self.checks.append(kwargs)
        if self.during_check is not None:
            await self.during_check()
        if self.error is not None:
            raise self.error
        return self.outcome

    async def context(self, project_id: str) -> tuple[str, str]:
        assert project_id == PROJECT
        return "Harbour", "A plan for the old harbour."

    async def publish(self, project_id: str, event: dict[str, Any]) -> None:
        self.events.append((project_id, event))

    async def start(self, row: dict[str, Any], node_id: str = "a-claim", force: bool = False) -> dict[str, Any]:
        return await service.start_fact_check(
            row, node_id, requested_by="u1", force=force, store=self.store, dispatch=self.dispatch
        )

    async def run(self, job: tuple[str, int, str, str]) -> str:
        return await run_fact_check(
            *job,
            store=self.store,
            check=self.check,
            project_context=self.context,
            publish=self.publish,
        )

    def row(self) -> dict[str, Any]:
        (row,) = self.store.fact_checks.values()
        return row


@pytest.fixture(autouse=True)
def _quiet_service_events(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = []

    async def _publish(project_id: str, event: dict[str, Any]) -> None:
        events.append((project_id, event))

    monkeypatch.setattr(service, "publish_map_event", _publish)
    return events


# ── state shapes ────────────────────────────────────────────────────────


def test_fact_check_state_shapes() -> None:
    at = datetime(2026, 9, 15, 12, 30, tzinfo=timezone.utc)
    assert fact_check_state(None) == {"status": "idle"}
    assert fact_check_state({"status": "idle"}) == {"status": "idle"}
    assert fact_check_state({"status": "surprising"}) == {"status": "idle"}
    assert fact_check_state({"status": "processing", "started_at": at}) == {
        "status": "processing",
        "startedAt": at.isoformat(),
    }
    assert fact_check_state(
        {"status": "done", "verdict": None, "justification": None, "sources": None, "completed_at": at}
    ) == {"status": "done", "verdict": "unknown", "justification": "", "sources": [], "checkedAt": at.isoformat()}
    assert fact_check_state(
        {"status": "done", "verdict": "contested", "justification": "J", "sources": [{"url": "u"}], "completed_at": "2026"}
    ) == {"status": "done", "verdict": "contested", "justification": "J", "sources": [{"url": "u"}], "checkedAt": "2026"}
    assert fact_check_state(
        {"status": "error", "error": None, "completed_at": None, "updated_at": at}
    ) == {"status": "error", "message": "The fact-check failed.", "at": at.isoformat()}


# ── running a check ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_check_writes_done_for_the_current_attempt(_quiet_service_events: list) -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())

    state = await harness.start(result)
    assert state["status"] == "processing"
    assert harness.dispatched == [(harness.row()["id"], 1, result["id"], "a-claim")]
    assert _quiet_service_events == [
        (PROJECT, {"type": "fact_check", "claim_key": harness.row()["claim_key"]})
    ]

    assert await harness.run(harness.dispatched[0]) == "done"

    row = harness.row()
    assert row["status"] == "done" and row["verdict"] == "false"
    assert row["sources"] == [{"url": "https://archive.example", "title": "Archive"}]
    assert row["model"] == model.model_identity()
    assert row["prompt_version"] == model.FACTCHECK_PROMPT_VERSION
    assert harness.checks == [
        {
            "statement": CLAIM,
            "evidence": QUOTES,
            "project_name": "Harbour",
            "project_context": "A plan for the old harbour.",
        }
    ]
    assert harness.events == [(PROJECT, {"type": "fact_check", "claim_key": row["claim_key"]})]
    states = await service.fact_check_states(result, store)
    assert list(states) == ["a-claim"]
    assert states["a-claim"]["status"] == "done"
    assert states["a-claim"]["verdict"] == "false"


@pytest.mark.asyncio
async def test_a_job_for_another_attempt_is_stale_and_changes_nothing() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())
    await harness.start(result)
    fact_check_id, attempt, result_id, node_id = harness.dispatched[0]

    assert await harness.run((fact_check_id, attempt + 1, result_id, node_id)) == "stale"
    assert await harness.run(("no-such-check", attempt, result_id, node_id)) == "stale"
    assert harness.checks == []
    assert harness.row()["status"] == "processing"


@pytest.mark.asyncio
async def test_cancelling_before_completion_makes_the_late_verdict_a_no_op() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())
    await harness.start(result)

    async def _cancel_meanwhile() -> None:
        state = await service.cancel_fact_check(result, "a-claim", store=store)
        assert state == {"status": "idle"}

    harness.during_check = _cancel_meanwhile

    assert await harness.run(harness.dispatched[0]) == "stale"

    row = harness.row()
    assert row["status"] == "idle" and row["attempt"] == 2 and row["verdict"] is None
    assert harness.events == []
    assert (await service.fact_check_states(result, store))["a-claim"] == {"status": "idle"}


@pytest.mark.asyncio
async def test_a_cancelled_check_never_runs() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())
    await harness.start(result)
    await service.cancel_fact_check(result, "a-claim", store=store)

    assert await harness.run(harness.dispatched[0]) == "stale"
    assert harness.checks == []


@pytest.mark.asyncio
async def test_a_check_error_is_an_error_state_not_an_unknown_verdict() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())
    await harness.start(result)
    harness.error = RuntimeError("search grounding unavailable")

    assert await harness.run(harness.dispatched[0]) == "error"

    row = harness.row()
    assert row["status"] == "error" and row["verdict"] is None
    assert row["error"] == "The fact-check could not finish. Try again."
    state = (await service.fact_check_states(result, store))["a-claim"]
    assert state["status"] == "error" and "verdict" not in state
    assert len(harness.events) == 1

    # An error restarts without force.
    harness.error = None
    assert (await harness.start(result))["status"] == "processing"
    assert [job[1] for job in harness.dispatched] == [1, 2]
    assert await harness.run(harness.dispatched[1]) == "done"


@pytest.mark.asyncio
async def test_a_claim_that_no_longer_matches_its_map_fails_with_a_message() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())
    await harness.start(result)
    store.results[result["id"]]["manifest"]["arguments"][0]["claim_key"] = "a-different-revision"

    assert await harness.run(harness.dispatched[0]) == "error"
    assert harness.row()["error"] == "The claim is no longer part of this map."
    assert harness.checks == []


@pytest.mark.asyncio
async def test_a_check_against_a_missing_node_or_another_projects_result_fails() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())
    foreign = await ready_result(store, _arguments(), project_id=OTHER_PROJECT)

    await harness.start(result)
    fact_check_id, attempt, _result_id, _node = harness.dispatched[0]
    assert await harness.run((fact_check_id, attempt, foreign["id"], "a-claim")) == "error"

    await harness.start(result)  # the error restarts
    fact_check_id, attempt, result_id, _node = harness.dispatched[1]
    assert await harness.run((fact_check_id, attempt, result_id, "a-missing")) == "error"
    assert harness.checks == []


@pytest.mark.asyncio
async def test_mark_interrupted_writes_an_error_for_that_attempt_only() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())
    await harness.start(result)
    fact_check_id, attempt, _r, _n = harness.dispatched[0]

    assert await mark_interrupted(fact_check_id, attempt + 1, store=store) is False
    assert harness.row()["status"] == "processing"
    assert await mark_interrupted(fact_check_id, attempt, store=store) is True
    assert harness.row()["status"] == "error"
    assert harness.row()["error"] == "The fact-check was interrupted. Try again."
    assert await mark_interrupted(fact_check_id, attempt, store=store) is False


# ── starting from the service ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_second_start_while_processing_dispatches_nothing() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())

    first = await harness.start(result)
    second = await harness.start(result)

    assert first["status"] == second["status"] == "processing"
    assert len(harness.dispatched) == 1
    assert harness.row()["attempt"] == 1


@pytest.mark.asyncio
async def test_a_finished_check_is_only_rechecked_with_force() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())
    await harness.start(result)
    await harness.run(harness.dispatched[0])

    unforced = await harness.start(result)
    assert unforced["status"] == "done" and len(harness.dispatched) == 1

    forced = await harness.start(result, force=True)
    assert forced["status"] == "processing"
    assert len(harness.dispatched) == 2 and harness.dispatched[1][1] == 2
    assert harness.row()["verdict"] is None


@pytest.mark.asyncio
async def test_a_stale_processing_check_restarts_and_its_old_worker_cannot_finish() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())
    await harness.start(result)

    store.clock.advance(STALE_SECONDS - 60)
    await harness.start(result)
    assert len(harness.dispatched) == 1

    store.clock.advance(120)
    assert (await harness.start(result))["status"] == "processing"
    assert len(harness.dispatched) == 2

    assert await harness.run(harness.dispatched[0]) == "stale"
    assert await harness.run(harness.dispatched[1]) == "done"


@pytest.mark.asyncio
async def test_a_dispatch_failure_leaves_a_retryable_error() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())

    def _broken(*args: Any) -> str:  # noqa: ARG001
        raise RuntimeError("broker down")

    with pytest.raises(RuntimeError):
        await service.start_fact_check(
            result, "a-claim", requested_by="u1", force=False, store=store, dispatch=_broken
        )
    assert harness.row()["status"] == "error"
    assert harness.row()["error"] == "The fact-check could not be started."
    assert (await harness.start(result))["status"] == "processing"


@pytest.mark.asyncio
async def test_a_changed_claim_does_not_inherit_the_old_verdict() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    first = await ready_result(store, _arguments())
    await harness.start(first)
    await harness.run(harness.dispatched[0])

    new_evidence = await ready_result(store, _arguments(quotes=["it opened in 1932, they say"]))
    new_statement = await ready_result(store, _arguments(statement="The bridge opened in 1933."))

    assert (await service.fact_check_states(new_evidence, store))["a-claim"] == {"status": "idle"}
    assert (await service.fact_check_states(new_statement, store))["a-claim"] == {"status": "idle"}
    assert (await service.fact_check_states(first, store))["a-claim"]["verdict"] == "false"


@pytest.mark.asyncio
async def test_only_claims_of_ready_maps_are_checked() -> None:
    store = FakeMapStore()
    harness = _Harness(store)
    result = await ready_result(store, _arguments())

    with pytest.raises(service.NotAClaim):
        await harness.start(result, node_id="a-arg")
    with pytest.raises(service.UnknownArguments):
        await harness.start(result, node_id="a-nope")
    running = await store.create_attempt(project_id=PROJECT, recipe_version="v", requested_by=None)
    with pytest.raises(service.NotReady):
        await harness.start(running)
    with pytest.raises(service.NotReady):
        await service.fact_check_states(running, store)
    assert harness.dispatched == []
