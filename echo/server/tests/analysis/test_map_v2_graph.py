"""Map payload v2: budgets counted before vectors, types, scope, unplaced
objects, relations between displayed revisions, stale support, embedding
configuration, and the graph route's access, validation and ETag."""

from __future__ import annotations

from typing import Any
from dataclasses import replace

import pytest

import dembrane.map.events as map_events
import dembrane.api.v2.bff.map as map_bff
from tests.map_fakes import PROJECT, OTHER_PROJECT, ready_result, manifest_argument
from dembrane.analysis.budgets import DEFAULT_NODE_LIMIT, Ceilings, resolve_budgets
from dembrane.analysis.map_view import (
    LEGACY_RECIPE_ID,
    GraphQuery,
    UnknownMapType,
    UnknownResultScope,
    parse_types,
    graph_payload,
)
from tests.analysis.map_v2_fakes import READ, Grants, Limiter, Counting, MapWorld, inline, asgi_call
from tests.analysis.fixture_recipes import PAIRS, WORDS, FixtureWorld

C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"
BASE = "/api/v2/bff/map"


def _query(types: tuple[str, ...] | None = ("argument",), *, node_limit: int | None = None, scope: str | None = None) -> GraphQuery:
    return GraphQuery(types=types, scope=scope, budgets=resolve_budgets(node_limit, None, ceilings=Ceilings()))


async def _words(maps: MapWorld, world: FixtureWorld, count: int) -> Any:
    world.sources[PROJECT] = {C1: [f"Statement number {index}." for index in range(count)]}
    await inline(maps.store, WORDS, f"words-{count}")
    return await maps.advance()


async def _pairs(maps: MapWorld, world: FixtureWorld) -> Any:
    world.sources[PROJECT] = {C1: ["Trams are better.", "Buses are cheaper."], C2: ["Bikes are healthy."]}
    await inline(maps.store, PAIRS, "pairs-1")
    return await maps.advance()


BOTH = ("argument", "tension")


@pytest.mark.asyncio
@pytest.mark.parametrize("node_limit", [None, 12])
@pytest.mark.parametrize("delta", [-1, 0, 1])
async def test_the_node_budget_admits_its_limit_and_only_counts_beyond_it(world: FixtureWorld, node_limit: int | None, delta: int) -> None:
    limit = node_limit or DEFAULT_NODE_LIMIT
    maps = MapWorld()
    snapshot = await _words(maps, world, limit + delta)
    counted = Counting(maps.store)

    payload = await graph_payload(snapshot, _query(node_limit=node_limit), store=counted)  # type: ignore[arg-type]

    assert payload["version"] == 2 and payload["counts"]["argument"] == limit + delta
    assert payload["budgets"]["nodeLimit"] == limit and payload["budgets"]["edgeLimit"] >= limit - 1
    assert payload["budgets"]["defaults"] == {"nodeLimit": DEFAULT_NODE_LIMIT, "edgeLimit": 450}
    if delta <= 0:
        assert payload["overBudget"] is False and len(payload["nodes"]) == limit + delta
        assert all(len(node["embedding"]) == world.dims for node in payload["nodes"]) and payload["unplaced"] == []
    else:
        assert payload["overBudget"] is True
        assert payload["nodes"] == [] and payload["relations"] == [] and payload["unplaced"] == []
        # Counts only: no revision, relation or vector was read for the oversized scope.
        assert counted.calls == {}


@pytest.mark.asyncio
async def test_types_select_nodes_and_relations_join_only_displayed_revisions(world: FixtureWorld) -> None:
    maps = MapWorld()
    snapshot = await _pairs(maps, world)

    both = await graph_payload(snapshot, _query(BOTH), store=maps.store)
    assert both["counts"] == {"argument": 3, "deduplicated_argument": 0, "popcorn": 0, "tension": 1, "stakeholder": 0}
    shown = {node["revisionId"] for node in both["nodes"]}
    assert sorted(r["type"] for r in both["relations"]) == ["supports_pole_a", "supports_pole_b"]
    assert all(r["from"] in shown and r["to"] in shown and r["basis"] == "extracted" for r in both["relations"])
    (tension,) = [node for node in both["nodes"] if node["type"] == "tension"]
    assert tension["detail"]["narrative"] == "Both cannot hold at once." and tension["factCheck"] == {"eligible": False}
    # No vector for a tension's projection in this configuration: listed, never placed.
    assert tension["embedding"] is None and both["unplaced"] == [tension["revisionId"]]
    argument = next(node for node in both["nodes"] if node["type"] == "argument")
    assert argument["provenance"]["recipeId"] == WORDS and argument["provenance"]["origin"] == "generated"
    assert argument["attributes"] == {"valence": "positive", "epistemicKind": "argument"}
    assert both["embedding"]["key"] == world.identity().key and both["embedding"]["dims"] == world.dims

    only = await graph_payload(snapshot, _query(("tension",)), store=maps.store)
    assert [node["type"] for node in only["nodes"]] == ["tension"] and only["relations"] == []
    # Hidden ends stay nameable, without being added as nodes.
    assert sorted(stub["label"] for stub in only["related"]) == ["Bikes are healthy.", "Buses are cheaper."]

    none = await graph_payload(snapshot, _query(()), store=maps.store)
    assert none["nodes"] == [] and none["overBudget"] is False and none["scope"]["types"] == []
    assert none["counts"]["argument"] == 3

    default = await graph_payload(snapshot, _query(None), store=maps.store)
    assert default["scope"]["types"] == ["argument", "tension"]

    assert parse_types("") == () and parse_types(None) is None and parse_types("tension,argument") == ("argument", "tension")
    with pytest.raises(UnknownMapType):
        parse_types("argument,planet")


