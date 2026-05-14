"""Workspace request endpoints — submit, list, decide."""

from typing import Literal, Optional, Annotated
from logging import getLogger

from fastapi import Depends, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.email import send_email
from dembrane.utils import generate_uuid
from dembrane.app_user import get_app_user_or_raise
from dembrane.policies import TIER_ORDER
from dembrane.settings import get_settings
from dembrane.notifications import audience_staff, emit_to_audience
from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.workspace_requests")

PAID_TIERS: list[str] = [t for t in TIER_ORDER if t != "free"]


async def _resolve_emails(app_user_ids: list[str]) -> list[str]:
    """Resolve app_user IDs to email addresses, deduped and sorted."""
    if not app_user_ids:
        return []
    try:
        rows = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": app_user_ids}},
                    "fields": ["email"],
                    "limit": -1,
                }
            },
        )
        if not isinstance(rows, list):
            return []
        return sorted(
            {(r.get("email") or "").strip() for r in rows if isinstance(r, dict) and r.get("email")}
        )
    except Exception:  # noqa: BLE001 — best-effort
        return []


class SubmitWorkspaceRequest(BaseModel):
    kind: Literal["new_workspace", "tier_upgrade"]
    org_id: str
    workspace_id: Optional[str] = None
    proposed_name: Optional[str] = Field(default=None, max_length=100)
    proposed_tier: Literal["pilot", "pioneer", "innovator", "changemaker", "guardian"] = "innovator"
    proposed_visibility: Literal["open_to_organisation", "private"] = "open_to_organisation"
    requester_message: Optional[str] = Field(default=None, max_length=1000)


class SubmitWorkspaceRequestResponse(BaseModel):
    id: str
    status: str
    kind: str


