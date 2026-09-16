"""Map generation through the executor, the following map view, the v2 row
the old project state reads, and the page's live event channels."""

from __future__ import annotations

from typing import Any, Iterator
from dataclasses import replace

import pytest
from fastapi.responses import StreamingResponse

import dembrane.map.events as map_events
import dembrane.api.v2.bff.map as map_bff
import dembrane.analysis.map_view as map_view
from dembrane.map import service
from tests.map_fakes import PROJECT
from dembrane.map.store import lease_of
from tests.analysis.helpers import Recorder
from dembrane.analysis.executor import run_worker
from dembrane.analysis.registry import UnknownRecipe, get_recipe, register_recipe, unregister_recipe
from tests.analysis.map_v2_fakes import READ, Grants, MapWorld, asgi_call
from tests.analysis.fixture_recipes import WORDS, FixtureWorld

C1 = "aaaaaaaa-0000-4000-8000-000000000001"


@pytest.fixture
def arguments_recipe(world: FixtureWorld) -> Iterator[None]:  # noqa: ARG001
    """The fixture words recipe registered as `arguments` for one test; the
    real one comes back afterwards."""
    try:
        original = get_recipe(map_view.ARGUMENTS_RECIPE_ID)
    except UnknownRecipe:
        original = None
    register_recipe(replace(get_recipe(WORDS), id=map_view.ARGUMENTS_RECIPE_ID), replace=True)
    try:
        yield
    finally:
        if original is not None:
            register_recipe(original, replace=True)
        else:
            unregister_recipe(map_view.ARGUMENTS_RECIPE_ID)


