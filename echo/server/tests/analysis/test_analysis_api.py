"""BFF analysis endpoints: recipe metadata, run requests (access, rate limit,
idempotency), run inspection and cancellation, objects, history and lineage."""

from __future__ import annotations

import uuid
from typing import Any

import pytest

import dembrane.api.v2.bff.analysis as analysis_bff
from tests.map_fakes import PROJECT, OTHER_PROJECT
from tests.analysis.helpers import Recorder
from dembrane.map.fact_check import ASSESSMENT_RECIPE_ID
from dembrane.analysis.revisions import RevisionService
from tests.analysis.map_v2_fakes import READ, WRITE, Grants, Limiter, MapWorld, inline, asgi_call
from tests.analysis.fixture_recipes import PAIRS, WORDS, FixtureWorld

C1 = "aaaaaaaa-0000-4000-8000-000000000001"
C2 = "aaaaaaaa-0000-4000-8000-000000000002"
BASE = "/api/v2/bff/analysis"


class _Env:
    def __init__(self, monkeypatch: pytest.MonkeyPatch, maps: MapWorld) -> None:
        self.maps = maps
        self.grants = Grants()
        self.rec = Recorder()
        self.limiter = Limiter()
        monkeypatch.setattr(analysis_bff, "resolve_project_access", self.grants.resolve)
        monkeypatch.setattr(analysis_bff, "get_store", lambda: maps.store)
        monkeypatch.setattr(analysis_bff, "get_reads", lambda: maps.reads)
        monkeypatch.setattr(analysis_bff, "get_executor_deps", lambda: self.rec.deps())
        monkeypatch.setattr(analysis_bff, "_run_limiter", self.limiter)

    async def call(self, method: str, path: str, json: Any = None, params: dict[str, str] | None = None) -> Any:
        return await asgi_call(analysis_bff.router, BASE, method, path, json=json, params=params)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, world: FixtureWorld) -> _Env:
    world.sources[PROJECT] = {C1: ["Trams are better.", "Buses are cheaper."], C2: ["Bikes are healthy."]}
    world.sources[OTHER_PROJECT] = {C1: ["Elsewhere."]}
    return _Env(monkeypatch, MapWorld())


@pytest.mark.asyncio
async def test_recipe_metadata_lists_steps_schemas_and_checks_but_no_internal_recipe(env: _Env) -> None:
    recipes = {r["id"]: r for r in (await env.call("GET", "/recipes")).json()["recipes"]}
    assert ASSESSMENT_RECIPE_ID not in recipes
    words = recipes[WORDS]
    assert [step["key"] for step in words["steps"]] == ["extract", "check"]
    assert words["steps"][1]["kind"] == "check" and "argument" in words["outputSchemas"]


@pytest.mark.asyncio
async def test_a_run_request_needs_project_update_and_one_key_is_one_run(env: _Env) -> None:
    env.grants.grant(PROJECT, *READ)
    assert (await env.call("POST", f"/projects/{PROJECT}/runs", {"recipe_id": WORDS})).status_code == 403
    assert env.maps.store.runs == {} and env.limiter.users == []

    env.grants.grant(PROJECT, *WRITE)
    body = {"recipe_id": WORDS, "idempotency_key": "generate-words-1"}
    first = await env.call("POST", f"/projects/{PROJECT}/runs", body)
    assert first.status_code == 202 and first.json()["outcome"] == "created"
    run = first.json()["run"]
    assert run["status"] == "queued" and run["recipeId"] == WORDS and env.rec.dispatched == [run["id"]]
    again = await env.call("POST", f"/projects/{PROJECT}/runs", body)
    assert again.status_code == 202 and again.json()["run"]["id"] == run["id"] and again.json()["outcome"] == "existing"
    assert env.rec.dispatched == [run["id"]] and env.limiter.users == ["du1", "du1"]
    assert (PROJECT, "client:generate-words-1") in env.maps.store.keys

    assert (await env.call("POST", f"/projects/{PROJECT}/runs", {"recipe_id": ASSESSMENT_RECIPE_ID})).status_code == 422
    assert (await env.call("POST", f"/projects/{PROJECT}/runs", {"recipe_id": "no.such_recipe"})).status_code == 422
    assert (await env.call("POST", f"/projects/{PROJECT}/runs", {"recipe_id": WORDS, "scope_key": "conversation:x"})).status_code == 422
    assert (await env.call("POST", f"/projects/{OTHER_PROJECT}/runs", {"recipe_id": WORDS})).status_code == 404


