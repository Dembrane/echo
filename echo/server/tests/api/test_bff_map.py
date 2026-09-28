"""BFF endpoints for Map: access checks, error mapping and the events stream."""

from __future__ import annotations

from typing import Any, AsyncIterator

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

import dembrane.map.model as map_model
import dembrane.api.v2.bff.map as map_bff
from dembrane.map import recipe, service
from tests.map_fakes import (
    PROJECT,
    OTHER_PROJECT,
    FakeMapStore,
    FakeAsyncRedis,
    ready_result,
    manifest_argument,
)
from dembrane.map.store import MapStoreError
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

BASE = "/api/v2/bff/map"
READ = ("project:read", "conversation:read")
WRITE = (*READ, "project:update")


def _arguments() -> list[dict[str, Any]]:
    return [
        manifest_argument("a-1", "Trams are quieter than buses."),
        manifest_argument("a-2", "Trams cost too much to build.", valence="negative"),
        manifest_argument("a-3", "The tram line cost 400 million euros.", kind="claim", valence="neutral"),
        manifest_argument("a-4", "Buses reach more neighbourhoods."),
    ]


class _Access:
    def __init__(self, project_id: str, allowed: tuple[str, ...]) -> None:
        self.project_id = project_id
        self.allowed = set(allowed)
        self.required: list[str] = []
        self.project = {"id": project_id, "name": "Harbour", "context": "Trams or buses."}

    def require(self, policy: str) -> None:
        self.required.append(policy)
        if policy not in self.allowed:
            raise HTTPException(status_code=403, detail="Not allowed")


class _Limiter:
    def __init__(self) -> None:
        self.users: list[str] = []

    async def check(self, user_id: str) -> None:
        self.users.append(user_id)


class _Env:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.store = FakeMapStore()
        self.redis = FakeAsyncRedis()
        self.access: dict[str, _Access] = {}
        self.generations: list[str] = []
        self.fact_check_jobs: list[tuple[Any, ...]] = []
        self.dispatch_error: BaseException | None = None
        self.titles: list[list[str]] = []
        self.title_error: BaseException | None = None
        self.streams: list[list[str]] = []
        self.conversations: int | BaseException = 3
        self.limiters = {
            name: _Limiter() for name in ("_generate_limiter", "_title_limiter", "_fact_check_limiter")
        }

        async def _resolve(project_id: str, auth: Any) -> _Access:  # noqa: ARG001
            # Like the real resolver: a project the caller cannot reach is a 404.
            access = self.access.get(project_id)
            if access is None:
                raise HTTPException(status_code=404, detail="Project not found")
            return access

        async def _redis() -> FakeAsyncRedis:
            return self.redis

        async def _publish(project_id: str, event: dict[str, Any]) -> None:  # noqa: ARG001
            return None

        real_request = service.request_generation
        real_start = service.start_fact_check

        def _dispatch_generation(result_id: str) -> str:
            if self.dispatch_error is not None:
                raise self.dispatch_error
            self.generations.append(result_id)
            return "msg"

        def _dispatch_fact_check(*job: Any) -> str:
            if self.dispatch_error is not None:
                raise self.dispatch_error
            self.fact_check_jobs.append(job)
            return "msg"

        async def _request(project_id: str, requested_by: str | None, *, store: Any) -> dict[str, Any]:
            return await real_request(
                project_id, requested_by, store=store, dispatch=_dispatch_generation
            )

        async def _start(
            row: dict[str, Any], node_id: str, *, requested_by: str | None, force: bool, store: Any
        ) -> dict[str, Any]:
            return await real_start(
                row,
                node_id,
                requested_by=requested_by,
                force=force,
                store=store,
                dispatch=_dispatch_fact_check,
            )

        async def _title(*, lines: list[str], project_name: str, project_context: str) -> str:  # noqa: ARG001
            self.titles.append(lines)
            if self.title_error is not None:
                raise self.title_error
            return "Trams against buses"

        def _sse(request: Any, channels: list[str], **kwargs: Any) -> StreamingResponse:  # noqa: ARG001
            self.streams.append(channels)

            async def _body() -> AsyncIterator[str]:
                yield 'event: connected\ndata: {"type":"connected"}\n\n'

            return StreamingResponse(_body(), media_type="text/event-stream")

        monkeypatch.setattr(map_bff, "resolve_project_access", _resolve)
        monkeypatch.setattr(map_bff, "get_store", lambda: self.store)
        monkeypatch.setattr(map_bff, "get_redis_client", _redis)
        for name, limiter in self.limiters.items():
            monkeypatch.setattr(map_bff, name, limiter)
        monkeypatch.setattr(service, "publish_map_event", _publish)
        monkeypatch.setattr(service, "request_generation", _request)
        monkeypatch.setattr(service, "start_fact_check", _start)
        monkeypatch.setattr(map_model, "title_selection", _title)
        monkeypatch.setattr(map_model, "model_identity", lambda: "fake-title-model")
        monkeypatch.setattr(map_bff.live_events, "sse_response", _sse)

        async def _count(project_id: str) -> int:  # noqa: ARG001
            if isinstance(self.conversations, BaseException):
                raise self.conversations
            return self.conversations

        monkeypatch.setattr(map_bff.transcripts, "count_conversations_with_transcripts", _count)

    def grant(self, project_id: str, *policies: str) -> _Access:
        self.access[project_id] = _Access(project_id, policies)
        return self.access[project_id]

    async def call(
        self, method: str, path: str, json: Any = None, headers: dict[str, str] | None = None
    ) -> Any:
        app = FastAPI()
        app.include_router(map_bff.router, prefix=BASE)

        async def _session() -> DirectusSession:
            return DirectusSession(user_id="du1", is_admin=False, access_token="t", client=None)

        app.dependency_overrides[require_directus_session] = _session
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.request(method, f"{BASE}{path}", json=json, headers=headers)

    async def ready(self, project_id: str = PROJECT) -> dict[str, Any]:
        return await ready_result(self.store, _arguments(), project_id=project_id)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> _Env:
    return _Env(monkeypatch)


