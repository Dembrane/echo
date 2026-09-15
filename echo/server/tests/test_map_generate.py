"""Map generation end to end, on an in-memory store and scripted model calls."""

from __future__ import annotations

import json
from typing import Any

import pytest

from dembrane.map import recipe, service
from tests.map_fakes import (
    PROJECT,
    FakeMapStore,
    FakeGenerationWorld,
    item,
    transcript,
)
from dembrane.map.store import ActiveAttemptExists
from dembrane.map.generate import run_generation

BIKES = "We need more bike lanes in the city centre."
PARKING = "Parking fees are too high for families."
BRIDGE = "The bridge was built in 1932."


def _world(store: FakeMapStore) -> FakeGenerationWorld:
    return FakeGenerationWorld(
        [
            transcript(
                "c1",
                "Ann: We need more bike lanes in the city centre.\n"
                "Ann: Parking fees are far too high for young families.",
                label="Ann",
            ),
            transcript(
                "c2",
                "Bob: we need more bike lanes in the city centre!\n"
                "Bob: The old bridge was built in 1932 by the province.",
                label="Bob",
            ),
        ],
        {
            "c1": [
                item(BIKES, "We need more bike lanes in the city centre"),
                item(PARKING, "parking fees are far too high for young families", valence="negative"),
            ],
            "c2": [
                item(BIKES, "we need more bike lanes"),
                item(BRIDGE, "the old bridge was built in 1932", kind="claim", valence="neutral"),
            ],
        },
        clock=store.clock,
    )


async def _attempt(store: FakeMapStore) -> str:
    row = await store.create_attempt(
        project_id=PROJECT, recipe_version=recipe.RECIPE_VERSION, requested_by="u1"
    )
    return row["id"]


async def _generate(store: FakeMapStore, world: FakeGenerationWorld) -> tuple[str, str]:
    result_id = await _attempt(store)
    return result_id, await run_generation(result_id, store=store, deps=world.deps())


