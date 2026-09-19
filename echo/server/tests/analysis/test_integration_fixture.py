"""The integration fixture recipe: an external-API-shaped payload built from
selected revisions through the shared lifecycle.

The point of these tests is what was *not* needed to add it. The recipe and its
output type are registered here exactly as a later real integration would
register them, and nothing in the executor, the store, the snapshot assembly or
the graph knows about them. So the tests assert the payload is produced,
validated, stored and inspectable, that it never reaches the map, and that
generating it touches no network.
"""

from __future__ import annotations

from typing import Any

import pytest

import dembrane.api.v2.bff.analysis as analysis_bff
from dembrane.analysis import types
from tests.analysis.fakes import FakeAnalysisStore
from tests.analysis.helpers import Recorder
from dembrane.analysis.budgets import Ceilings, resolve_budgets
from dembrane.analysis.hashing import content_hash
from dembrane.analysis.recipes import integration_fixture as delivery
from dembrane.analysis.executor import RunRequest, run_worker, request_run, execute_inline
from dembrane.analysis.map_view import MAP_TYPES, GraphQuery, graph_payload, map_producers
from dembrane.analysis.registry import register_recipe, unregister_recipe
from dembrane.analysis.contracts import RunStatus, RevisionStatus
from tests.analysis.map_v2_fakes import READ, Grants, MapWorld, asgi_call
from tests.analysis.producer_fakes import PROJECT, MERGED_RECORD, ProducerWorld, merge_all

SCOPE = "delivery:fixture-webhook"
BASE = "/api/v2/bff/analysis"