# ── project routes ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reading_a_project_map_needs_project_and_conversation_read(env: _Env) -> None:
    access = env.grant(PROJECT, *READ)
    res = await env.call("GET", f"/projects/{PROJECT}")
    assert res.status_code == 200
    assert res.json() == {
        "current": None,
        "attempt": None,
        "source": {"conversations_with_transcripts": 3},
    }
    assert access.required == ["project:read", "conversation:read"]

    result = await env.ready()
    body = (await env.call("GET", f"/projects/{PROJECT}")).json()
    assert body["current"]["id"] == result["id"]
    assert [a["id"] for a in body["current"]["arguments"]] == ["a-1", "a-2", "a-3", "a-4"]

    env.grant(PROJECT, "project:read")
    assert (await env.call("GET", f"/projects/{PROJECT}")).status_code == 403
    assert (await env.call("GET", f"/projects/{OTHER_PROJECT}")).status_code == 404


@pytest.mark.asyncio
async def test_an_unchanged_project_map_revalidates_as_304(env: _Env) -> None:
    env.grant(PROJECT, *READ)
    await env.ready()
    first = await env.call("GET", f"/projects/{PROJECT}")
    etag = first.headers["etag"]
    assert first.status_code == 200 and first.headers["cache-control"] == "private, no-cache"

    again = await env.call("GET", f"/projects/{PROJECT}", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""

    # A new attempt, or a change in what a generation would read, is a new body.
    await env.store.create_attempt(project_id=PROJECT, recipe_version=recipe.RECIPE_VERSION, requested_by=None)
    moved = await env.call("GET", f"/projects/{PROJECT}", headers={"If-None-Match": etag})
    assert moved.status_code == 200 and moved.headers["etag"] != etag
    env.conversations = 4
    counted = await env.call("GET", f"/projects/{PROJECT}", headers={"If-None-Match": moved.headers["etag"]})
    assert counted.status_code == 200
    assert counted.json()["source"] == {"conversations_with_transcripts": 4}


@pytest.mark.asyncio
async def test_a_failed_source_count_still_serves_the_map(env: _Env) -> None:
    env.grant(PROJECT, *READ)
    result = await env.ready()
    env.conversations = RuntimeError("directus down")
    res = await env.call("GET", f"/projects/{PROJECT}")
    assert res.status_code == 200
    assert res.json()["current"]["id"] == result["id"]
    assert res.json()["source"] == {"conversations_with_transcripts": None}


@pytest.mark.asyncio
async def test_generating_needs_project_update(env: _Env) -> None:
    env.grant(PROJECT, *READ)
    res = await env.call("POST", f"/projects/{PROJECT}/generate")
    assert res.status_code == 403
    assert env.store.results == {} and env.generations == []
    assert env.limiters["_generate_limiter"].users == []

    env.grant(PROJECT, *WRITE)
    res = await env.call("POST", f"/projects/{PROJECT}/generate")
    assert res.status_code == 202
    attempt = res.json()["attempt"]
    assert attempt["status"] == "queued"
    assert env.generations == [attempt["id"]]
    assert env.limiters["_generate_limiter"].users == ["du1"]

    again = await env.call("POST", f"/projects/{PROJECT}/generate")
    assert again.status_code == 202 and again.json()["attempt"]["id"] == attempt["id"]
    assert env.generations == [attempt["id"]]


@pytest.mark.asyncio
async def test_a_generation_that_cannot_be_dispatched_is_a_503(env: _Env) -> None:
    env.grant(PROJECT, *WRITE)
    env.dispatch_error = RuntimeError("broker down")

    res = await env.call("POST", f"/projects/{PROJECT}/generate")

    assert res.status_code == 503
    (row,) = env.store.results.values()
    assert row["status"] == "failed"


@pytest.mark.asyncio
async def test_the_events_route_checks_read_access_and_streams(env: _Env) -> None:
    env.grant(PROJECT, *READ)
    res = await env.call("GET", f"/projects/{PROJECT}/events")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    assert "event: connected" in res.text
    assert env.streams == [[f"map:project:{PROJECT}"]]

    env.grant(PROJECT, "project:read")
    assert (await env.call("GET", f"/projects/{PROJECT}/events")).status_code == 403
    assert (await env.call("GET", f"/projects/{OTHER_PROJECT}/events")).status_code == 404
    assert len(env.streams) == 1


# ── result routes ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_result_of_a_project_the_caller_cannot_access_is_a_404(env: _Env) -> None:
    env.grant(PROJECT, *WRITE)
    foreign = await env.ready(OTHER_PROJECT)
    ids = {"node_ids": ["a-1", "a-2", "a-3"]}

    assert (await env.call("POST", f"/results/{foreign['id']}/title", ids)).status_code == 404
    assert (await env.call("GET", f"/results/{foreign['id']}/fact-checks")).status_code == 404
    assert (await env.call("POST", f"/results/{foreign['id']}/fact-checks/a-3")).status_code == 404
    assert (await env.call("DELETE", f"/results/{foreign['id']}/fact-checks/a-3")).status_code == 404
    assert (await env.call("POST", "/results/no-such-result/title", ids)).status_code == 404

    assert env.titles == [] and env.fact_check_jobs == []
    assert env.store.fact_checks == {}
    assert env.access[PROJECT].required == []


@pytest.mark.asyncio
async def test_a_title_needs_read_access_and_is_cached(env: _Env) -> None:
    access = env.grant(PROJECT, *READ)
    result = await env.ready()

    first = await env.call("POST", f"/results/{result['id']}/title", {"node_ids": ["a-1", "a-2", "a-3"]})
    second = await env.call("POST", f"/results/{result['id']}/title", {"node_ids": ["a-3", "a-2", "a-1"]})

    assert first.status_code == 200 and first.json() == {"title": "Trams against buses", "cached": False}
    assert second.json() == {"title": "Trams against buses", "cached": True}
    assert len(env.titles) == 1
    assert "project:update" not in access.required
    assert env.limiters["_title_limiter"].users == ["du1", "du1"]


@pytest.mark.asyncio
async def test_title_errors_map_to_their_statuses(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    env.grant(PROJECT, *READ)
    result = await env.ready()
    path = f"/results/{result['id']}/title"

    assert (await env.call("POST", path, {"node_ids": ["a-1", "a-2"]})).status_code == 422
    assert (await env.call("POST", path, {"node_ids": ["a-1", "a-2", "a-nope"]})).status_code == 422
    assert (await env.call("POST", path, {"node_ids": []})).status_code == 422
    with monkeypatch.context() as patch:
        patch.setattr(recipe, "MAX_TITLE_CHARS", 10)
        assert (await env.call("POST", path, {"node_ids": ["a-1", "a-2", "a-3"]})).status_code == 413

    env.title_error = RuntimeError("model unavailable")
    res = await env.call("POST", path, {"node_ids": ["a-1", "a-2", "a-4"]})
    assert res.status_code == 502
    assert "unavailable" not in res.text
    env.title_error = None

    env.store.raise_on["fact_checks_for"] = MapStoreError("connection lost")
    assert (await env.call("POST", path, {"node_ids": ["a-2", "a-3", "a-4"]})).status_code == 503
    env.store.raise_on.clear()

    running = await env.store.create_attempt(project_id=PROJECT, recipe_version="v", requested_by=None)
    res = await env.call("POST", f"/results/{running['id']}/title", {"node_ids": ["a-1", "a-2", "a-3"]})
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_store_failures_are_503s(env: _Env) -> None:
    env.grant(PROJECT, *WRITE)
    result = await env.ready()

    env.store.raise_on["get_result"] = MapStoreError("connection lost")
    assert (await env.call("POST", f"/results/{result['id']}/title", {"node_ids": ["a-1", "a-2", "a-3"]})).status_code == 503
    assert (await env.call("GET", f"/results/{result['id']}/fact-checks")).status_code == 503
    assert (await env.call("POST", f"/results/{result['id']}/fact-checks/a-3")).status_code == 503
    assert (await env.call("DELETE", f"/results/{result['id']}/fact-checks/a-3")).status_code == 503

    env.store.raise_on = {"expire_stale": MapStoreError("connection lost")}
    assert (await env.call("GET", f"/projects/{PROJECT}")).status_code == 503
    assert (await env.call("POST", f"/projects/{PROJECT}/generate")).status_code == 503

    env.store.raise_on = {"start_fact_check": MapStoreError("connection lost")}
    assert (await env.call("POST", f"/results/{result['id']}/fact-checks/a-3")).status_code == 503


@pytest.mark.asyncio
async def test_fact_check_routes_need_project_update_to_change_state(env: _Env) -> None:
    access = env.grant(PROJECT, *READ)
    result = await env.ready()
    base = f"/results/{result['id']}/fact-checks"

    listing = await env.call("GET", base)
    assert listing.status_code == 200
    assert listing.json() == {"fact_checks": {"a-3": {"status": "idle"}}}
    assert access.required == ["project:read", "conversation:read"]
    assert (await env.call("POST", f"{base}/a-3")).status_code == 403
    assert (await env.call("DELETE", f"{base}/a-3")).status_code == 403
    assert env.store.fact_checks == {}

    env.grant(PROJECT, *WRITE)
    started = await env.call("POST", f"{base}/a-3")
    assert started.status_code == 200 and started.json()["status"] == "processing"
    joined = await env.call("POST", f"{base}/a-3", {"force": True})
    assert joined.json()["status"] == "processing"
    assert len(env.fact_check_jobs) == 1
    assert env.fact_check_jobs[0][2:] == (result["id"], "a-3")

    cancelled = await env.call("DELETE", f"{base}/a-3")
    assert cancelled.status_code == 200 and cancelled.json() == {"status": "idle"}
    assert (await env.call("POST", f"{base}/a-3")).json()["status"] == "processing"
    assert len(env.fact_check_jobs) == 2

    assert (await env.call("POST", f"{base}/a-1")).status_code == 422
    assert (await env.call("POST", f"{base}/a-nope")).status_code == 422
    assert (await env.call("DELETE", f"{base}/a-1")).status_code == 422

    running = await env.store.create_attempt(project_id=PROJECT, recipe_version="v", requested_by=None)
    assert (await env.call("GET", f"/results/{running['id']}/fact-checks")).status_code == 409
    assert (await env.call("POST", f"/results/{running['id']}/fact-checks/a-3")).status_code == 409


@pytest.mark.asyncio
async def test_a_fact_check_that_cannot_be_dispatched_is_a_503(env: _Env) -> None:
    env.grant(PROJECT, *WRITE)
    result = await env.ready()
    env.dispatch_error = RuntimeError("broker down")

    res = await env.call("POST", f"/results/{result['id']}/fact-checks/a-3")

    assert res.status_code == 503
    (row,) = env.store.fact_checks.values()
    assert row["status"] == "error"