@pytest.mark.asyncio
async def test_generation_runs_the_arguments_recipe_after_a_running_v1_attempt_and_the_view_follows(
    world: FixtureWorld, arguments_recipe: None, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    maps = MapWorld()
    rec = Recorder()
    analysis = service.MapAnalysis(store=maps.store, reads=maps.reads, deps=rec.deps())
    world.sources[PROJECT] = {C1: ["Trams are better.", "Buses are cheaper."]}
    monkeypatch.setattr(service, "publish_map_event", maps.publish)
    monkeypatch.setattr(map_events, "publish_map_event", maps.publish)
    monkeypatch.setattr(map_view, "default_reads", lambda: maps.reads)

    # A v1 attempt still running is the answer; nothing competes with it.
    running = await maps.map_store.create_attempt(project_id=PROJECT, recipe_version="map-arguments-v1", requested_by="du1")
    assert (await service.request_generation(PROJECT, "du1", store=maps.map_store, analysis=analysis))["id"] == running["id"]  # type: ignore[index]
    assert maps.store.runs == {}
    await maps.map_store.fail(running["id"], "stopped", lease=lease_of(running))

    attempt = await service.request_generation(PROJECT, "du1", store=maps.map_store, analysis=analysis)
    assert attempt is not None and attempt["status"] == "queued" and rec.dispatched == [attempt["id"]]
    assert ("queued" in [e["type"] for _p, e in maps.events])
    current, shown = await service.project_rows(PROJECT, maps.map_store, analysis)
    assert current is None and shown is not None and shown["id"] == attempt["id"]

    assert await run_worker(attempt["id"], store=maps.store, deps=rec.deps()) == "ready"
    (event,) = [e for e in maps.store.outbox.values() if e.event_type == "run_published"]
    await map_view.map_view_hook(event, maps.store)
    snapshot = maps.current()
    assert snapshot.source_event_id == event.id and len(snapshot.manifest["objects"]) == 2
    assert ("ready" in [e["type"] for _p, e in maps.events])
    # A repeated dispatch of the same event writes no second snapshot or row.
    await map_view.map_view_hook(event, maps.store)
    assert len([s for s in maps.store.snapshots.values() if s.view_id == "map"]) == 1
    assert len(maps.reads.v2_results()) == 1

    # The old reader of the project state sees the v2 row in its v1 shape.
    current, shown = await service.project_rows(PROJECT, maps.map_store, analysis)
    assert current is not None and map_view.is_v2_manifest(current["manifest"]) and shown is None
    state = await service.state_payload(current, shown, maps.map_store, analysis)
    assert sorted(a["statement"] for a in state["current"]["arguments"]) == ["Buses are cheaper.", "Trams are better."]
    assert all(a["embedding"] for a in state["current"]["arguments"]) and state["current"]["snapshot_id"] == snapshot.id

    # Unchanged transcripts: the refresh reuses the ready output and starts nothing.
    assert await service.request_generation(PROJECT, "du1", store=maps.map_store, analysis=analysis) is None
    assert rec.dispatched == [attempt["id"]]


def test_the_map_channels() -> None:
    assert map_events.map_channels(PROJECT, runs=False) == [f"map:project:{PROJECT}"]
    assert map_events.map_channels(PROJECT, runs=True) == [f"map:project:{PROJECT}", f"analysis:project:{PROJECT}"]


@pytest.mark.asyncio
@pytest.mark.parametrize("manifest", [
    {"version": 2, "snapshotId": "snapshot-current"},
    {"version": 1, "arguments": [{"embedding_id": "vector-1"}], "stats": {"arguments": 203}},
])
async def test_project_metadata_does_not_load_vectors_or_revisions(manifest: dict[str, Any]) -> None:
    class NoReads:
        def __getattr__(self, name: str) -> Any:
            raise AssertionError(f"metadata must not read {name}")

    current = {"id": "result-current", "status": "ready", "manifest": manifest}
    payload = await service.state_payload(current, None, NoReads(), NoReads(), metadata_only=True)  # type: ignore[arg-type]
    assert payload["current"]["id"] == "result-current"
    assert payload["current"]["snapshot_id"] == manifest.get("snapshotId")
    assert payload["current"]["metadata_only"] is True
    assert payload["current"]["arguments"] == []


@pytest.mark.asyncio
async def test_project_metadata_route_uses_a_distinct_etag(monkeypatch: pytest.MonkeyPatch) -> None:
    maps = MapWorld()
    grants = Grants()
    access = grants.grant(PROJECT, *READ)
    current = {"id": "result-current", "status": "ready", "manifest": {"version": 2, "snapshotId": "snapshot-current"}}

    async def rows(*args: Any) -> Any:
        return current, None

    async def count(*args: Any) -> int:
        return 11

    monkeypatch.setattr(map_bff, "resolve_project_access", grants.resolve)
    monkeypatch.setattr(map_bff, "get_store", lambda: maps.map_store)
    monkeypatch.setattr(map_bff, "get_map_analysis", lambda: None)
    monkeypatch.setattr(service, "project_rows", rows)
    monkeypatch.setattr(map_bff.transcripts, "count_conversations_with_transcripts", count)
    path = f"/projects/{PROJECT}"
    full_etag = service.state_etag(current, None, 11)
    response = await asgi_call(map_bff.router, "/api/v2/bff/map", "GET", path,
                               params={"metadata_only": "true"}, headers={"If-None-Match": full_etag})
    assert response.status_code == 200
    assert response.headers["etag"] != full_etag
    assert response.json()["current"]["snapshot_id"] == "snapshot-current"
    assert response.json()["current"]["arguments"] == []
    assert access.required == ["project:read", "conversation:read"]
    again = await asgi_call(map_bff.router, "/api/v2/bff/map", "GET", path,
                           params={"metadata_only": "true"}, headers={"If-None-Match": response.headers["etag"]})
    assert again.status_code == 304


@pytest.mark.asyncio
async def test_the_events_route_adds_executor_runs_on_request_or_once_the_project_has_them(
    world: FixtureWorld, arguments_recipe: None, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    maps = MapWorld()
    grants = Grants()
    grants.grant(PROJECT, *READ)
    streams: list[list[str]] = []

    def _sse(request: Any, channels: list[str], **kwargs: Any) -> StreamingResponse:  # noqa: ARG001
        streams.append(channels)

        async def _body() -> Any:
            yield 'event: connected\ndata: {"type":"connected"}\n\n'

        return StreamingResponse(_body(), media_type="text/event-stream")

    monkeypatch.setattr(map_bff, "resolve_project_access", grants.resolve)
    monkeypatch.setattr(map_bff, "get_analysis_store", lambda: maps.store)
    monkeypatch.setattr(map_bff.live_events, "sse_response", _sse)
    path = f"/projects/{PROJECT}/events"

    await asgi_call(map_bff.router, "/api/v2/bff/map", "GET", path)
    await asgi_call(map_bff.router, "/api/v2/bff/map", "GET", path, params={"runs": "1"})
    await maps.store.ensure_scope(project_id=PROJECT, kind=map_view.ScopeKind.PRODUCER, owner_id=map_view.ARGUMENTS_RECIPE_ID, scope_key="project")
    await asgi_call(map_bff.router, "/api/v2/bff/map", "GET", path)

    map_only, both = [f"map:project:{PROJECT}"], [f"map:project:{PROJECT}", f"analysis:project:{PROJECT}"]
    assert streams == [map_only, both, both]
