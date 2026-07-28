"""Client-facing staff support access: audit log + request approve/deny.

Workspace admins resolve requests and read history here. All gated on
settings:manage (the same policy that guards the allow_support_access toggle).
"""

from typing import Any, Optional, Annotated
from logging import getLogger
from datetime import datetime, timezone

from fastapi import Query, Depends, APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context

router = APIRouter()
logger = getLogger("api.v2.support_access")

DependencyWorkspaceContext = Annotated[WorkspaceContext, Depends(get_workspace_context)]


# ── Audit log ──


class SupportAccessEventOut(BaseModel):
    id: str
    event_code: str
    created_at: Optional[str] = None
    actor_name: Optional[str] = None
    staff_name: Optional[str] = None
    params: Optional[dict[str, Any]] = None


class SupportAccessEventsResponse(BaseModel):
    events: list[SupportAccessEventOut]
    has_more: bool


async def _names_for(user_ids: list[str]) -> dict[str, str]:
    ids = [u for u in user_ids if u]
    if not ids:
        return {}
    rows = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"id": {"_in": ids}},
                "fields": ["id", "display_name"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return {}
    return {str(r["id"]): r.get("display_name") or "" for r in rows if r.get("id")}


@router.get(
    "/{workspace_id}/support-access/events",
    response_model=SupportAccessEventsResponse,
)
async def list_support_access_events(
    ctx: DependencyWorkspaceContext,
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
) -> SupportAccessEventsResponse:
    """The workspace's staff-access history, newest first."""
    ctx.require_policy("settings:manage")

    from dembrane.support_access import EVENT_COLLECTION

    rows = await async_directus.get_items(
        EVENT_COLLECTION,
        {
            "query": {
                "filter": {"workspace_id": {"_eq": ctx.workspace_id}},
                "fields": [
                    "id",
                    "event_code",
                    "created_at",
                    "actor_user_id",
                    "staff_user_id",
                    "params",
                ],
                "sort": ["-created_at"],
                "limit": limit + 1,
                "offset": (page - 1) * limit,
            }
        },
    )
    rows = rows if isinstance(rows, list) else []
    has_more = len(rows) > limit
    rows = rows[:limit]
    names = await _names_for(
        [r.get("actor_user_id") for r in rows] + [r.get("staff_user_id") for r in rows]
    )
    return SupportAccessEventsResponse(
        events=[
            SupportAccessEventOut(
                id=str(r["id"]),
                event_code=r.get("event_code") or "",
                created_at=r.get("created_at"),
                actor_name=names.get(str(r.get("actor_user_id"))) or None,
                staff_name=names.get(str(r.get("staff_user_id"))) or None,
                params=r.get("params") or {},
            )
            for r in rows
        ],
        has_more=has_more,
    )


# ── Pending requests + approve / deny ──


class PendingSupportRequestOut(BaseModel):
    id: str
    requested_by_name: str
    message: Optional[str] = None
    created_at: Optional[str] = None
    expires_at: Optional[str] = None


class PendingSupportRequestsResponse(BaseModel):
    requests: list[PendingSupportRequestOut]


class ResolveSupportRequestResponse(BaseModel):
    status: str
    expires_at: Optional[str] = None


@router.get(
    "/{workspace_id}/support-access/requests",
    response_model=PendingSupportRequestsResponse,
)
async def list_pending_support_requests(
    ctx: DependencyWorkspaceContext,
) -> PendingSupportRequestsResponse:
    ctx.require_policy("settings:manage")

    from dembrane.support_access import REQUEST_COLLECTION

    rows = await async_directus.get_items(
        REQUEST_COLLECTION,
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ctx.workspace_id},
                    "status": {"_eq": "pending"},
                },
                "fields": [
                    "id",
                    "requested_by",
                    "message",
                    "created_at",
                    "expires_at",
                ],
                "sort": ["-created_at"],
                "limit": -1,
            }
        },
    )
    rows = rows if isinstance(rows, list) else []
    names = await _names_for([r.get("requested_by") for r in rows])
    return PendingSupportRequestsResponse(
        requests=[
            PendingSupportRequestOut(
                id=str(r["id"]),
                requested_by_name=names.get(str(r.get("requested_by"))) or "dembrane staff",
                message=r.get("message"),
                created_at=r.get("created_at"),
                expires_at=r.get("expires_at"),
            )
            for r in rows
        ]
    )


