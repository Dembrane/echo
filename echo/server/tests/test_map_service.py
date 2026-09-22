"""Map as the API uses it: page state, generation requests and selection titles."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

import dembrane.map.model as map_model
from dembrane.map import recipe, service
from tests.map_fakes import (
    PROJECT,
    OTHER_PROJECT,
    FakeMapStore,
    FakeAsyncRedis,
    ready_result,
    manifest_argument,
)
from dembrane.map.store import ActiveAttemptExists, lease_of


@pytest.fixture(autouse=True)
def events(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    recorded: list[tuple[str, dict[str, Any]]] = []

    async def _publish(project_id: str, event: dict[str, Any]) -> None:
        recorded.append((project_id, event))

    monkeypatch.setattr(service, "publish_map_event", _publish)
    return recorded


class _Dispatch:
    def __init__(self, error: BaseException | None = None) -> None:
        self.sent: list[str] = []
        self.error = error

    def __call__(self, result_id: str) -> str:
        if self.error is not None:
            raise self.error
        self.sent.append(result_id)
        return f"msg-{len(self.sent)}"


def _arguments() -> list[dict[str, Any]]:
    return [
        manifest_argument("a-1", "Trams are quieter than buses."),
        manifest_argument("a-2", "Trams cost too much to build.", valence="negative"),
        manifest_argument("a-3", "The tram line cost 400 million euros.", kind="claim", valence="neutral"),
        manifest_argument("a-4", "Buses reach more neighbourhoods."),
    ]


async def _attempt(store: FakeMapStore, project_id: str = PROJECT) -> dict[str, Any]:
    return await store.create_attempt(
        project_id=project_id, recipe_version=recipe.RECIPE_VERSION, requested_by="u1"
    )


# ── project state ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_project_state_of_a_project_without_maps() -> None:
    assert await service.project_state(PROJECT, FakeMapStore()) == {"current": None, "attempt": None}


@pytest.mark.asyncio
async def test_project_state_shows_a_newer_running_attempt_with_filtered_progress() -> None:
    store = FakeMapStore()
    current = await ready_result(store, _arguments())
    running = await _attempt(store)
    await store.heartbeat(
        running["id"],
        lease=lease_of(running),
        status="extracting",
        progress={"stage": "extracting", "conversations_total": 3, "extractions": {"c1": {}}},
    )

    state = await service.project_state(PROJECT, store)

    assert state["current"]["id"] == current["id"]
    assert state["attempt"]["id"] == running["id"]
    assert state["attempt"]["status"] == "extracting"
    assert state["attempt"]["progress"] == {"stage": "extracting", "conversations_total": 3}


@pytest.mark.asyncio
async def test_project_state_shows_a_newer_failure_but_not_older_or_superseded_attempts() -> None:
    store = FakeMapStore()
    older = await _attempt(store)
    await store.fail(older["id"], "Saving the map failed.", lease=lease_of(older))
    current = await ready_result(store, _arguments())

    state = await service.project_state(PROJECT, store)
    assert state["current"]["id"] == current["id"] and state["attempt"] is None

    newer = await _attempt(store)
    await store.fail(newer["id"], "Reading 1 of 2 conversations failed.", lease=lease_of(newer))
    state = await service.project_state(PROJECT, store)
    assert state["attempt"]["id"] == newer["id"]
    assert state["attempt"]["error"] == "Reading 1 of 2 conversations failed."

    superseded = await _attempt(store)
    store.results[superseded["id"]]["status"] = "superseded"
    assert (await service.project_state(PROJECT, store))["attempt"] is None

    await _attempt(store, OTHER_PROJECT)
    assert (await service.project_state(PROJECT, store))["attempt"] is None


@pytest.mark.asyncio
async def test_project_state_expires_an_attempt_whose_worker_went_quiet() -> None:
    store = FakeMapStore()
    running = await _attempt(store)
    store.clock.advance(service.STALE_ATTEMPT_SECONDS + 1)

    state = await service.project_state(PROJECT, store)

    assert state["attempt"]["id"] == running["id"]
    assert state["attempt"]["status"] == "failed"
    assert state["attempt"]["error"] == "The generation stopped without finishing."


@pytest.mark.asyncio
async def test_result_payload_reads_stored_vectors_and_lists_missing_ones(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _no_embedding(*args: Any, **kwargs: Any) -> Any:  # noqa: ARG001
        raise AssertionError("reading a map must never embed")

    monkeypatch.setattr("dembrane.embedding.embed_text", _no_embedding)
    monkeypatch.setattr("dembrane.map.generate.default_deps", _no_embedding)
    store = FakeMapStore()
    arguments = _arguments()
    arguments[3]["embedding_id"] = "00000000-0000-4000-8000-000000000000"
    row = await ready_result(store, arguments)
    store.results[row["id"]]["embedding_config"] = {"model": "m", "dims": 4, "key": "k", "endpoint": "e"}
    row = await store.get_result(row["id"])
    assert row is not None

    payload = await service.result_payload(row, store)

    assert store.calls["vectors_by_ids"] == 1
    assert payload["missing_embeddings"] == ["a-4"]
    assert payload["embedding"] == {"model": "m", "dims": 4, "key": "k"}
    shaped = {a["id"]: a for a in payload["arguments"]}
    assert shaped["a-4"]["embedding"] is None
    stored = store.embeddings[arguments[0]["embedding_id"]]["embedding"]
    assert shaped["a-1"]["embedding"] == [round(v, 6) for v in stored]
    assert set(shaped["a-1"]) == {
        "id", "statement", "kind", "valence", "claim_key", "evidence", "created_at", "embedding"
    }
    assert shaped["a-3"]["claim_key"] == arguments[2]["claim_key"]


# ── generation requests ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_request_generation_creates_dispatches_and_announces(events: list) -> None:
    store = FakeMapStore()
    dispatch = _Dispatch()

    row = await service.request_generation(PROJECT, "u1", store=store, dispatch=dispatch)

    assert row["status"] == "queued" and row["recipe_version"] == recipe.RECIPE_VERSION
    assert dispatch.sent == [row["id"]]
    assert store.results[row["id"]]["execution_ref"] == "msg-1"
    assert events == [(PROJECT, {"type": "queued", "result_id": row["id"]})]


@pytest.mark.asyncio
async def test_request_generation_returns_the_running_attempt() -> None:
    store = FakeMapStore()
    running = await _attempt(store)
    dispatch = _Dispatch()

    row = await service.request_generation(PROJECT, "u2", store=store, dispatch=dispatch)

    assert row["id"] == running["id"]
    assert dispatch.sent == []
    assert store.calls["create_attempt"] == 1


@pytest.mark.asyncio
async def test_request_generation_returns_the_winner_of_a_race() -> None:
    store = FakeMapStore()
    winner = await _attempt(store)
    real_active = store.active_attempt
    seen = 0

    async def _not_yet(project_id: str) -> dict[str, Any] | None:
        nonlocal seen
        seen += 1
        return None if seen == 1 else await real_active(project_id)

    store.active_attempt = _not_yet  # type: ignore[method-assign]
    dispatch = _Dispatch()

    row = await service.request_generation(PROJECT, "u2", store=store, dispatch=dispatch)

    assert row["id"] == winner["id"]
    assert dispatch.sent == []


@pytest.mark.asyncio
async def test_a_dispatch_failure_marks_the_attempt_failed_and_reraises(events: list) -> None:
    store = FakeMapStore()

    with pytest.raises(RuntimeError):
        await service.request_generation(
            PROJECT, "u1", store=store, dispatch=_Dispatch(RuntimeError("broker down"))
        )

    (row,) = store.results.values()
    assert row["status"] == "failed"
    assert row["error"] == "The generation could not be started."
    assert events == []

    # Asking again resumes that attempt rather than starting a second one.
    dispatch = _Dispatch()
    again = await service.request_generation(PROJECT, "u1", store=store, dispatch=dispatch)
    assert again["id"] == row["id"] and len(store.results) == 1


@pytest.mark.asyncio
async def test_a_new_attempt_follows_a_ready_map_or_a_failure_of_another_recipe() -> None:
    store = FakeMapStore()
    current = await ready_result(store, _arguments())
    fresh = await service.request_generation(PROJECT, "u1", store=store, dispatch=_Dispatch())
    assert fresh["id"] != current["id"]

    store.results[fresh["id"]].update(status="failed", recipe_version="map-arguments-v0")
    newest = await service.request_generation(PROJECT, "u1", store=store, dispatch=_Dispatch())
    assert newest["id"] not in (current["id"], fresh["id"])
    assert store.results[fresh["id"]]["status"] == "failed"


def test_active_attempt_exists_carries_the_running_row() -> None:
    assert ActiveAttemptExists({"id": "r1"}).row == {"id": "r1"}


# ── selection titles ────────────────────────────────────────────────────


class _Titler:
    def __init__(self, title: str = "Trams against buses on cost and reach") -> None:
        self.title = title
        self.calls: list[dict[str, Any]] = []
        self.error: BaseException | None = None
        self.gate: asyncio.Event | None = None
        self.started = asyncio.Event()

    async def __call__(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        self.started.set()
        if self.gate is not None:
            await self.gate.wait()
        if self.error is not None:
            raise self.error
        return self.title


@pytest.fixture
def model_config(monkeypatch: pytest.MonkeyPatch) -> Any:
    def _set(name: str) -> None:
        monkeypatch.setattr(map_model, "model_identity", lambda: name)

    _set("fake-title-model")
    return _set


async def _title(
    row: dict[str, Any], ids: list[str], store: FakeMapStore, redis: FakeAsyncRedis, titler: _Titler
) -> dict[str, Any]:
    return await service.selection_title(
        row,
        ids,
        project_name="Harbour",
        project_context="Trams or buses.",
        store=store,
        redis=redis,
        generate=titler,
    )


@pytest.mark.asyncio
async def test_a_title_is_generated_once_per_selection_and_cached(model_config: Any) -> None:
    store = FakeMapStore()
    redis = FakeAsyncRedis()
    titler = _Titler()
    row = await ready_result(store, _arguments())
    claim_key = row["manifest"]["arguments"][2]["claim_key"]
    check, _ = await store.start_fact_check(
        project_id=PROJECT, claim_key=claim_key, statement="s", requested_by=None, force=False, stale_seconds=60
    )
    await store.complete_fact_check(
        check["id"], 1, verdict="true", justification="j", sources=[], model="m", prompt_version="p"
    )

    first = await _title(row, ["a-1", "a-2", "a-3"], store, redis, titler)
    second = await _title(row, ["a-3", "a-1", "a-2", "a-1"], store, redis, titler)

    assert first == {"title": titler.title, "cached": False}
    assert second == {"title": titler.title, "cached": True}
    assert len(titler.calls) == 1
    assert titler.calls[0]["lines"] == [
        "1. [argument] Trams are quieter than buses.",
        "2. [argument] Trams cost too much to build.",
        "3. [claim, true] The tram line cost 400 million euros.",
    ]
    assert titler.calls[0]["project_name"] == "Harbour"
    (key,) = redis.data
    assert key.startswith("map:title:") and redis.expiry[key] == service.TITLE_CACHE_SECONDS

    model_config("another-title-model")
    third = await _title(row, ["a-1", "a-2", "a-3"], store, redis, titler)
    assert third["cached"] is False and len(titler.calls) == 2

    other_revision = await ready_result(store, _arguments())
    await _title(other_revision, ["a-1", "a-2", "a-3"], store, redis, titler)
    assert len(titler.calls) == 3


@pytest.mark.asyncio
async def test_a_title_follows_a_finished_verdict_of_its_claims(model_config: Any) -> None:  # noqa: ARG001
    store = FakeMapStore()
    redis = FakeAsyncRedis()
    titler = _Titler()
    row = await ready_result(store, _arguments())
    ids = ["a-1", "a-2", "a-3"]
    claim_line = "The tram line cost 400 million euros."

    assert (await _title(row, ids, store, redis, titler))["cached"] is False
    assert titler.calls[0]["lines"][2] == f"3. [claim, unverified] {claim_line}"

    check, _ = await store.start_fact_check(
        project_id=PROJECT,
        claim_key=row["manifest"]["arguments"][2]["claim_key"],
        statement="s",
        requested_by=None,
        force=False,
        stale_seconds=60,
    )
    # A check still running is no verdict: the title stands.
    assert (await _title(row, ids, store, redis, titler))["cached"] is True

    await store.complete_fact_check(
        check["id"], 1, verdict="false", justification="j", sources=[], model="m", prompt_version="p"
    )
    changed = await _title(row, ids, store, redis, titler)

    assert changed["cached"] is False and len(titler.calls) == 2
    assert titler.calls[1]["lines"][2] == f"3. [claim, false] {claim_line}"
    assert (await _title(row, list(reversed(ids)), store, redis, titler))["cached"] is True
    # A selection without the claim keeps the title it had.
    assert (await _title(row, ["a-1", "a-2", "a-4"], store, redis, titler))["cached"] is False
    assert (await _title(row, ["a-4", "a-2", "a-1"], store, redis, titler))["cached"] is True


@pytest.mark.asyncio
async def test_concurrent_identical_title_requests_make_one_model_call(
    model_config: Any, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    real_sleep = asyncio.sleep

    async def _quick_sleep(seconds: float, *args: Any, **kwargs: Any) -> Any:  # noqa: ARG001
        return await real_sleep(0.005)

    store = FakeMapStore()
    redis = FakeAsyncRedis()
    titler = _Titler()
    titler.gate = asyncio.Event()
    row = await ready_result(store, _arguments())
    ids = ["a-1", "a-2", "a-4"]

    first = asyncio.create_task(_title(row, ids, store, redis, titler))
    await titler.started.wait()
    monkeypatch.setattr(service.asyncio, "sleep", _quick_sleep)
    second = asyncio.create_task(_title(row, list(reversed(ids)), store, redis, titler))
    await real_sleep(0.05)
    titler.gate.set()
    results = await asyncio.gather(first, second)

    assert len(titler.calls) == 1
    assert sorted(r["cached"] for r in results) == [False, True]
    assert {r["title"] for r in results} == {titler.title}
    assert not [key for key in redis.data if key.endswith(":lock")]


@pytest.mark.asyncio
async def test_a_failed_title_leaves_the_selection_retryable(model_config: Any) -> None:  # noqa: ARG001
    store = FakeMapStore()
    redis = FakeAsyncRedis()
    titler = _Titler()
    titler.error = RuntimeError("model unavailable")
    row = await ready_result(store, _arguments())

    with pytest.raises(RuntimeError):
        await _title(row, ["a-1", "a-2", "a-4"], store, redis, titler)
    assert redis.data == {}

    titler.error = None
    assert (await _title(row, ["a-1", "a-2", "a-4"], store, redis, titler))["cached"] is False


@pytest.mark.asyncio
async def test_titles_refuse_unknown_small_and_unready_selections(model_config: Any) -> None:  # noqa: ARG001
    store = FakeMapStore()
    redis = FakeAsyncRedis()
    titler = _Titler()
    row = await ready_result(store, _arguments())

    with pytest.raises(service.UnknownArguments):
        await _title(row, ["a-1", "a-2", "a-other"], store, redis, titler)
    with pytest.raises(recipe.SelectionTooSmall):
        await _title(row, ["a-1", "a-2", "a-2"], store, redis, titler)
    running = await _attempt(store)
    with pytest.raises(service.NotReady):
        await _title(running, ["a-1", "a-2", "a-3"], store, redis, titler)
    assert titler.calls == []
    assert redis.data == {}
