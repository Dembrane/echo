"""BFF endpoints for Map: saved maps, the bounded graph, generation, selection
titles, fact-checks.

Reading a map needs project and conversation read access (the evidence is
transcript text). Starting a generation or a fact-check writes shared state and
needs `project:update`. Result-scoped routes resolve the result to its project
before any access check, so a result id from another project is a 404. A result
id is a v1 `map_result` row, a v2 row, or a map snapshot id; v2 titles and
fact-checks name exact revision ids.
"""

from __future__ import annotations

import json
import hashlib
import logging
from typing import Any

from fastapi import Query, Request, Response, APIRouter, HTTPException, status
from pydantic import Field, BaseModel
from fastapi.responses import JSONResponse, StreamingResponse

from dembrane import live_events
from dembrane.map import events, service, transcripts
from dembrane.map.store import MapStore, SqlMapStore, MapStoreError
from dembrane.map.recipe import SelectionTooLarge, SelectionTooSmall
from dembrane.redis_async import get_redis_client
from dembrane.analysis.store import SqlAnalysisStore
from dembrane.api.rate_limit import RedisUserRateLimiter
from dembrane.analysis.budgets import BudgetError, resolve_budgets
from dembrane.analysis.map_view import (
    VIEW_SCOPE_KEY,
    PAYLOAD_VERSION,
    ARGUMENTS_RECIPE_ID,
    GraphQuery,
    MapViewReads,
    UnknownMapType,
    SqlMapViewReads,
    UnknownResultScope,
    parse_types,
    graph_payload,
    current_map_snapshot,
    legacy_graph_payload,
)
from dembrane.analysis.contracts import ScopeKind, AnalysisStore, AnalysisStoreError
from dembrane.api.v2.bff._access import ResourceAccess, resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = logging.getLogger("api.v2.bff.map")

router = APIRouter()

_generate_limiter = RedisUserRateLimiter(key="map_generate", capacity=10, window_seconds=600)
_title_limiter = RedisUserRateLimiter(key="map_title", capacity=60, window_seconds=60)
_fact_check_limiter = RedisUserRateLimiter(key="map_fact_check", capacity=120, window_seconds=60)


def get_store() -> MapStore:
    return SqlMapStore()


def get_analysis_store() -> AnalysisStore:
    return SqlAnalysisStore()


def get_map_view_reads() -> MapViewReads:
    return SqlMapViewReads()


def get_map_analysis() -> service.MapAnalysis | None:
    """The executor side of Map, once generation runs through it."""
    if not service.generation_recipe_available():
        return None
    return service.MapAnalysis(store=get_analysis_store(), reads=get_map_view_reads())


def _unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Map storage is unavailable."
    )


async def _readable(project_id: str, auth: DependencyDirectusSession) -> ResourceAccess:
    access = await resolve_project_access(project_id, auth)
    access.require("project:read")
    access.require("conversation:read")
    return access


Target = dict[str, Any] | service.SnapshotTarget


async def _result(result_id: str, auth: DependencyDirectusSession) -> tuple[Target, ResourceAccess]:
    try:
        target = await service.resolve_target(
            result_id, store=get_store(), analysis_store=get_analysis_store()
        )
    except (MapStoreError, AnalysisStoreError) as exc:
        raise _unavailable() from exc
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Map not found")
    project_id = target.project_id if isinstance(target, service.SnapshotTarget) else target["project_id"]
    access = await _readable(project_id, auth)
    return target, access


def _etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    return any(candidate.strip() in (etag, "*") for candidate in header.split(","))


@router.get("/projects/{project_id}")
async def get_project_map(
    project_id: str, request: Request, auth: DependencyDirectusSession, metadata_only: bool = False
) -> Response:
    """The project's current map revision, any newer attempt, and how many of
    its conversations a generation would read.

    Served with an ETag: the page reloads this on every stream (re)connect, and
    a browser revalidating an unchanged map gets a 304 instead of every vector
    again."""
    await _readable(project_id, auth)
    store = get_store()
    analysis = get_map_analysis()
    try:
        current, attempt = await service.project_rows(project_id, store, analysis)
    except (MapStoreError, AnalysisStoreError) as exc:
        raise _unavailable() from exc
    try:
        conversations: int | None = await transcripts.count_conversations_with_transcripts(
            project_id
        )
    except Exception as exc:  # the count is a hint; the map itself still loads
        logger.warning("map source count failed for project %s: %s", project_id, exc)
        conversations = None
    etag = service.state_etag(current, attempt, conversations)
    if metadata_only:
        etag = etag[:-1] + '-metadata"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    try:
        payload = await service.state_payload(current, attempt, store, analysis, metadata_only=metadata_only)
    except (MapStoreError, AnalysisStoreError) as exc:
        raise _unavailable() from exc
    payload["source"] = {"conversations_with_transcripts": conversations}
    return JSONResponse(payload, headers=headers)


