"""BFF endpoints for Map: saved maps, generation, selection titles, fact-checks.

Reading a map needs project and conversation read access (the evidence is
transcript text). Starting a generation or a fact-check writes shared state and
needs `project:update`. Result-scoped routes resolve the result to its project
before any access check, so a result id from another project is a 404.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request, Response, APIRouter, HTTPException, status
from pydantic import Field, BaseModel
from fastapi.responses import JSONResponse, StreamingResponse

from dembrane import live_events
from dembrane.map import service, transcripts
from dembrane.map.store import MapStore, SqlMapStore, MapStoreError
from dembrane.map.events import project_channel
from dembrane.map.recipe import SelectionTooLarge, SelectionTooSmall
from dembrane.redis_async import get_redis_client
from dembrane.api.rate_limit import RedisUserRateLimiter
from dembrane.api.v2.bff._access import ResourceAccess, resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = logging.getLogger("api.v2.bff.map")

router = APIRouter()

_generate_limiter = RedisUserRateLimiter(key="map_generate", capacity=10, window_seconds=600)
_title_limiter = RedisUserRateLimiter(key="map_title", capacity=60, window_seconds=60)
_fact_check_limiter = RedisUserRateLimiter(key="map_fact_check", capacity=120, window_seconds=60)


def get_store() -> MapStore:
    return SqlMapStore()


def _unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Map storage is unavailable."
    )


async def _readable(project_id: str, auth: DependencyDirectusSession) -> ResourceAccess:
    access = await resolve_project_access(project_id, auth)
    access.require("project:read")
    access.require("conversation:read")
    return access


async def _result(
    result_id: str, auth: DependencyDirectusSession
) -> tuple[dict[str, Any], ResourceAccess]:
    try:
        row = await get_store().get_result(result_id)
    except MapStoreError as exc:
        raise _unavailable() from exc
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Map not found")
    access = await _readable(row["project_id"], auth)
    return row, access


def _etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    return any(candidate.strip() in (etag, "*") for candidate in header.split(","))


@router.get("/projects/{project_id}")
async def get_project_map(
    project_id: str, request: Request, auth: DependencyDirectusSession
) -> Response:
    """The project's current map revision, any newer attempt, and how many of
    its conversations a generation would read.

    Served with an ETag: the page reloads this on every stream (re)connect, and
    a browser revalidating an unchanged map gets a 304 instead of every vector
    again."""
    await _readable(project_id, auth)
    store = get_store()
    try:
        current, attempt = await service.project_rows(project_id, store)
    except MapStoreError as exc:
        raise _unavailable() from exc
    try:
        conversations: int | None = await transcripts.count_conversations_with_transcripts(
            project_id
        )
    except Exception as exc:  # the count is a hint; the map itself still loads
        logger.warning("map source count failed for project %s: %s", project_id, exc)
        conversations = None
    etag = service.state_etag(current, attempt, conversations)
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    try:
        payload = await service.state_payload(current, attempt, store)
    except MapStoreError as exc:
        raise _unavailable() from exc
    payload["source"] = {"conversations_with_transcripts": conversations}
    return JSONResponse(payload, headers=headers)


@router.post("/projects/{project_id}/generate", status_code=status.HTTP_202_ACCEPTED)
async def generate_project_map(project_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    access = await _readable(project_id, auth)
    access.require("project:update")
    await _generate_limiter.check(auth.user_id)
    try:
        row = await service.request_generation(project_id, auth.user_id, store=get_store())
    except MapStoreError as exc:
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
    """Generation progress and fact-check changes for this project, as SSE."""
    await _readable(project_id, auth)
    return live_events.sse_response(request, [project_channel(project_id)])


class TitleRequest(BaseModel):
    node_ids: list[str] = Field(min_length=1, max_length=2000)


@router.post("/results/{result_id}/title")
async def title_map_selection(
    result_id: str, body: TitleRequest, auth: DependencyDirectusSession
) -> dict[str, Any]:
    row, access = await _result(result_id, auth)
    await _title_limiter.check(auth.user_id)
    project = access.project or {}
    try:
        return await service.selection_title(
            row,
            body.node_ids,
            project_name=str(project.get("name") or ""),
            project_context=str(project.get("context") or ""),
            store=get_store(),
            redis=await get_redis_client(),
        )
    except service.NotReady as exc:
        raise HTTPException(status_code=409, detail="This map is not ready.") from exc
    except (service.UnknownArguments, SelectionTooSmall) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except SelectionTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except MapStoreError as exc:
        raise _unavailable() from exc
    except Exception as exc:
        logger.warning("map title for result %s failed: %s", result_id, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="The title could not be generated."
        ) from exc


@router.get("/results/{result_id}/fact-checks")
async def get_map_fact_checks(result_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    row, _access = await _result(result_id, auth)
    try:
        return {"fact_checks": await service.fact_check_states(row, get_store())}
    except service.NotReady as exc:
        raise HTTPException(status_code=409, detail="This map is not ready.") from exc
    except MapStoreError as exc:
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
    row, access = await _result(result_id, auth)
    access.require("project:update")
    await _fact_check_limiter.check(auth.user_id)
    try:
        return await service.start_fact_check(
            row,
            node_id,
            requested_by=auth.user_id,
            force=bool(body and body.force),
            store=get_store(),
        )
    except service.NotReady as exc:
        raise HTTPException(status_code=409, detail="This map is not ready.") from exc
    except (service.UnknownArguments, service.NotAClaim) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except MapStoreError as exc:
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
    row, access = await _result(result_id, auth)
    access.require("project:update")
    try:
        return await service.cancel_fact_check(row, node_id, store=get_store())
    except service.NotReady as exc:
        raise HTTPException(status_code=409, detail="This map is not ready.") from exc
    except (service.UnknownArguments, service.NotAClaim) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except MapStoreError as exc:
        raise _unavailable() from exc