@pytest.mark.asyncio
async def test_scope_narrows_the_graph_to_one_producer_output(world: FixtureWorld) -> None:
    maps = MapWorld()
    snapshot = await _pairs(maps, world)

    tensions = await graph_payload(snapshot, _query(None, scope=PAIRS), store=maps.store)
    assert tensions["counts"]["argument"] == 0 and tensions["counts"]["tension"] == 1
    assert tensions["scope"] == {"types": ["tension"], "resultScope": PAIRS}

    words_run = next(p["runId"] for p in snapshot.manifest["producers"] if p["recipeId"] == WORDS)
    for scope in (f"run:{words_run}", f"{WORDS}@project", WORDS):
        payload = await graph_payload(snapshot, _query(None, scope=scope), store=maps.store)
        assert payload["counts"]["argument"] == 3 and payload["counts"]["tension"] == 0
    with pytest.raises(UnknownResultScope):
        await graph_payload(snapshot, _query(None, scope="deduplicated_arguments"), store=maps.store)


@pytest.mark.asyncio
async def test_a_tension_pinned_to_an_older_argument_is_stale_and_its_edge_is_not_drawn(world: FixtureWorld) -> None:
    maps = MapWorld()
    first = await _pairs(maps, world)
    world.sources[PROJECT][C1] = ["Trams are better.", "Buses are much cheaper."]
    await inline(maps.store, WORDS, "words-2")
    second = await maps.advance()
    assert second.parent_snapshot_id == first.id

    payload = await graph_payload(second, _query(BOTH), store=maps.store)
    (tension,) = [node for node in payload["nodes"] if node["type"] == "tension"]
    newer = next(node for node in payload["nodes"] if node["label"] == "Buses are much cheaper.")
    assert [r["type"] for r in payload["relations"]] == ["supports_pole_a"]
    assert not any(newer["revisionId"] in (r["from"], r["to"]) for r in payload["relations"])
    flagged = {entry["revisionId"] for entry in payload["snapshot"]["stale"]}
    assert tension["revisionId"] in flagged
    assert all(entry["reason"] == "based_on_earlier_revision" for entry in payload["snapshot"]["stale"])

    # The earlier snapshot still draws what it was built on.
    earlier = await graph_payload(first, _query(BOTH), store=maps.store)
    assert len(earlier["relations"]) == 2 and earlier["snapshot"]["stale"] == []


@pytest.mark.asyncio
async def test_a_vector_reference_to_another_configuration_is_never_used(world: FixtureWorld) -> None:
    maps = MapWorld()
    snapshot = await _words(maps, world, 2)
    revision_id = snapshot.manifest["objects"][0]["revisionId"]
    revision = maps.store.revisions[revision_id]
    other_id, _vector = await maps.store.save_embedding(
        project_id=PROJECT, input_hash="elsewhere", config_key="another-config", model="other", dims=4, vector=[1.0, 0.0, 0.0, 0.0]
    )
    maps.store.revisions[revision_id] = replace(
        revision, embedding_refs={**(revision.embedding_refs or {}), "embeddingId": other_id, "configKey": "another-config"}
    )

    payload = await graph_payload(snapshot, _query(), store=maps.store)

    node = next(n for n in payload["nodes"] if n["revisionId"] == revision_id)
    expected = await world.embed(revision.payload["statement"])
    assert node["embedding"] == [round(value, 6) for value in expected]