@pytest.fixture(autouse=True)
def _quiet_service_events(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _publish(project_id: str, event: dict[str, Any]) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(service, "publish_map_event", _publish)


async def _requeue(store: FakeMapStore) -> dict[str, Any]:
    dispatched: list[str] = []

    def _dispatch(result_id: str) -> str:
        dispatched.append(result_id)
        return f"msg-{len(dispatched)}"

    row = await service.request_generation(PROJECT, "u1", store=store, dispatch=_dispatch)
    assert dispatched == [row["id"]]
    return row


def _embedding_ids(manifest: dict[str, Any]) -> dict[str, str]:
    return {a["statement"]: a["embedding_id"] for a in manifest["arguments"]}


# ── the happy path ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_generation_publishes_a_ready_manifest_with_progress_then_ready() -> None:
    store = FakeMapStore()
    world = _world(store)

    result_id, outcome = await _generate(store, world)

    assert outcome == "ready"
    row = store.results[result_id]
    assert row["status"] == "ready"
    assert row["source_fingerprint"] == recipe.source_fingerprint(world.transcripts)
    assert row["embedding_config"] == world.identity().as_config()
    manifest = row["manifest"]
    assert [a["statement"] for a in manifest["arguments"]] == [BIKES, PARKING, BRIDGE]
    bikes, parking, bridge = manifest["arguments"]
    assert [e["conversation_id"] for e in bikes["evidence"]] == ["c1", "c2"]
    assert bikes["claim_key"] is None and parking["valence"] == "negative"
    assert bridge["claim_key"] == recipe.claim_key(BRIDGE, ["the old bridge was built in 1932"])
    assert all(a["embedding_id"] in store.embeddings for a in manifest["arguments"])
    assert manifest["stats"]["candidates"] == 4
    assert manifest["stats"]["merged"] == 1
    assert manifest["stats"]["embeddings_new"] == 3
    assert manifest["stats"]["usage"]["total_tokens"] == 240

    types = world.event_types()
    assert types[0] == "progress" and types[-1] == "ready"
    assert set(types[:-1]) == {"progress"}
    stages = [event.get("stage") for _p, event in world.events if event["type"] == "progress"]
    assert stages[0] == "extracting" and "embedding" in stages
    assert sorted(world.embed_calls) == sorted([BIKES, PARKING, BRIDGE])
    assert world.probe_calls == 1
    assert row["progress"]["stage"] == "ready"
    assert "extractions" not in row["progress"]


@pytest.mark.asyncio
async def test_an_inactive_attempt_is_skipped() -> None:
    store = FakeMapStore()
    world = _world(store)
    result_id, _ = await _generate(store, world)

    assert await run_generation(result_id, store=store, deps=world.deps()) == "skipped"
    assert await run_generation("missing", store=store, deps=world.deps()) == "skipped"
    assert world.probe_calls == 1


@pytest.mark.asyncio
async def test_only_one_attempt_is_active_per_project() -> None:
    store = FakeMapStore()
    first = await _attempt(store)
    with pytest.raises(ActiveAttemptExists) as raised:
        await _attempt(store)
    assert raised.value.row is not None and raised.value.row["id"] == first


@pytest.mark.asyncio
async def test_an_empty_project_publishes_a_ready_map_without_arguments() -> None:
    store = FakeMapStore()
    world = FakeGenerationWorld([], {}, clock=store.clock)

    result_id, outcome = await _generate(store, world)

    assert outcome == "ready"
    assert store.results[result_id]["manifest"]["arguments"] == []
    assert world.extract_calls == {} and world.embed_calls == []


# ── resuming and reuse ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_failed_extraction_fails_the_attempt_and_resume_reuses_finished_conversations() -> None:
    store = FakeMapStore()
    world = _world(store)
    world.fail_extract = {"c2"}

    result_id, outcome = await _generate(store, world)

    assert outcome == "failed"
    row = store.results[result_id]
    assert row["status"] == "failed"
    assert row["error"] == "Reading 1 of 2 conversations failed."
    assert row["manifest"] is None
    assert list(row["progress"]["extractions"]) == ["c1"]
    assert world.event_types()[-1] == "failed"
    assert world.embed_calls == []

    world.fail_extract = set()
    requeued = await _requeue(store)
    assert requeued["id"] == result_id and requeued["status"] == "queued"

    assert await run_generation(result_id, store=store, deps=world.deps()) == "ready"
    assert world.extract_calls == {"c1": 1, "c2": 2}
    assert store.results[result_id]["manifest"]["stats"]["conversations_resumed"] == 1


@pytest.mark.asyncio
async def test_a_failed_vector_write_fails_the_attempt_and_resume_reuses_saved_vectors() -> None:
    store = FakeMapStore()
    world = _world(store)
    store.fail_save_embedding_on = 2

    result_id, outcome = await _generate(store, world)

    assert outcome == "failed"
    row = store.results[result_id]
    assert row["status"] == "failed"
    assert row["error"] == "Saving the map failed."
    assert row["manifest"] is None
    assert await store.latest_ready(PROJECT) is None
    # Writes that landed before the failure stay saved (tasks already running
    # when the TaskGroup cancels may finish theirs).
    saved = len(store.embeddings)
    assert 1 <= saved < 3
    calls_before = len(world.embed_calls)

    store.fail_save_embedding_on = None
    await _requeue(store)
    assert await run_generation(result_id, store=store, deps=world.deps()) == "ready"

    assert len(world.embed_calls) - calls_before == 3 - saved
    assert world.extract_calls == {"c1": 1, "c2": 1}
    stats = store.results[result_id]["manifest"]["stats"]
    assert stats["embeddings_reused"] == saved
    assert stats["embeddings_new"] == 3 - saved
    assert len(store.embeddings) == 3


@pytest.mark.asyncio
async def test_a_second_revision_of_unchanged_text_reuses_every_vector() -> None:
    store = FakeMapStore()
    world = _world(store)
    first_id, _ = await _generate(store, world)
    embed_calls = len(world.embed_calls)

    second_id, outcome = await _generate(store, world)

    assert outcome == "ready"
    assert len(world.embed_calls) == embed_calls
    first = store.results[first_id]["manifest"]
    second = store.results[second_id]["manifest"]
    assert _embedding_ids(first) == _embedding_ids(second)
    assert second["stats"]["embeddings_reused"] == 3
    assert (await store.latest_ready(PROJECT))["id"] == second_id


@pytest.mark.asyncio
async def test_changed_text_gets_new_rows_without_touching_old_ones() -> None:
    store = FakeMapStore()
    world = _world(store)
    first_id, _ = await _generate(store, world)
    before = {key: dict(row) for key, row in store.embeddings.items()}
    calls = len(world.embed_calls)

    changed = "Parking fees are far too high for young families."
    world.items["c1"][1] = item(changed, "parking fees are far too high", valence="negative")
    second_id, outcome = await _generate(store, world)

    assert outcome == "ready"
    assert world.embed_calls[calls:] == [changed]
    assert len(store.embeddings) == len(before) + 1
    for key, row in before.items():
        assert store.embeddings[key] == row
    old_ids = set(_embedding_ids(store.results[first_id]["manifest"]).values())
    assert old_ids <= set(store.embeddings)


@pytest.mark.asyncio
async def test_a_different_embedding_identity_gets_new_rows_and_keeps_the_old_ones() -> None:
    store = FakeMapStore()
    world = _world(store)
    first_id, _ = await _generate(store, world)
    before = {key: dict(row) for key, row in store.embeddings.items()}
    calls = len(world.embed_calls)

    world.model = "fake/another-model"
    world.dims = 5
    second_id, outcome = await _generate(store, world)

    assert outcome == "ready"
    assert len(world.embed_calls) - calls == 3
    assert len(store.embeddings) == 6
    for key, row in before.items():
        assert store.embeddings[key] == row
    second = store.results[second_id]
    assert second["embedding_config"]["dims"] == 5
    new_ids = set(_embedding_ids(second["manifest"]).values())
    assert new_ids.isdisjoint(before)
    assert {store.embeddings[i]["dims"] for i in new_ids} == {5}
    assert store.results[first_id]["manifest"]["arguments"][0]["embedding_id"] in store.embeddings


@pytest.mark.asyncio
async def test_a_failed_vector_write_leaves_the_previous_revision_current() -> None:
    store = FakeMapStore()
    world = _world(store)
    first_id, _ = await _generate(store, world)

    world.items["c2"][1] = item(
        "The bridge was built by the province.", "built in 1932 by the province", kind="claim", valence="neutral"
    )
    store.fail_save_embedding_on = store.calls["save_embedding"] + 1
    second_id, outcome = await _generate(store, world)

    assert outcome == "failed"
    assert store.results[second_id]["status"] == "failed"
    assert store.results[second_id]["manifest"] is None
    current = await store.latest_ready(PROJECT)
    assert current is not None and current["id"] == first_id
    state = await service.project_state(PROJECT, store)
    assert state["current"]["id"] == first_id
    assert state["attempt"]["id"] == second_id and state["attempt"]["status"] == "failed"


# ── vectors that must never be saved ────────────────────────────────────


@pytest.mark.parametrize(
    "bad",
    [
        lambda dims: [float("nan")] * dims,
        lambda dims: [0.0] * dims,
        lambda dims: [0.5] * (dims + 1),
        lambda dims: [0.5] * (dims - 1),
        lambda dims: "not a vector",  # noqa: ARG005
    ],
    ids=["nan", "zero", "too-long", "too-short", "not-a-list"],
)
@pytest.mark.asyncio
async def test_unusable_vectors_fail_the_attempt_and_are_never_saved(bad: Any) -> None:
    store = FakeMapStore()
    world = _world(store)
    world.vector_for = lambda text: bad(world.dims)  # noqa: ARG005

    result_id, outcome = await _generate(store, world)

    assert outcome == "failed"
    assert store.results[result_id]["error"] == "The embedding service returned an unusable vector."
    assert store.results[result_id]["manifest"] is None
    assert store.embeddings == {}
    assert store.calls["save_embedding"] == 0


# ── stopping and superseding ────────────────────────────────────────────


# Heartbeat 1 starts extraction, 2 and 3 land inside the extraction tasks,
# 4 starts embedding.
@pytest.mark.parametrize("expire_on", [1, 2, 4])
@pytest.mark.asyncio
async def test_an_attempt_that_stops_being_active_stops_without_publishing(expire_on: int) -> None:
    store = FakeMapStore()
    world = _world(store)
    store.expire_on_heartbeat = expire_on

    result_id, outcome = await _generate(store, world)

    assert outcome == "stopped"
    assert store.calls["publish"] == 0
    assert store.results[result_id]["manifest"] is None
    assert not {"ready", "failed", "superseded"} & set(world.event_types())
    assert store.calls["fail"] == 0


@pytest.mark.asyncio
async def test_an_older_attempt_finishing_after_a_newer_ready_is_superseded() -> None:
    store = FakeMapStore()
    world = _world(store)
    older = await _attempt(store)
    store.results[older]["status"] = "failed"  # out of the way while the newer one runs
    newer, outcome = await _generate(store, world)
    assert outcome == "ready"

    store.results[older]["status"] = "embedding"  # the older worker is still going
    assert await run_generation(older, store=store, deps=world.deps()) == "superseded"

    assert store.results[older]["status"] == "superseded"
    assert store.results[older]["manifest"] is None
    assert (await store.latest_ready(PROJECT))["id"] == newer
    assert world.event_types()[-1] == "superseded"


# ── what progress and errors may carry ──────────────────────────────────


def _keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


@pytest.mark.asyncio
async def test_progress_carries_candidates_but_never_transcript_bodies() -> None:
    store = FakeMapStore()
    world = _world(store)
    await _generate(store, world)

    assert store.heartbeats
    for progress in store.heartbeats:
        dumped = json.dumps(progress)
        for t in world.transcripts:
            assert t.text not in dumped
        assert not {"text", "transcript", "window"} & _keys(progress)
        for entry in (progress.get("extractions") or {}).values():
            assert set(entry) == {"text_hash", "windows", "dropped", "usage", "candidates"}
    for _project, event in world.events:
        assert "extractions" not in event
        assert "candidates" not in json.dumps(event)


@pytest.mark.asyncio
async def test_failure_messages_carry_no_statement_text() -> None:
    store = FakeMapStore()
    world = _world(store)
    world.fail_extract = {"c1"}
    world.extract_error = lambda cid: RuntimeError(f"{cid}: {BIKES}")
    result_id, outcome = await _generate(store, world)
    assert outcome == "failed"
    assert BIKES not in store.results[result_id]["error"]

    other = FakeMapStore()
    world = _world(other)
    world.embed_error = ValueError(f"provider refused: {PARKING}")
    result_id, outcome = await _generate(other, world)
    assert outcome == "failed"
    assert other.results[result_id]["error"] == "Generating the map failed."
    assert all(PARKING not in json.dumps(event) for _p, event in world.events)