@pytest.mark.asyncio
async def test_runs_are_inspected_with_read_access_and_cancelled_with_update(env: _Env) -> None:
    env.grants.grant(PROJECT, *WRITE)
    queued = (await env.call("POST", f"/projects/{PROJECT}/runs", {"recipe_id": PAIRS})).json()["run"]
    env.grants.grant(PROJECT, *READ)
    inspected = await env.call("GET", f"/runs/{queued['id']}")
    assert inspected.status_code == 200 and inspected.json()["run"]["steps"] == []
    assert [s["key"] for s in inspected.json()["run"]["definition"]["steps"]] == ["pair", "coverage"]
    assert (await env.call("POST", f"/runs/{queued['id']}/cancel")).status_code == 403

    env.grants.grant(PROJECT, *WRITE)
    cancelled = await env.call("POST", f"/runs/{queued['id']}/cancel")
    assert cancelled.json()["run"]["status"] in ("cancelled", "failed")

    ready = await inline(env.maps.store, WORDS, "words-ready")
    run = (await env.call("GET", f"/runs/{ready.id}")).json()["run"]
    assert sorted(step["key"] for step in run["steps"]) == ["check", f"extract:{C1}", f"extract:{C2}"]
    assert any(check["check"] == "statements-have-text" for check in run["checks"])
    assert run["output"]["objects"] == 3 and run["metrics"]["modelCalls"] == 2

    foreign = await inline(env.maps.store, WORDS, "words-foreign", project_id=OTHER_PROJECT)
    assert (await env.call("GET", f"/runs/{foreign.id}")).status_code == 404
    assert (await env.call("GET", "/runs/not-a-run")).status_code == 404
    assert (await env.call("GET", f"/runs/{uuid.uuid4()}")).status_code == 404


@pytest.mark.asyncio
async def test_objects_page_with_counts_history_and_pinned_lineage(env: _Env) -> None:
    access = env.grants.grant(PROJECT, *READ)
    await inline(env.maps.store, PAIRS, "pairs")
    snapshot = await env.maps.advance()

    page = (await env.call("GET", f"/projects/{PROJECT}/objects", params={"limit": "2"})).json()
    assert page["snapshotId"] == snapshot.id and page["total"] == 4 and len(page["items"]) == 2
    assert page["counts"]["argument"] == 3 and page["counts"]["tension"] == 1
    assert [item["type"] for item in page["items"]] == ["argument", "argument"]
    assert access.required == ["project:read", "conversation:read"]
    tensions = (await env.call("GET", f"/projects/{PROJECT}/objects", params={"type": "tension"})).json()
    assert tensions["total"] == 1 and " / " in tensions["items"][0]["label"]
    assert (await env.call("GET", f"/projects/{PROJECT}/objects", params={"type": "planet"})).status_code == 422
    assert (await env.call("GET", f"/projects/{PROJECT}/objects", params={"snapshot_id": str(uuid.uuid4())})).status_code == 404

    trams = next(r for r in env.maps.store.revisions.values() if r.payload.get("statement") == "Trams are better.")
    await RevisionService(env.maps.store).author_edit(
        project_id=PROJECT,
        object_id=trams.object_id,
        expected_revision_id=trams.id,
        payload={**trams.payload, "statement": "Trams are much better."},
        actor_id="du1",
        reason="wording",
    )
    history = (await env.call("GET", f"/projects/{PROJECT}/objects/{trams.object_id}/revisions")).json()
    assert [r["revisionNumber"] for r in history["revisions"]] == [1, 2]
    assert [r["provenance"]["origin"] for r in history["revisions"]] == ["generated", "authored"]
    env.grants.grant(OTHER_PROJECT, *READ)
    assert (await env.call("GET", f"/projects/{OTHER_PROJECT}/objects/{trams.object_id}/revisions")).status_code == 404

    tension_id = next(o["revisionId"] for o in snapshot.manifest["objects"] if o["type"] == "tension")
    lineage = (await env.call("GET", f"/snapshots/{snapshot.id}/revisions/{tension_id}/lineage")).json()
    assert lineage["root"] == tension_id and len(lineage["revisions"]) == 3 and len(lineage["edges"]) == 2
    assert lineage["missing"] == [] and lineage["truncated"] is False
    edited = next(r for r in env.maps.store.revisions.values() if r.payload.get("statement") == "Trams are much better.")
    assert (await env.call("GET", f"/snapshots/{snapshot.id}/revisions/{edited.id}/lineage")).status_code == 404