class _GraphEnv:
    def __init__(self, monkeypatch: pytest.MonkeyPatch, maps: MapWorld) -> None:
        self.maps = maps
        self.grants = Grants()
        monkeypatch.setattr(map_bff, "resolve_project_access", self.grants.resolve)
        monkeypatch.setattr(map_bff, "get_store", lambda: maps.map_store)
        monkeypatch.setattr(map_bff, "get_analysis_store", lambda: maps.store)
        monkeypatch.setattr(map_bff, "get_map_view_reads", lambda: maps.reads)
        monkeypatch.setattr(map_events, "publish_map_event", maps.publish)
        for name in ("_generate_limiter", "_title_limiter", "_fact_check_limiter"):
            monkeypatch.setattr(map_bff, name, Limiter())

    async def get(self, path: str, params: dict[str, str] | None = None, headers: dict[str, str] | None = None) -> Any:
        return await asgi_call(map_bff.router, BASE, "GET", path, params=params, headers=headers)


@pytest.mark.asyncio
async def test_the_graph_route_checks_access_validates_budgets_and_revalidates_as_304(
    world: FixtureWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    maps = MapWorld()
    await _words(maps, world, 3)
    env = _GraphEnv(monkeypatch, maps)
    access = env.grants.grant(PROJECT, *READ)
    path = f"/projects/{PROJECT}/graph"

    first = await env.get(path, {"types": "argument", "node_limit": "5"})
    assert first.status_code == 200 and access.required == ["project:read", "conversation:read"]
    body = first.json()
    assert body["version"] == 2 and len(body["nodes"]) == 3 and body["budgets"]["nodeLimit"] == 5
    assert body["snapshot"]["resultId"] in maps.reads.v2_results()
    etag = first.headers["etag"]

    again = await env.get(path, {"types": "argument", "node_limit": "5"}, {"If-None-Match": etag})
    assert again.status_code == 304 and again.content == b""
    none = await env.get(path, {"types": "", "node_limit": "5"}, {"If-None-Match": etag})
    assert none.status_code == 200 and none.headers["etag"] != etag and none.json()["nodes"] == []

    for bad in ({"node_limit": "0"}, {"node_limit": "many"}, {"node_limit": "10", "edge_limit": "3"}, {"types": "argument,planet"}, {"scope": "nothing"}):
        assert (await env.get(path, bad)).status_code == 422, bad

    env.grants.grant(PROJECT, "project:read")
    assert (await env.get(path)).status_code == 403
    assert (await env.get(f"/projects/{OTHER_PROJECT}/graph")).status_code == 404
    env.grants.grant(OTHER_PROJECT, *READ)
    assert (await env.get(f"/projects/{OTHER_PROJECT}/graph")).status_code == 404


@pytest.mark.asyncio
async def test_an_unimported_v1_result_is_served_in_the_v2_shape_and_its_v1_routes_still_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    maps = MapWorld()
    env = _GraphEnv(monkeypatch, maps)
    env.grants.grant(PROJECT, *READ)
    arguments = [
        manifest_argument("a-1", "Trams are quieter than buses."),
        manifest_argument("a-2", "Trams cost too much to build.", valence="negative"),
        manifest_argument("a-3", "The tram line cost 400 million euros.", kind="claim", valence="neutral"),
        manifest_argument("a-4", "Buses reach more neighbourhoods."),
    ]
    result = await ready_result(maps.map_store, arguments)

    body = (await env.get(f"/projects/{PROJECT}/graph")).json()
    assert body["snapshot"]["id"] == result["id"] and body["snapshot"]["legacy"] is True
    assert [node["revisionId"] for node in body["nodes"]] == ["a-1", "a-2", "a-3", "a-4"]
    claim = body["nodes"][2]
    assert claim["factCheck"] == {"eligible": True, "claimKey": arguments[2]["claim_key"]}
    assert claim["provenance"] == {"runId": result["id"], "origin": "imported", "recipeId": LEGACY_RECIPE_ID, "recipeVersion": result["recipe_version"]}
    assert all(node["embedding"] for node in body["nodes"]) and body["counts"]["argument"] == 4

    vector_reads = maps.map_store.calls["vectors_by_ids"]
    over = (await env.get(f"/projects/{PROJECT}/graph", {"node_limit": "3"})).json()
    assert over["overBudget"] is True and over["nodes"] == []
    assert maps.map_store.calls["vectors_by_ids"] == vector_reads

    checks = await asgi_call(map_bff.router, BASE, "GET", f"/results/{result['id']}/fact-checks")
    assert checks.json() == {"fact_checks": {"a-3": {"status": "idle"}}}