@router.post("", response_model=SubmitWorkspaceRequestResponse)
async def submit_workspace_request(
    body: SubmitWorkspaceRequest,
    auth: DependencyDirectusSession,
) -> SubmitWorkspaceRequestResponse:
    """Submit a workspace request (new workspace or tier upgrade).

    Role validation:
    - kind=new_workspace: user must be org admin or owner on the target org.
    - kind=tier_upgrade: user must be workspace admin or billing on the
      target workspace.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    if body.kind == "new_workspace":
        if not body.proposed_name or not body.proposed_name.strip():
            raise HTTPException(
                status_code=400, detail="proposed_name is required for new_workspace"
            )
        org_access = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": body.org_id},
                        "user_id": {"_eq": app_user_id},
                        "role": {"_in": ["owner", "admin"]},
                        "deleted_at": {"_null": True},
                    },
                    "limit": 1,
                }
            },
        )
        if not isinstance(org_access, list) or len(org_access) == 0:
            raise HTTPException(
                status_code=403,
                detail="Must be organisation admin or owner to request a new workspace",
            )
    elif body.kind == "tier_upgrade":
        if not body.workspace_id:
            raise HTTPException(status_code=400, detail="workspace_id is required for tier_upgrade")
        ws_membership = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": body.workspace_id},
                        "user_id": {"_eq": app_user_id},
                        "role": {"_in": ["owner", "admin", "billing"]},
                        "deleted_at": {"_null": True},
                    },
                    "limit": 1,
                }
            },
        )
        if not isinstance(ws_membership, list) or len(ws_membership) == 0:
            raise HTTPException(
                status_code=403,
                detail="Must be workspace admin or billing to request a tier upgrade",
            )

        # Validate org_id matches the workspace's actual org
        ws = await async_directus.get_item("workspace", body.workspace_id)
        if ws and ws.get("org_id") != body.org_id:
            raise HTTPException(
                status_code=400,
                detail="org_id does not match the workspace's organisation",
            )

        # Block duplicate in-flight upgrade requests for the same workspace
        existing = await async_directus.get_items(
            "workspace_request",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": body.workspace_id},
                        "kind": {"_eq": "tier_upgrade"},
                        "status": {"_eq": "pending"},
                    },
                    "limit": 1,
                }
            },
        )
        if isinstance(existing, list) and len(existing) > 0:
            raise HTTPException(
                status_code=409,
                detail="An upgrade request is already pending for this workspace",
            )

    req_id = generate_uuid()
    row = {
        "id": req_id,
        "kind": body.kind,
        "status": "pending",
        "requested_by": app_user_id,
        "org_id": body.org_id,
        "workspace_id": body.workspace_id,
        "proposed_name": body.proposed_name.strip() if body.proposed_name else None,
        "proposed_tier": body.proposed_tier,
        "proposed_visibility": body.proposed_visibility,
        "requester_message": body.requester_message,
    }
    try:
        await async_directus.create_item("workspace_request", row)
    except Exception as exc:
        logger.error("Failed to create workspace_request: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Could not create the workspace request. Please try again later.",
        ) from exc

    logger.info(
        "workspace_request_submitted id=%s kind=%s tier=%s by=%s",
        req_id,
        body.kind,
        body.proposed_tier,
        app_user_id,
    )

    # Notify all staff (in-app) + email
    requester_name = app_user.get("display_name") or "A user"
    requester_email = app_user.get("email") or ""
    org_name = ""
    try:
        org = await async_directus.get_item("org", body.org_id)
        org_name = (org or {}).get("name", "")
    except Exception:  # noqa: BLE001 — best-effort
        pass
    kind_label = "new workspace" if body.kind == "new_workspace" else "tier upgrade"

    staff_ids = await audience_staff()
    await emit_to_audience(
        staff_ids,
        actor_user_id=app_user_id,
        event_code="WORKSPACE_REQUEST_SUBMITTED",
        title=f"{requester_name} requested a {kind_label}",
        message=f"{org_name} \u00b7 {body.proposed_tier}" if org_name else body.proposed_tier,
        action="NAVIGATE_ADMIN_UPGRADES",
        ref_org_id=body.org_id,
        ref_workspace_id=body.workspace_id,
    )

    settings = get_settings()
    base = (settings.urls.admin_base_url or "").rstrip("/")
    admin_url = f"{base}/admin/upgrades"

    staff_emails = await _resolve_emails(staff_ids)
    if staff_emails:
        from datetime import datetime, timezone

        from dembrane.email_throttle import queue_digest_item, record_and_check_throttle

        summary = f"{requester_name} requested a {kind_label}"
        if org_name:
            summary += f" ({org_name} \u00b7 {body.proposed_tier})"

        for staff_email_addr in staff_emails:
            decision = await record_and_check_throttle(
                staff_email_addr,
                "WORKSPACE_REQUEST_SUBMITTED",
            )
            if decision == "individual":
                await send_email(
                    to=staff_email_addr,
                    subject=f"Workspace request: {requester_name} \u00b7 {kind_label}",
                    template="workspace_request_submitted",
                    template_data={
                        "requester_name": requester_name,
                        "requester_email": requester_email,
                        "kind_label": kind_label,
                        "org_name": org_name,
                        "proposed_tier": body.proposed_tier,
                        "proposed_name": body.proposed_name,
                        "requester_message": body.requester_message,
                        "admin_url": admin_url,
                    },
                )
            else:
                await queue_digest_item(
                    staff_email_addr,
                    {
                        "event_code": "WORKSPACE_REQUEST_SUBMITTED",
                        "summary": summary,
                        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                        "admin_url": admin_url,
                    },
                )

    return SubmitWorkspaceRequestResponse(
        id=req_id,
        status="pending",
        kind=body.kind,
    )


DependencyWorkspaceContext = Annotated[WorkspaceContext, Depends(get_workspace_context)]


class WorkspaceRequestHistoryItem(BaseModel):
    id: str
    kind: str
    status: str
    proposed_tier: str
    requester_message: Optional[str] = None
    requester_name: Optional[str] = None
    granted_tier: Optional[str] = None
    granted_tier_expires_at: Optional[str] = None
    denial_reason: Optional[str] = None
    decided_at: Optional[str] = None
    created_at: Optional[str] = None


class WorkspaceRequestHistoryResponse(BaseModel):
    requests: list[WorkspaceRequestHistoryItem]
    has_pending: bool


history_router = APIRouter()


@history_router.get(
    "/{workspace_id}/requests",
    response_model=WorkspaceRequestHistoryResponse,
)
async def list_workspace_request_history(
    ctx: DependencyWorkspaceContext,
) -> WorkspaceRequestHistoryResponse:
    """Workspace request history visible to workspace members.

    Admin/owner/billing see all requests for the workspace.
    Regular members see only their own requests.
    """
    workspace_id = ctx.workspace_id
    is_manager = ctx.role in ("admin", "owner", "billing")

    filt: dict = {
        "workspace_id": {"_eq": workspace_id},
    }
    if not is_manager:
        filt["requested_by"] = {"_eq": ctx.app_user_id}

    rows = await async_directus.get_items(
        "workspace_request",
        {
            "query": {
                "filter": filt,
                "fields": [
                    "id",
                    "kind",
                    "status",
                    "proposed_tier",
                    "requester_message",
                    "requested_by",
                    "granted_tier",
                    "granted_tier_expires_at",
                    "denial_reason",
                    "decided_at",
                    "created_at",
                ],
                "sort": ["-created_at"],
                "limit": 50,
            }
        },
    )
    if not isinstance(rows, list):
        rows = []

    # Resolve requester names (for admin view)
    requester_ids = sorted({r.get("requested_by") for r in rows if r.get("requested_by")})
    name_map: dict[str, str] = {}
    if requester_ids and is_manager:
        users = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": requester_ids}},
                    "fields": ["id", "display_name"],
                    "limit": -1,
                }
            },
        )
        if isinstance(users, list):
            name_map = {u["id"]: u.get("display_name") or "" for u in users if u.get("id")}

    items = []
    has_pending = False
    for r in rows:
        if r.get("status") == "pending":
            has_pending = True
        items.append(
            WorkspaceRequestHistoryItem(
                id=r["id"],
                kind=r.get("kind", ""),
                status=r.get("status", ""),
                proposed_tier=r.get("proposed_tier", ""),
                requester_message=r.get("requester_message"),
                requester_name=name_map.get(r.get("requested_by", "")) if is_manager else None,
                granted_tier=r.get("granted_tier"),
                granted_tier_expires_at=r.get("granted_tier_expires_at"),
                denial_reason=r.get("denial_reason"),
                decided_at=r.get("decided_at"),
                created_at=r.get("created_at"),
            )
        )

    return WorkspaceRequestHistoryResponse(requests=items, has_pending=has_pending)