@pytest.fixture
def delivery_recipe() -> Any:
    register_recipe(delivery.RECIPE, replace=True)
    try:
        yield delivery.RECIPE
    finally:
        unregister_recipe(delivery.RECIPE_ID)


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every way out of this process, patched to record and refuse. The ASGI
    transport the API tests use is untouched, so this catches real egress
    only."""
    import httpx
    import litellm
    import requests.adapters

    calls: list[str] = []

    def refuse(name: str) -> Any:
        def blocked(*_args: Any, **_kwargs: Any) -> Any:
            calls.append(name)
            raise AssertionError(f"the recipe reached the network through {name}")

        return blocked

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse("httpx.async"))
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse("httpx.sync"))
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", refuse("requests"))
    for name in ("embedding", "aembedding", "completion", "acompletion"):
        if hasattr(litellm, name):
            monkeypatch.setattr(litellm, name, refuse(f"litellm.{name}"))
    return calls


async def _chain(store: FakeAnalysisStore, world: ProducerWorld, rec: Recorder) -> None:
    """Arguments, deduplicated arguments and tensions, published, so there is
    something of every input type to select."""
    world.verifier = merge_all(MERGED_RECORD)
    outcome = await execute_inline(
        RunRequest(PROJECT, "tensions", "project", parameters={"input_set": "deduplicated_arguments"},
                   idempotency_key="chain"),
        store=store,
        deps=world.deps(rec),
    )
    assert outcome.run.status == RunStatus.READY, outcome.run.error


def _published(store: FakeAnalysisStore, type_id: str) -> list[Any]:
    return sorted(
        (r for r in store.revisions.values() if r.type == type_id and r.status == RevisionStatus.PUBLISHED),
        key=lambda r: r.id,
    )


def _selection(store: FakeAnalysisStore) -> tuple[str, ...]:
    """One revision of each input type."""
    chosen = [
        _published(store, "argument")[0],
        _published(store, "deduplicated_argument")[0],
        _published(store, "tension")[0],
    ]
    return tuple(r.id for r in chosen)


async def _deliver(
    store: FakeAnalysisStore,
    world: ProducerWorld,
    rec: Recorder,
    selection: tuple[str, ...],
    *,
    key: str,
    parameters: dict[str, Any] | None = None,
    scope: str = SCOPE,
) -> Any:
    return await request_run(
        RunRequest(
            PROJECT,
            delivery.RECIPE_ID,
            scope,
            parameters=parameters or {},
            selected_revision_ids=selection,
            idempotency_key=key,
        ),
        store=store,
        deps=world.deps(rec),
    )


@pytest.mark.asyncio
async def test_selected_revisions_become_a_schema_validated_request_body(delivery_recipe: Any) -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    await _chain(store, world, rec)
    selection = _selection(store)
    model_calls, embeds = world.model_calls(), len(world.embed_calls)

    outcome = await _deliver(store, world, rec, selection, key="d1")
    assert await run_worker(outcome.run.id, store=store, deps=world.deps(rec)) == "ready"

    run = await store.get_run(outcome.run.id)
    assert run is not None and run.output_manifest is not None
    (entry,) = run.output_manifest["objects"]
    assert entry["type"] == delivery.PAYLOAD_TYPE
    payload = store.revisions[entry["revisionId"]].payload

    # The stored payload is exactly what the declared schema accepts.
    assert types.validate_payload(delivery.PAYLOAD_TYPE, payload) == payload
    body = payload["body"]
    assert (payload["endpoint"], payload["method"]) == (delivery.ENDPOINT, "POST")
    assert body["destination"] == "fixture-webhook" and body["projectId"] == PROJECT
    assert body["counts"] == {"argument": 1, "deduplicated_argument": 1, "tension": 1}
    assert {item["revision"]["revisionId"] for item in body["items"]} == set(selection)
    assert all(item["title"] and item["body"] for item in body["items"])

    # Each item carries the recipe that produced the revision it stands for.
    recipes = {item["type"]: item["revision"]["recipeId"] for item in body["items"]}
    assert recipes == {
        "argument": "arguments",
        "deduplicated_argument": "deduplicated_arguments",
        "tension": "tensions",
    }
    # The delivery key is the body's own content, so a repeat is recognisable.
    assert body["idempotencyKey"] == content_hash({k: v for k, v in body.items() if k != "idempotencyKey"})

    # Built, not sent, and nothing was generated or embedded for it.
    assert world.model_calls() == model_calls and len(world.embed_calls) == embeds
    assert run.metrics.get("modelCalls", 0) == 0 and run.metrics["deliveryItems"] == 3
    assert store.revisions[entry["revisionId"]].embedding_refs is None
    steps = {s.step_key: s for s in await store.get_steps(run.id)}
    assert sorted(steps) == ["collect", "render", "validate"]
    assert all(s.usage.get("modelCalls", 0) == 0 for s in steps.values())
    assert any(c["check"] == "body-matches-destination" and c["status"] == "passed" for c in run.checks)


@pytest.mark.asyncio
async def test_generating_the_payload_makes_no_outbound_request(
    delivery_recipe: Any, no_network: list[str]
) -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    await _chain(store, world, rec)
    selection = _selection(store)

    outcome = await _deliver(store, world, rec, selection, key="d1")
    assert await run_worker(outcome.run.id, store=store, deps=world.deps(rec)) == "ready"

    assert no_network == []
    # Structurally, not just in this run: the recipe declares no model step, so
    # there is no stage in it that could call a provider.
    assert [s.kind for s in delivery.RECIPE.steps if str(s.kind) == "model"] == []


@pytest.mark.asyncio
async def test_the_payload_has_no_graph_projection_and_never_reaches_the_map(delivery_recipe: Any) -> None:
    world, rec = ProducerWorld.recording_debate(), Recorder()
    maps = MapWorld()
    await _chain(maps.store, world, rec)
    selection = _selection(maps.store)
    outcome = await _deliver(maps.store, world, rec, selection, key="d1")
    assert await run_worker(outcome.run.id, store=maps.store, deps=world.deps(rec)) == "ready"

    assert delivery.PAYLOAD_TYPE not in MAP_TYPES
    assert types.get_object_type(delivery.PAYLOAD_TYPE).map is None

    snapshot = await maps.advance(PROJECT)
    producers = {p["recipeId"] for p in snapshot.manifest["producers"]}
    assert delivery.RECIPE_ID not in producers
    assert [h.recipe_id for h in await map_producers(PROJECT, reads=maps.reads) if h.recipe_id == delivery.RECIPE_ID] == []
    assert delivery.PAYLOAD_TYPE not in {o["type"] for o in snapshot.manifest["objects"]}

    graph = await graph_payload(
        snapshot, GraphQuery(types=None, scope=None, budgets=resolve_budgets(ceilings=Ceilings())), store=maps.store
    )
    assert delivery.PAYLOAD_TYPE not in graph["counts"]
    assert all(node["type"] in MAP_TYPES for node in graph["nodes"])
    assert graph["unplaced"] == [] or delivery.PAYLOAD_TYPE not in {n["type"] for n in graph["nodes"]}


@pytest.mark.asyncio
async def test_the_payload_is_inspectable_as_json_through_the_runs_api(
    delivery_recipe: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    world, rec = ProducerWorld.recording_debate(), Recorder()
    maps = MapWorld()
    await _chain(maps.store, world, rec)
    selection = _selection(maps.store)
    outcome = await _deliver(maps.store, world, rec, selection, key="d1")
    assert await run_worker(outcome.run.id, store=maps.store, deps=world.deps(rec)) == "ready"

    grants = Grants()
    grants.grant(PROJECT, *READ)
    monkeypatch.setattr(analysis_bff, "resolve_project_access", grants.resolve)
    monkeypatch.setattr(analysis_bff, "get_store", lambda: maps.store)
    monkeypatch.setattr(analysis_bff, "get_reads", lambda: maps.reads)

    listed = await asgi_call(analysis_bff.router, BASE, "GET", "/recipes")
    entry = next(r for r in listed.json()["recipes"] if r["id"] == delivery.RECIPE_ID)
    assert [s["key"] for s in entry["steps"]] == ["collect", "render", "validate"]
    assert entry["outputSchemas"][delivery.PAYLOAD_TYPE]["mapCapable"] is False

    inspected = await asgi_call(analysis_bff.router, BASE, "GET", f"/runs/{outcome.run.id}")
    assert inspected.status_code == 200
    doc = inspected.json()["run"]
    assert doc["recipeId"] == delivery.RECIPE_ID and doc["status"] == "ready"
    assert doc["output"]["objects"] == 1 and doc["inputs"]["selectedRevisionIds"] == sorted(selection)
    assert [s["key"] for s in doc["steps"]] == ["collect", "render", "validate"]
    assert any(c["check"] == "body-matches-destination" for c in doc["checks"])

    # It is inspected as a run, not as a map object: the objects listing is the
    # map's, and this type is not one of its types.
    refused = await asgi_call(
        analysis_bff.router, BASE, "GET", f"/projects/{PROJECT}/objects", params={"type": delivery.PAYLOAD_TYPE}
    )
    assert refused.status_code == 422


@pytest.mark.asyncio
async def test_an_unchanged_selection_reuses_and_an_oversized_one_fails_its_check(delivery_recipe: Any) -> None:
    world, store, rec = ProducerWorld.recording_debate(), FakeAnalysisStore(), Recorder()
    await _chain(store, world, rec)
    selection = _selection(store)
    first = await _deliver(store, world, rec, selection, key="d1")
    assert await run_worker(first.run.id, store=store, deps=world.deps(rec)) == "ready"
    ready = await store.get_run(first.run.id)
    assert ready is not None

    again = await _deliver(store, world, rec, selection, key="d2")
    assert again.outcome == "reused" and again.run.reused_run_id == first.run.id
    assert again.run.output_manifest == ready.output_manifest
    payloads = _published(store, delivery.PAYLOAD_TYPE)
    assert len(payloads) == 1

    # A destination that accepts fewer items than were selected is a failed
    # check, never a body quietly cut to fit. The ready output stays current.
    over = await _deliver(store, world, rec, selection, key="d3", parameters={"max_items": 1})
    assert await run_worker(over.run.id, store=store, deps=world.deps(rec)) == "failed"
    failed = await store.get_run(over.run.id)
    assert failed is not None and failed.status == RunStatus.FAILED
    assert any(
        c["check"] == "body-matches-destination" and c["status"] == "failed" and c["evidence"]["items"] == 3
        for c in failed.checks
    )
    # The reuse run is the scope's current one (it fences older requests) and
    # it carries the first run's manifest; the failed run changed neither.
    scope = await store.get_scope(failed.scope_id)
    assert scope is not None and scope.current_run_id == again.run.id
    assert _published(store, delivery.PAYLOAD_TYPE) == payloads