def _int_param(name: str, raw: str | None) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        raise BudgetError(name, f"{name} must be a positive whole number, got {raw!r}") from None


def graph_etag(kind: str, identity: str, stamp: str, query: GraphQuery) -> str:
    """A snapshot never changes, so its id with the selection and budgets names
    the whole graph response; a legacy result is named by its id and completion."""
    parts = [
        str(PAYLOAD_VERSION),
        kind,
        identity,
        stamp,
        ",".join(query.types) if query.types is not None else "*",
        query.scope or "",
        json.dumps(query.budgets.as_payload(), sort_keys=True),
    ]
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:24]
    return f'W/"map-graph-{digest}"'


@router.get("/projects/{project_id}/graph")
async def get_project_map_graph(
    project_id: str,
    request: Request,
    auth: DependencyDirectusSession,
    types: str | None = Query(default=None),
    scope: str | None = Query(default=None),
    node_limit: str | None = Query(default=None),
    edge_limit: str | None = Query(default=None),
) -> Response:
    """The bounded graph of the project's map view (payload v2).

    `types` is a comma list (present but empty: none selected; absent: the
    server's default selection); `scope` narrows to one producer output. Counts
    come before vectors: a selection above the node budget returns counts only.
    A project whose newest ready result is a v1 result not imported yet is
    served that result in the same shape. 404 when the project has no map."""
    await _readable(project_id, auth)
    try:
        query = GraphQuery(
            types=parse_types(types),
            scope=scope or None,
            budgets=resolve_budgets(_int_param("node_limit", node_limit), _int_param("edge_limit", edge_limit)),
        )
    except (UnknownMapType, BudgetError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    store = get_store()
    analysis_store = get_analysis_store()
    reads = get_map_view_reads()
    try:
        snapshot = await current_map_snapshot(project_id, store=analysis_store, reads=reads)
        legacy = [link for link in await reads.legacy_results(project_id) if not link.snapshot_id]
        newest = legacy[-1] if legacy else None
        legacy_row: dict[str, Any] | None = None
        if newest is not None and (
            snapshot is None
            or (newest.created_at is not None and snapshot.created_at is not None and newest.created_at > snapshot.created_at)
        ):
            # The newest ready result was never imported: it is the map until it is.
            legacy_row = await store.get_result(newest.id)
        if legacy_row is not None:
            etag = graph_etag("legacy", legacy_row["id"], str(legacy_row.get("completed_at")), query)
        elif snapshot is not None:
            etag = graph_etag("snapshot", snapshot.id, "", query)
        else:
            raise HTTPException(status_code=404, detail="This project has no map yet.")
        headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
        if _etag_matches(request.headers.get("if-none-match"), etag):
            return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
        if legacy_row is not None:
            payload = await legacy_graph_payload(legacy_row, query, store=store)
        else:
            assert snapshot is not None
            result_id = await reads.ensure_v2_result(snapshot)
            payload = await graph_payload(snapshot, query, store=analysis_store, result_id=result_id)
    except UnknownResultScope as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (MapStoreError, AnalysisStoreError) as exc:
        raise _unavailable() from exc
    return JSONResponse(payload, headers=headers)


@router.post("/projects/{project_id}/generate", status_code=status.HTTP_202_ACCEPTED)
async def generate_project_map(project_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    access = await _readable(project_id, auth)
    access.require("project:update")
    await _generate_limiter.check(auth.user_id)
    try:
        # The service decides: an arguments run once that recipe is registered.
        row = await service.request_generation(project_id, auth.user_id, store=get_store())
    except (MapStoreError, AnalysisStoreError) as exc:
        raise _unavailable() from exc
    except Exception as exc:
        logger.error("map generation for project %s not started: %s", project_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The map generation could not be started.",
        ) from exc
    return {"attempt": service.attempt_payload(row)}


@router.get("/projects/{project_id}/events")
async def project_map_events(
    project_id: str, request: Request, auth: DependencyDirectusSession
) -> StreamingResponse:
    """Generation progress, fact-check changes and new map snapshots for this
    project, as SSE. Executor runs (queued, progress, ready, failed) join the
    stream with `runs=1`, or by themselves once the project has an arguments
    output scope; the map channel alone otherwise."""
    await _readable(project_id, auth)
    runs = request.query_params.get("runs") in ("1", "true") or await _follows_runs(project_id)
    return live_events.sse_response(request, events.map_channels(project_id, runs=runs))


async def _follows_runs(project_id: str) -> bool:
    if not service.generation_recipe_available():
        return False
    try:
        scope = await get_analysis_store().find_scope(
            project_id=project_id, kind=ScopeKind.PRODUCER, owner_id=ARGUMENTS_RECIPE_ID, scope_key=VIEW_SCOPE_KEY
        )
    except AnalysisStoreError as exc:
        logger.warning("map events for project %s follow the map channel only: %s", project_id, exc)
        return False
    return scope is not None


class TitleRequest(BaseModel):
    node_ids: list[str] = Field(min_length=1, max_length=2000)
    # v2: the snapshot the selection was made in and its exact revisions.
    snapshot_id: str | None = None
    revision_ids: list[str] | None = Field(default=None, max_length=2000)


@router.post("/results/{result_id}/title")
async def title_map_selection(
    result_id: str, body: TitleRequest, auth: DependencyDirectusSession
) -> dict[str, Any]:
    target, access = await _result(result_id, auth)
    await _title_limiter.check(auth.user_id)
    project = access.project or {}
    try:
        if isinstance(target, service.SnapshotTarget):
            if body.snapshot_id and body.snapshot_id != target.snapshot.id:
                raise HTTPException(status_code=409, detail="The selection belongs to another snapshot.")
            return await service.snapshot_selection_title(
                target,
                body.revision_ids or body.node_ids,
                project_name=str(project.get("name") or ""),
                project_context=str(project.get("context") or ""),
                analysis_store=get_analysis_store(),
                redis=await get_redis_client(),
            )
        return await service.selection_title(
            target,
            body.node_ids,
            project_name=str(project.get("name") or ""),
            project_context=str(project.get("context") or ""),
            store=get_store(),
            redis=await get_redis_client(),
        )
    except HTTPException:
        raise
    except service.NotReady as exc:
        raise HTTPException(status_code=409, detail="This map is not ready.") from exc
    except (service.UnknownArguments, SelectionTooSmall) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except SelectionTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except (MapStoreError, AnalysisStoreError) as exc:
        raise _unavailable() from exc
    except Exception as exc:
        logger.warning("map title for result %s failed: %s", result_id, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="The title could not be generated."
        ) from exc


@router.get("/results/{result_id}/fact-checks")
async def get_map_fact_checks(result_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    target, _access = await _result(result_id, auth)
    try:
        if isinstance(target, service.SnapshotTarget):
            states = await service.snapshot_fact_check_states(
                target, store=get_store(), analysis_store=get_analysis_store()
            )
            return {"fact_checks": states}
        return {"fact_checks": await service.fact_check_states(target, get_store())}
    except service.NotReady as exc:
        raise HTTPException(status_code=409, detail="This map is not ready.") from exc
    except (MapStoreError, AnalysisStoreError) as exc:
        raise _unavailable() from exc


class FactCheckRequest(BaseModel):
    force: bool = False


@router.post("/results/{result_id}/fact-checks/{node_id}")
async def start_map_fact_check(
    result_id: str,
    node_id: str,
    auth: DependencyDirectusSession,
    body: FactCheckRequest | None = None,
) -> dict[str, Any]:
    target, access = await _result(result_id, auth)
    access.require("project:update")
    await _fact_check_limiter.check(auth.user_id)
    try:
        if isinstance(target, service.SnapshotTarget):
            return await service.start_snapshot_fact_check(
                target,
                node_id,
                requested_by=auth.user_id,
                force=bool(body and body.force),
                store=get_store(),
                analysis_store=get_analysis_store(),
            )
        return await service.start_fact_check(
            target,
            node_id,
            requested_by=auth.user_id,
            force=bool(body and body.force),
            store=get_store(),
        )
    except service.NotReady as exc:
        raise HTTPException(status_code=409, detail="This map is not ready.") from exc
    except (service.UnknownArguments, service.NotAClaim) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (MapStoreError, AnalysisStoreError) as exc:
        raise _unavailable() from exc
    except Exception as exc:
        logger.error("map fact-check for result %s not started: %s", result_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The fact-check could not be started.",
        ) from exc


@router.delete("/results/{result_id}/fact-checks/{node_id}")
async def cancel_map_fact_check(
    result_id: str, node_id: str, auth: DependencyDirectusSession
) -> dict[str, Any]:
    target, access = await _result(result_id, auth)
    access.require("project:update")
    try:
        if isinstance(target, service.SnapshotTarget):
            return await service.cancel_snapshot_fact_check(
                target, node_id, store=get_store(), analysis_store=get_analysis_store()
            )
        return await service.cancel_fact_check(target, node_id, store=get_store())
    except service.NotReady as exc:
        raise HTTPException(status_code=409, detail="This map is not ready.") from exc
    except (service.UnknownArguments, service.NotAClaim) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (MapStoreError, AnalysisStoreError) as exc:
        raise _unavailable() from exc