async def _load_pending_request(ctx: WorkspaceContext, request_id: str) -> dict:
    """Fetch + validate a pending request. 404 wrong-workspace/missing; 409 if
    already resolved, including a lazy-expire when the timer hasn't fired."""
    from dembrane.support_access import (
        REQUEST_COLLECTION,
        EVENT_REQUEST_EXPIRED,
        record_support_access_event,
    )

    req = await async_directus.get_item(REQUEST_COLLECTION, request_id)
    if not req or str(req.get("workspace_id")) != str(ctx.workspace_id):
        raise HTTPException(status_code=404, detail="Request not found")
    if req.get("status") != "pending":
        raise HTTPException(status_code=409, detail=f"Request is already {req.get('status')}.")
    expires_at = req.get("expires_at")
    if expires_at and expires_at <= datetime.now(timezone.utc).isoformat():
        await async_directus.update_item(
            REQUEST_COLLECTION,
            request_id,
            {
                "status": "expired",
                "resolved_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        await record_support_access_event(
            workspace_id=ctx.workspace_id,
            event_code=EVENT_REQUEST_EXPIRED,
            staff_user_id=req.get("requested_by"),
            params={"request_id": request_id},
        )
        raise HTTPException(status_code=409, detail="Request expired.")
    return req


@router.post(
    "/{workspace_id}/support-access/requests/{request_id}/approve",
    response_model=ResolveSupportRequestResponse,
)
async def approve_support_request(
    request_id: str,
    ctx: DependencyWorkspaceContext,
) -> ResolveSupportRequestResponse:
    """Approve a pending request: one-time 24h grant, toggle stays off."""
    ctx.require_policy("settings:manage")

    from dembrane.support_access import (
        REQUEST_COLLECTION,
        EVENT_REQUEST_APPROVED,
        grant_support_membership,
        record_support_access_event,
    )
    from dembrane.scheduled_tasks import TASK_EXPIRE_SUPPORT_REQUEST, cancel_pending_tasks

    req = await _load_pending_request(ctx, request_id)
    staff_app_user_id = str(req.get("requested_by"))

    _status, membership_id, expires_iso = await grant_support_membership(
        workspace_id=ctx.workspace_id,
        app_user_id=staff_app_user_id,
        org_id=ctx.workspace.get("org_id"),
    )
    await async_directus.update_item(
        REQUEST_COLLECTION,
        request_id,
        {
            "status": "approved",
            "resolved_at": datetime.now(timezone.utc).isoformat(),
            "resolved_by": ctx.app_user_id,
            "membership_id": membership_id,
        },
    )
    await cancel_pending_tasks(
        task_type=TASK_EXPIRE_SUPPORT_REQUEST,
        payload_match={"request_id": request_id},
    )
    await record_support_access_event(
        workspace_id=ctx.workspace_id,
        event_code=EVENT_REQUEST_APPROVED,
        actor_user_id=ctx.app_user_id,
        staff_user_id=staff_app_user_id,
        params={
            "request_id": request_id,
            "membership_id": membership_id,
            "expires_at": expires_iso,
        },
    )
    logger.info(
        "support request %s approved on workspace %s (membership=%s)",
        request_id,
        ctx.workspace_id,
        membership_id,
    )
    return ResolveSupportRequestResponse(status="approved", expires_at=expires_iso)


@router.post(
    "/{workspace_id}/support-access/requests/{request_id}/deny",
    response_model=ResolveSupportRequestResponse,
)
async def deny_support_request(
    request_id: str,
    ctx: DependencyWorkspaceContext,
) -> ResolveSupportRequestResponse:
    ctx.require_policy("settings:manage")

    from dembrane.support_access import (
        REQUEST_COLLECTION,
        EVENT_REQUEST_DENIED,
        record_support_access_event,
    )
    from dembrane.scheduled_tasks import TASK_EXPIRE_SUPPORT_REQUEST, cancel_pending_tasks

    req = await _load_pending_request(ctx, request_id)
    await async_directus.update_item(
        REQUEST_COLLECTION,
        request_id,
        {
            "status": "denied",
            "resolved_at": datetime.now(timezone.utc).isoformat(),
            "resolved_by": ctx.app_user_id,
        },
    )
    await cancel_pending_tasks(
        task_type=TASK_EXPIRE_SUPPORT_REQUEST,
        payload_match={"request_id": request_id},
    )
    await record_support_access_event(
        workspace_id=ctx.workspace_id,
        event_code=EVENT_REQUEST_DENIED,
        actor_user_id=ctx.app_user_id,
        staff_user_id=str(req.get("requested_by")),
        params={"request_id": request_id},
    )
    return ResolveSupportRequestResponse(status="denied")
