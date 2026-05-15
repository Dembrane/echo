"""V2 workspace endpoints — list, create, manage workspaces."""

import asyncio
from typing import Literal, Optional, Annotated
from logging import getLogger
from datetime import datetime, timezone

from fastapi import Depends, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.utils import generate_uuid
from dembrane.app_user import resolve_app_user, get_app_user_or_raise
from dembrane.policies import TIER_ORDER
from dembrane.settings import get_settings
from dembrane.inheritance import get_effective_members
from dembrane.seat_capacity import tier_hard_blocks_seats
from dembrane.api.v2.schemas import (
    MemberPreview,
    WorkspaceUsage,
    WorkspaceSummary,
    OrganisationRollup,
    WorkspaceListResponse,
    CreateWorkspaceRequest,
    CreateWorkspaceResponse,
    PendingWorkspaceRequest,
)
from dembrane.directus_async import async_directus
from dembrane.tier_downgrade import preview_downgrade, apply_downgrade_effects
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context
from dembrane.api.dependency_auth import DependencyDirectusSession

# Reusable Annotated alias mirrors the convention in
# dembrane/api/dependency_auth.py (DependencyDirectusSession). Avoids
# Ruff B008 "Depends() in arg defaults" while keeping handler signatures
# readable.
DependencyWorkspaceContext = Annotated[WorkspaceContext, Depends(get_workspace_context)]

settings = get_settings()

router = APIRouter()
logger = getLogger("api.v2.workspaces")


async def _get_workspace_usage(ws_id: str) -> WorkspaceUsage:
    """Audio hours + conversation count (all-time and current month).

    Hours include soft-deleted rows (PRD §270: delete preserves billable
    duration); counts exclude them.
    """
    projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ws_id},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(projects, list) or len(projects) == 0:
        return WorkspaceUsage()

    project_ids = [p["id"] for p in projects]

    conversations = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "project_id": {"_in": project_ids},
                },
                "fields": ["duration", "created_at", "deleted_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(conversations, list):
        return WorkspaceUsage()

    total_seconds = sum(c.get("duration") or 0 for c in conversations)
    live_count = sum(1 for c in conversations if not c.get("deleted_at"))

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    monthly_seconds = 0
    monthly_live_count = 0
    for c in conversations:
        created_at = c.get("created_at")
        if not created_at or created_at < month_start:
            continue
        monthly_seconds += c.get("duration") or 0
        if not c.get("deleted_at"):
            monthly_live_count += 1

    return WorkspaceUsage(
        audio_hours=round(total_seconds / 3600, 1),
        conversation_count=live_count,
        audio_hours_this_month=round(monthly_seconds / 3600, 1),
        conversations_this_month=monthly_live_count,
    )


async def _get_member_previews(ws_id: str) -> list[MemberPreview]:
    """Get first 4 member avatars for a workspace.

    Uses get_effective_members so derived organisation admins are represented.
    Raw workspace_membership reads would show only direct rows and lie
    about who's on open workspaces. (Audit round 2026-04-21, MEDIUM.)
    """
    from dembrane.inheritance import get_effective_members

    members = await get_effective_members(ws_id)
    if not members:
        return []
    # Direct rows bubble to the top of get_effective_members.sort() so
    # previews are deterministic and prioritise explicit membership.
    user_ids = [m["user_id"] for m in members[:4] if m.get("user_id")]
    if not user_ids:
        return []

    users = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"id": {"_in": user_ids}},
                "fields": ["id", "display_name", "directus_user_id"],
                "limit": 4,
            }
        },
    )
    if not isinstance(users, list):
        return []

    # Fetch avatars from directus_users
    du_ids = [u["directus_user_id"] for u in users if u.get("directus_user_id")]
    avatar_map: dict[str, Optional[str]] = {}
    if du_ids:
        profiles = await async_directus.get_users(
            {"query": {"filter": {"id": {"_in": du_ids}}, "fields": ["id", "avatar"], "limit": 4}}
        )
        if isinstance(profiles, list):
            avatar_map = {u["id"]: u.get("avatar") for u in profiles}

    return [
        MemberPreview(
            display_name=u.get("display_name", ""),
            avatar=avatar_map.get(u.get("directus_user_id", "")),
        )
        for u in users
    ]


@router.get("", response_model=WorkspaceListResponse)
async def list_workspaces(
    auth: DependencyDirectusSession,
) -> WorkspaceListResponse:
    """List all accessible workspaces with usage stats and organisation rollups."""
    app_user = await resolve_app_user(auth.user_id)
    if not app_user:
        return WorkspaceListResponse(workspaces=[], organisations=[])

    app_user_id = app_user["id"]

    # Get all active workspace memberships
    memberships = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["workspace_id", "role", "source", "is_external"],
                "limit": -1,
            }
        },
    )

    if not isinstance(memberships, list):
        memberships = []

    # Org memberships are fetched up front so a user with organisation access but
    # zero direct workspace memberships (e.g. joined the organisation but hasn't
    # been granted any workspace yet) still gets their organisations back. Without
    # this the selector shows "no workspaces yet" and hides the organisation they
    # can actually manage.
    org_membership_data = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {"user_id": {"_eq": app_user_id}, "deleted_at": {"_null": True}},
                "fields": ["org_id", "role"],
                "limit": -1,
            }
        },
    )
    if not isinstance(org_membership_data, list):
        org_membership_data = []

    if len(memberships) == 0 and len(org_membership_data) == 0:
        return WorkspaceListResponse(workspaces=[], organisations=[])

    workspace_ids = [m["workspace_id"] for m in memberships if m.get("workspace_id")]

    # Fetch workspace details — guard against empty _in (some Directus
    # adapters treat that as "no filter" and return every workspace).
    workspaces: list[dict] = []
    if workspace_ids:
        fetched = await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "id": {"_in": workspace_ids},
                        "deleted_at": {"_null": True},
                    },
                    "fields": [
                        "id",
                        "name",
                        "org_id",
                        "is_default",
                        "tier",
                        "downgraded_at",
                        "downgraded_from_tier",
                        "logo_url",
                    ],
                    "limit": -1,
                }
            },
        )
        if isinstance(fetched, list):
            workspaces = fetched

    ws_map = {ws["id"]: ws for ws in workspaces}

    # Fetch org names + logos (logo powers the OrganisationHeroCard on /w).
    # Union the workspaces' orgs with the user's org_memberships so organisations
    # without any workspace yet still show up with a name + logo.
    org_ids = list(
        {
            *(ws.get("org_id") for ws in workspaces if ws.get("org_id")),
            *(om.get("org_id") for om in org_membership_data if om.get("org_id")),
        }
    )
    org_map: dict[str, str] = {}
    org_logo_map: dict[str, Optional[str]] = {}
    if org_ids:
        orgs = await async_directus.get_items(
            "org",
            {
                "query": {
                    "filter": {"id": {"_in": org_ids}},
                    "fields": ["id", "name", "logo_url"],
                    "limit": -1,
                }
            },
        )
        if isinstance(orgs, list):
            org_map = {o["id"]: o.get("name", "") for o in orgs}
            org_logo_map = {o["id"]: o.get("logo_url") for o in orgs}

    # Build workspace summaries with usage — parallelize per-workspace queries
    # Filter to valid memberships first
    valid_memberships = [
        (m, ws_map[m["workspace_id"]]) for m in memberships if ws_map.get(m.get("workspace_id"))
    ]

    async def _get_workspace_aggregates(
        ws_id: str,
    ) -> tuple[int, int, WorkspaceUsage, list[MemberPreview]]:
        """Fetch project count, member count, usage, and member previews in parallel."""
        proj_task = async_directus.get_items(
            "project",
            {
                "query": {
                    "filter": {"workspace_id": {"_eq": ws_id}, "deleted_at": {"_null": True}},
                    "aggregate": {"count": ["id"]},
                }
            },
        )
        mem_task = async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {"workspace_id": {"_eq": ws_id}, "deleted_at": {"_null": True}},
                    "aggregate": {"count": ["id"]},
                }
            },
        )
        usage_task = _get_workspace_usage(ws_id)
        previews_task = _get_member_previews(ws_id)

        proj_count_result, mem_count_result, usage, previews = await asyncio.gather(
            proj_task, mem_task, usage_task, previews_task
        )

        project_count = 0
        if isinstance(proj_count_result, list) and len(proj_count_result) > 0:
            project_count = int(proj_count_result[0].get("count", {}).get("id", 0))
        member_count = 0
        if isinstance(mem_count_result, list) and len(mem_count_result) > 0:
            member_count = int(mem_count_result[0].get("count", {}).get("id", 0))

        return project_count, member_count, usage, previews

    # Run all workspace aggregate queries in parallel across all workspaces
    all_aggregates = await asyncio.gather(
        *[_get_workspace_aggregates(ws["id"]) for _, ws in valid_memberships]
    )

    # Batch-fetch pending workspace_requests for badge rendering on /w
    all_ws_ids = [ws["id"] for _, ws in valid_memberships]
    pending_request_ws_ids: set[str] = set()
    if all_ws_ids:
        pending_reqs = await async_directus.get_items(
            "workspace_request",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_in": all_ws_ids},
                        "status": {"_eq": "pending"},
                    },
                    "fields": ["workspace_id"],
                    "limit": -1,
                }
            },
        )
        if isinstance(pending_reqs, list):
            pending_request_ws_ids = {
                r["workspace_id"] for r in pending_reqs if r.get("workspace_id")
            }

    results: list[WorkspaceSummary] = []
    from dembrane.tier_capacity import next_tier as tier_next, get_capacity, compute_usage_gates
    from dembrane.api.v2.schemas import UsageGatesSummary

    for (membership, ws), (project_count, member_count, usage, previews) in zip(
        valid_memberships, all_aggregates, strict=True
    ):
        # Fill in matrix §8 cap signals on the usage object so card-level
        # rendering doesn't need to join tier → cap client-side.
        tier = ws.get("tier") or ""
        cap = get_capacity(tier)
        if cap and cap.included_hours is not None:
            usage.hours_included = cap.included_hours
            pct = usage.audio_hours_this_month / cap.included_hours if cap.included_hours else 0.0
            usage.hours_pct = round(pct, 3)
            if pct >= 1.0:
                usage.at_cap = True
            elif pct >= 0.8:
                usage.approaching_cap = True
        gates = compute_usage_gates(tier, usage.audio_hours, usage.audio_hours_this_month)
        usage.usage_gates = UsageGatesSummary(
            over_cap_active=gates.over_cap_active,
            uploads_locked=gates.uploads_locked,
            upgrade_cta_tier=tier_next(tier),
        )
        results.append(
            WorkspaceSummary(
                id=ws["id"],
                name=ws.get("name", ""),
                org_id=ws.get("org_id", ""),
                org_name=org_map.get(ws.get("org_id", ""), ""),
                role=membership.get("role", ""),
                is_default=ws.get("is_default", False),
                tier=ws.get("tier", "pioneer"),
                logo_url=ws.get("logo_url"),
                org_logo_url=org_logo_map.get(ws.get("org_id", "")),
                project_count=project_count,
                member_count=member_count,
                is_external=membership.get("is_external", False),
                members_preview=previews,
                usage=usage,
                downgraded_at=ws.get("downgraded_at"),
                downgraded_from_tier=ws.get("downgraded_from_tier"),
                has_pending_upgrade_request=ws["id"] in pending_request_ws_ids,
            )
        )

    # Build organisation rollups (org_membership_data was fetched up front).
    organisations: list[OrganisationRollup] = []
    if org_membership_data:
        # Build org-to-workspaces map and collect all workspace IDs for member queries
        org_organisation_workspaces: dict[str, list[WorkspaceSummary]] = {}
        all_organisation_ws_ids: list[str] = []
        valid_org_memberships = []
        for om in org_membership_data:
            oid = om.get("org_id")
            if not oid:
                continue
            organisation_ws = [w for w in results if w.org_id == oid]
            org_organisation_workspaces[oid] = organisation_ws
            all_organisation_ws_ids.extend(tw.id for tw in organisation_ws)
            valid_org_memberships.append(om)

        # Fetch all workspace memberships for organisation rollups in parallel
        all_organisation_mems = (
            await asyncio.gather(
                *[
                    async_directus.get_items(
                        "workspace_membership",
                        {
                            "query": {
                                "filter": {
                                    "workspace_id": {"_eq": ws_id},
                                    "deleted_at": {"_null": True},
                                },
                                "fields": ["user_id"],
                                "limit": -1,
                            }
                        },
                    )
                    for ws_id in all_organisation_ws_ids
                ]
            )
            if all_organisation_ws_ids
            else []
        )

        # Build ws_id -> member user_ids map
        ws_member_map: dict[str, set[str]] = {}
        for ws_id, mems in zip(all_organisation_ws_ids, all_organisation_mems, strict=True):
            member_ids: set[str] = set()
            if isinstance(mems, list):
                member_ids = {m["user_id"] for m in mems if m.get("user_id")}
            ws_member_map[ws_id] = member_ids

        for om in valid_org_memberships:
            oid = om["org_id"]
            organisation_workspaces = org_organisation_workspaces[oid]
            all_member_ids: set[str] = set()
            for tw in organisation_workspaces:
                all_member_ids.update(ws_member_map.get(tw.id, set()))

            organisations.append(
                OrganisationRollup(
                    id=oid,
                    name=org_map.get(oid, ""),
                    role=om.get("role", ""),
                    logo_url=org_logo_map.get(oid),
                    total_projects=sum(w.project_count for w in organisation_workspaces),
                    total_members=len(all_member_ids),
                    total_audio_hours=round(
                        sum(w.usage.audio_hours for w in organisation_workspaces), 1
                    ),
                    total_conversations=sum(
                        w.usage.conversation_count for w in organisation_workspaces
                    ),
                    workspace_count=len(organisation_workspaces),
                    total_audio_hours_this_month=round(
                        sum(w.usage.audio_hours_this_month for w in organisation_workspaces), 1
                    ),
                    total_conversations_this_month=sum(
                        w.usage.conversations_this_month for w in organisation_workspaces
                    ),
                )
            )

    # Recent removals — only meaningful when the user has no live access
    # (otherwise /w doesn't render the empty state). Skip the query in
    # the common case to keep this endpoint cheap.
    recent_removals: list = []
    if not results and not organisations:
        from datetime import timedelta

        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        removed = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_gte": cutoff},
                    },
                    "fields": ["workspace_id", "deleted_at"],
                    "sort": ["-deleted_at"],
                    "limit": 5,
                }
            },
        )
        if isinstance(removed, list) and removed:
            removed_ws_ids = list({r["workspace_id"] for r in removed if r.get("workspace_id")})
            removed_ws = await async_directus.get_items(
                "workspace",
                {
                    "query": {
                        "filter": {"id": {"_in": removed_ws_ids}},
                        "fields": ["id", "name", "org_id"],
                        "limit": -1,
                    }
                },
            )
            removed_ws_map = (
                {w["id"]: w for w in removed_ws} if isinstance(removed_ws, list) else {}
            )
            # Pull org names for any orgs we didn't already fetch above.
            extra_org_ids = [
                w["org_id"]
                for w in removed_ws_map.values()
                if w.get("org_id") and w["org_id"] not in org_map
            ]
            if extra_org_ids:
                extra_orgs = await async_directus.get_items(
                    "org",
                    {
                        "query": {
                            "filter": {"id": {"_in": extra_org_ids}},
                            "fields": ["id", "name"],
                            "limit": -1,
                        }
                    },
                )
                if isinstance(extra_orgs, list):
                    for o in extra_orgs:
                        org_map[o["id"]] = o.get("name", "")
            from dembrane.api.v2.schemas import RecentRemoval

            for r in removed:
                removed_ws_item = removed_ws_map.get(r.get("workspace_id"))
                if not removed_ws_item:
                    continue
                recent_removals.append(
                    RecentRemoval(
                        workspace_id=removed_ws_item["id"],
                        workspace_name=removed_ws_item.get("name") or "",
                        org_name=org_map.get(removed_ws_item.get("org_id") or "", ""),
                        ended_at=r.get("deleted_at") or "",
                    )
                )

    # Fetch the caller's pending workspace requests (new_workspace + tier_upgrade)
    # so the /w selector can show "request submitted" cards.
    pending_requests_raw = await async_directus.get_items(
        "workspace_request",
        {
            "query": {
                "filter": {
                    "requested_by": {"_eq": app_user_id},
                    "status": {"_eq": "pending"},
                },
                "fields": [
                    "id",
                    "kind",
                    "status",
                    "proposed_name",
                    "proposed_tier",
                    "org_id",
                    "created_at",
                ],
                "sort": ["-created_at"],
                "limit": 20,
            }
        },
    )
    pending_ws_requests: list[PendingWorkspaceRequest] = []
    if isinstance(pending_requests_raw, list):
        for pr in pending_requests_raw:
            pending_ws_requests.append(
                PendingWorkspaceRequest(
                    id=pr["id"],
                    kind=pr.get("kind", ""),
                    status=pr.get("status", "pending"),
                    proposed_name=pr.get("proposed_name"),
                    proposed_tier=pr.get("proposed_tier", ""),
                    org_id=pr.get("org_id", ""),
                    org_name=org_map.get(pr.get("org_id", ""), ""),
                    created_at=pr.get("created_at"),
                )
            )

    return WorkspaceListResponse(
        workspaces=results,
        organisations=organisations,
        recent_removals=recent_removals,
        pending_workspace_requests=pending_ws_requests,
    )


@router.post("", response_model=CreateWorkspaceResponse)
async def create_workspace(
    body: CreateWorkspaceRequest,
    auth: DependencyDirectusSession,
) -> CreateWorkspaceResponse:
    """Create a new workspace. Staff-only — self-serve creation is retired.

    Post-onboarding workspaces go through the workspace_request flow
    (POST /v2/workspace-requests). This endpoint is now the internal
    endpoint called by the approval orchestrator. The onboarding auto-seed
    writes directly to Directus and is unaffected.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only. Use workspace requests.")

    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    # Determine which org to create in
    org_id = body.org_id
    if not org_id:
        orgs = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "user_id": {"_eq": app_user_id},
                        "role": {"_in": ["owner", "admin"]},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["org_id"],
                    "limit": 1,
                }
            },
        )
        if not isinstance(orgs, list) or len(orgs) == 0:
            raise HTTPException(
                status_code=403, detail="No organisation found. Complete onboarding first."
            )
        org_id = orgs[0]["org_id"]

    # Org access check skipped for staff — they can create in any org.
    # The approval orchestrator validates org existence before calling.

    # Matrix §9: new workspaces default to Pilot. Tier upgrades go through
    # the staff upgrade-request flow (matrix §11), never client-driven.
    # Visibility (matrix v1.1 §6) is stored on workspace.visibility — the
    # enum is the sole source of truth on new rows; legacy settings flags
    # are no longer written (resolver still reads them for pre-enum data).
    visibility = "open_to_organisation" if body.inherit_organisation_admins else "private"
    ws_id = generate_uuid()
    await async_directus.create_item(
        "workspace",
        {
            "id": ws_id,
            "org_id": org_id,
            "name": body.name.strip(),
            "tier": "pilot",
            "visibility": visibility,
            "is_default": False,
            "created_by": app_user_id,
        },
    )

    # Insert the creator as source='direct', role='owner'. No settings
    # flags (matrix v1.1 §6 — derivation is retired for new rows).
    from dembrane.inheritance import on_workspace_created

    await on_workspace_created(
        workspace_id=ws_id,
        creator_app_user_id=app_user_id,
    )

    logger.info(
        f"Created workspace {ws_id} '{body.name}' in org {org_id} by {app_user_id} "
        f"(visibility={visibility})"
    )

    # Tell the organisation's other admins/owners that a new workspace exists.
    # Open workspaces are discoverable via the discovery endpoint so they
    # can explicitly join; private workspaces are still discoverable to
    # organisation admins per matrix §6.
    from dembrane.notifications import emit_to_audience, audience_organisation_admins

    creator_row = await async_directus.get_item("app_user", app_user_id)
    creator_name = (creator_row or {}).get("display_name") or "A organisation admin"
    organisation_admin_ids = await audience_organisation_admins(org_id)
    await emit_to_audience(
        organisation_admin_ids,
        actor_user_id=app_user_id,
        event_code="WORKSPACE_CREATED",
        title=f"{creator_name} created {body.name.strip()}",
        message=(
            "The new workspace is open to the organisation — discover it from your organisation page."
            if visibility == "open_to_organisation"
            else "The new workspace is private — only explicitly invited people and organisation admins have access."
        ),
        action="NAVIGATE_WS",
        ref_workspace_id=ws_id,
        ref_org_id=org_id,
    )

    return CreateWorkspaceResponse(
        id=ws_id,
        name=body.name.strip(),
        org_id=org_id,
        tier="pilot",  # Matrix §9: new workspaces default to Pilot.
    )


# ── DELETE workspace ────────────────────────────────────────────────────


@router.delete("/{workspace_id}")
async def delete_workspace(
    ctx: DependencyWorkspaceContext,
) -> dict:
    """Soft-delete a workspace. Admin or owner. Blocked if workspace has
    any non-deleted project — partners wind projects down via the organisation
    admin page's Projects view (matrix §4 + S7).

    Matrix §4 delete-workspace row is ✓ on Admin (with confirmation
    footnote), so we accept admin here. Billing + member still 403.
    """
    if ctx.role not in ("admin", "owner"):
        raise HTTPException(
            status_code=403,
            detail="Only a workspace admin or owner can delete this workspace",
        )

    projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ctx.workspace_id},
                    "deleted_at": {"_null": True},
                },
                "aggregate": {"count": "id"},
            }
        },
    )
    project_count = 0
    if isinstance(projects, list) and projects:
        project_count = int(projects[0].get("count", {}).get("id", 0) or 0)

    if project_count > 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This workspace has {project_count} project(s). "
                "Delete or move them first — you can do this from the organisation's Projects view."
            ),
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    await async_directus.update_item("workspace", ctx.workspace_id, {"deleted_at": now_iso})
    logger.info(f"Deleted workspace {ctx.workspace_id} by {ctx.app_user_id} (role={ctx.role})")
    return {"status": "deleted"}


# ── Tier management (staff-only per D1 / Ask 2s) ────────────────────────


class SetTierRequest(BaseModel):
    tier: Literal["pilot", "pioneer", "innovator", "changemaker", "guardian"]
    reason: str = Field(
        min_length=1,
        max_length=500,
        description="Internal note for the staff audit trail (D17).",
    )


class SetTierResponse(BaseModel):
    workspace_id: str
    previous_tier: str
    new_tier: str
    direction: Literal["upgrade", "downgrade", "no-change"]
    effects_applied: list[dict] = []


@router.patch("/{workspace_id}/tier", response_model=SetTierResponse)
async def set_workspace_tier(
    workspace_id: str,
    body: SetTierRequest,
    auth: DependencyDirectusSession,
) -> SetTierResponse:
    """Staff-only tier change. Applies DOWNGRADE_EFFECTS when going down.

    Direction + reason are logged for the (future) staff audit surface.
    The reason field is required (D17) so every change has a paper trail.
    """
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only action")

    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace or workspace.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    from_tier = workspace.get("tier", "pioneer")
    to_tier = body.tier

    try:
        direction: Literal["upgrade", "downgrade", "no-change"]
        from_idx = TIER_ORDER.index(from_tier)
        to_idx = TIER_ORDER.index(to_tier)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Unknown tier value") from exc

    if from_idx == to_idx:
        direction = "no-change"
    elif to_idx > from_idx:
        direction = "upgrade"
    else:
        direction = "downgrade"

    effects: list[dict] = []
    if direction == "downgrade":
        # Order matters: compute effects on the pre-change state, apply
        # revert mutations, then update the tier. If we updated tier first,
        # has_policy would already be denying policies we need to read.
        effects = await apply_downgrade_effects(workspace_id, from_tier, to_tier)

    # Tier change + downgrade-banner state. On downgrade we stamp
    # downgraded_at + downgraded_from_tier so the frontend renders the
    # 7-day banner (matrix v1.1 §3). On upgrade we clear those so the
    # banner goes away immediately — an upgrade makes the old downgrade
    # irrelevant. No-change: touch nothing.
    now_iso = datetime.now(timezone.utc).isoformat()
    ws_update: dict = {"tier": to_tier}
    if direction == "downgrade":
        ws_update["downgraded_at"] = now_iso
        ws_update["downgraded_from_tier"] = from_tier
    elif direction == "upgrade":
        ws_update["downgraded_at"] = None
        ws_update["downgraded_from_tier"] = None
    await async_directus.update_item("workspace", workspace_id, ws_update)

    # Bust the cached usage rollup so the UI reflects the new tier's
    # caps + rates on the next read. Both the workspace-scope cache and
    # the org-scope aggregate depend on tier info, so bust both.
    if direction != "no-change":
        from dembrane.cache_utils import (
            invalidate_org_usage,
            invalidate_workspace_usage,
        )

        await invalidate_workspace_usage(workspace_id)
        ws_org_id = workspace.get("org_id")
        if ws_org_id:
            await invalidate_org_usage(ws_org_id)

    logger.info(
        f"STAFF tier change: workspace {workspace_id} {from_tier} → {to_tier} "
        f"(direction={direction}, by={auth.user_id}, reason={body.reason!r}, "
        f"effects={[e['policy'] for e in effects]})"
    )

    # Notify workspace admins/owners + billing so they know about the tier
    # change. Staff changes bypass the usual admin flow — without this
    # notification admins would see feature gates flip (or logo disappear)
    # with no explanation. Matrix v1.1 §3 audience = admin + billing.
    if direction != "no-change":
        from dembrane.notifications import (
            emit_to_audience,
            audience_workspace_admins_and_billing,
        )

        ws_name = workspace.get("name", "your workspace")
        if direction == "upgrade":
            title = f"{ws_name} upgraded to {to_tier}"
            message = f"You now have {to_tier}-tier features unlocked."
        else:
            title = f"{ws_name} moved to {to_tier}"
            effect_list = ", ".join(e.get("human", "") for e in effects if e.get("human"))
            message = (
                f"Some features are now limited: {effect_list}."
                if effect_list
                else "Some features are now limited."
            )
        audience = await audience_workspace_admins_and_billing(workspace_id)
        await emit_to_audience(
            audience,
            event_code=("TIER_UPGRADED" if direction == "upgrade" else "TIER_DOWNGRADED"),
            title=title,
            message=message,
            action="NAVIGATE_WS",
            ref_workspace_id=workspace_id,
        )

        # Matrix v1.1 §3 requires a post-downgrade email within 1 minute to
        # every admin + billing user. Queue via Dramatiq network actor
        # (task_send_downgrade_email) so the PATCH returns immediately;
        # the worker picks it up on the next cycle. "Within 1 minute"
        # holds comfortably under normal queue latency.
        if direction == "downgrade" and audience:
            from dembrane.tasks import task_send_downgrade_email

            task_send_downgrade_email.send(
                audience,
                ws_name,
                workspace_id,
                from_tier,
                to_tier,
                effects,
                now_iso,
            )

    return SetTierResponse(
        workspace_id=workspace_id,
        previous_tier=from_tier,
        new_tier=to_tier,
        direction=direction,
        effects_applied=effects,
    )


@router.get("/{workspace_id}/tier/preview-downgrade")
async def preview_workspace_downgrade(
    to_tier: Literal["pilot", "pioneer", "innovator", "changemaker", "guardian"],
    ctx: DependencyWorkspaceContext,
) -> dict:
    """What would a downgrade to `to_tier` do? Read-only — powers the W5
    confirmation dialog copy. Anyone with settings:manage can preview.
    """
    ctx.require_policy("settings:manage")
    current = ctx.workspace.get("tier", "pioneer")
    return {
        "from_tier": current,
        "to_tier": to_tier,
        "effects": await preview_downgrade(ctx.workspace_id, current, to_tier),
    }


# ────────────────────────────────────────────────────────────────────
# Usage rollup (matrix §8)
# ────────────────────────────────────────────────────────────────────


def _calendar_month_bounds(now: datetime, month_offset: int = 0) -> tuple[str, str]:
    """Return (iso_start, iso_end_of_next_month) for the calendar month
    `month_offset` months earlier than the month containing `now`.
    `month_offset=0` is the current month, `1` is last month, etc.
    Month-end is exclusive."""
    # Normalise to the first of this month, then back up N months.
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    year, month = month_start.year, month_start.month
    remaining = month_offset
    while remaining > 0:
        if month == 1:
            year -= 1
            month = 12
        else:
            month -= 1
        remaining -= 1
    month_start = month_start.replace(year=year, month=month)
    if month == 12:
        next_start = month_start.replace(year=year + 1, month=1)
    else:
        next_start = month_start.replace(month=month + 1)
    return month_start.isoformat(), next_start.isoformat()


class ProjectUsageItem(BaseModel):
    id: str
    name: str
    audio_hours: float
    conversation_count: int


class NextTierRecommendation(BaseModel):
    tier: str
    tagline: str
    price_eur_monthly: Optional[int]
    price_note: str
    included_hours: Optional[int]
    included_seats: Optional[int]


class UsageGatesResponse(BaseModel):
    """Workspace-level gate flags for over-cap UI gating."""

    over_cap_active: bool = False
    uploads_locked: bool = False
    upgrade_cta_tier: Optional[str] = None


class WorkspaceUsageResponse(BaseModel):
    # Everyone with workspace:view_usage sees these.
    cycle_start: str
    cycle_end_exclusive: str
    tier: str
    tier_tagline: str
    audio_hours: float
    audio_hours_included: Optional[int]  # None = unlimited
    seat_count: int
    seat_count_included: Optional[int]
    guest_count: int
    project_count: int
    projects: list[ProjectUsageItem]
    pilot_hard_block_active: bool = False  # deprecated: always False, use usage_gates
    # Unified seat cap gate for invite UI. True when seats_used (members +
    # guests) meets or exceeds included_seats on a hard-blocking tier.
    seat_invite_blocked: bool = False
    usage_gates: UsageGatesResponse = UsageGatesResponse()

    # Admin + billing only — None for members.
    overage_forecast_eur: Optional[float] = None
    seat_overage_eur: Optional[float] = None
    next_tier: Optional[NextTierRecommendation] = None


class TierCapacityItem(BaseModel):
    tier: str
    tagline: str
    price_eur_monthly: Optional[int]
    price_note: str
    duration: str
    included_seats: Optional[int]
    seat_overage_eur: Optional[int]
    included_hours: Optional[int]
    hour_overage_eur: Optional[int]
    hard_block_on_hours: bool
    training_included: str


@router.get("/tier-capacities", response_model=list[TierCapacityItem])
async def list_tier_capacities() -> list[TierCapacityItem]:
    """The canonical tier × capacity matrix (matrix §1).

    Static per deployment — clients can cache indefinitely. Authentication
    is not required: this data is public pricing info + lives on the
    product's own pricing page anyway. Served here so every in-product
    surface (upgrade modal, billing tab, pricing comparison) reads from
    a single source.
    """
    from dembrane.tier_capacity import TIER_CAPACITIES

    return [
        TierCapacityItem(
            tier=cap.tier,
            tagline=cap.tagline,
            price_eur_monthly=cap.price_eur_monthly,
            price_note=cap.price_note,
            duration=cap.duration,
            included_seats=cap.included_seats,
            seat_overage_eur=cap.seat_overage_eur,
            included_hours=cap.included_hours,
            hour_overage_eur=cap.hour_overage_eur,
            hard_block_on_hours=cap.hard_block_on_hours,
            training_included=cap.training_included,
        )
        for cap in TIER_CAPACITIES.values()
    ]


@router.get(
    "/{workspace_id}/usage",
    response_model=WorkspaceUsageResponse,
)
async def get_workspace_usage(
    ctx: DependencyWorkspaceContext,
    refresh: bool = False,
    month_offset: int = 0,
) -> WorkspaceUsageResponse:
    """Workspace usage rollup.

    `month_offset` lets admins inspect prior months: 0 = current, 1 = last
    month, etc. Capped at 12 months back to keep cache keys bounded.
    Financial fields (forecast, next-tier) only populate for the current
    month — they describe end-of-cycle behaviour, which is nonsensical
    for a completed month.

    Members see raw numbers. Admin + billing additionally see overage
    forecast and tier recommendation (matrix §8).

    Caching: per-(workspace, month_offset) Redis cache. Current-month
    cache busts on tier change (see set_workspace_tier). Pass
    `?refresh=true` to force a recompute.
    """
    from dembrane.cache_utils import (
        USAGE_TTL_SECONDS,
        cache_get_json,
        cache_set_json,
        usage_cache_key,
    )
    from dembrane.tier_capacity import (
        next_tier as tier_next,
        get_capacity,
        compute_usage_gates,
        compute_hour_overage_eur,
        compute_seat_overage_eur,
    )

    ctx.require_policy("workspace:view_usage")

    # Guest exclusion. Matrix §4 "View usage & overage" row grants Admin /
    # Billing / Member but not Guest. Our preset system gives guests the
    # member preset (guest = is_external=true on a direct row), so we gate
    # here explicitly rather than forking the preset.
    if ctx.is_external:
        raise HTTPException(status_code=403, detail="Guests don't see workspace usage")

    if month_offset < 0 or month_offset > 12:
        raise HTTPException(status_code=400, detail="month_offset must be 0–12")
    is_current_month = month_offset == 0

    # Role-class decides whether financial fields are returned. We always
    # compute + cache the full-admin response; member response nulls the
    # financial fields at serialisation time.
    sees_financials = ctx.has_policy("workspace:view_invoices")

    cache_key = usage_cache_key(ctx.workspace_id)
    if not is_current_month:
        cache_key = f"{cache_key}:m{month_offset}"
    if not refresh:
        cached = await cache_get_json(cache_key)
        if isinstance(cached, dict):
            if not sees_financials:
                cached = {
                    **cached,
                    "overage_forecast_eur": None,
                    "seat_overage_eur": None,
                    "next_tier": None,
                }
            return WorkspaceUsageResponse(**cached)

    now = datetime.now(timezone.utc)
    cycle_start, cycle_end_exclusive = _calendar_month_bounds(now, month_offset)

    # Soft-deleted rows stay in the rollup — PRD §270, delete preserves
    # billable duration. project_count below excludes them.
    # TODO: PRD §218 usage_event table replaces this scan path; until
    # then this fetches every project the workspace has ever had.
    projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ctx.workspace_id},
                },
                "fields": ["id", "name", "deleted_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(projects, list):
        projects = []

    project_ids = [p["id"] for p in projects if p.get("id")]

    if project_ids:
        cycle_task = async_directus.get_items(
            "conversation",
            {
                "query": {
                    "filter": {
                        "project_id": {"_in": project_ids},
                        "created_at": {
                            "_gte": cycle_start,
                            "_lt": cycle_end_exclusive,
                        },
                    },
                    "fields": ["project_id", "duration"],
                    "limit": -1,
                }
            },
        )
        all_time_task = async_directus.get_items(
            "conversation",
            {
                "query": {
                    "filter": {"project_id": {"_in": project_ids}},
                    "fields": ["duration"],
                    "limit": -1,
                }
            },
        )
        conversations, all_time_convs = await asyncio.gather(cycle_task, all_time_task)
    else:
        conversations = []
        all_time_convs = []
    if not isinstance(conversations, list):
        conversations = []
    if not isinstance(all_time_convs, list):
        all_time_convs = []
    hours_lifetime = round(sum(c.get("duration") or 0 for c in all_time_convs) / 3600, 2)

    # Per-project and total aggregates.
    per_project_seconds: dict[str, int] = {}
    per_project_count: dict[str, int] = {}
    total_seconds = 0
    for c in conversations:
        pid = c.get("project_id")
        if not pid:
            continue
        sec = int(c.get("duration") or 0)
        total_seconds += sec
        per_project_seconds[pid] = per_project_seconds.get(pid, 0) + sec
        per_project_count[pid] = per_project_count.get(pid, 0) + 1

    # Show deleted projects in the breakdown only if they had cycle
    # activity — keeps the bill reconcilable without listing empty rows.
    per_project_items = [
        ProjectUsageItem(
            id=p["id"],
            name=p.get("name", ""),
            audio_hours=round(per_project_seconds.get(p["id"], 0) / 3600, 2),
            conversation_count=per_project_count.get(p["id"], 0),
        )
        for p in projects
        if not p.get("deleted_at") or per_project_count.get(p["id"], 0) > 0
    ]

    live_project_count = sum(1 for p in projects if not p.get("deleted_at"))

    audio_hours = round(total_seconds / 3600, 2)

    # Seat + guest count. Reuses inheritance.get_effective_members so the
    # count includes derived org admins/owners — they consume a seat just
    # like direct members ("admin should consume a seat" per matrix §7
    # + product call 2026-05-04). get_effective_members already dedups by
    # user_id with direct-wins-over-derived precedence, so we just bucket
    # the rows here.
    effective_members = await get_effective_members(ctx.workspace_id)

    seat_count = 0
    guest_count = 0
    seat_roles = {"owner", "admin", "member", "billing"}
    for m in effective_members:
        role = m.get("role")
        if m.get("is_external"):
            # Guest bucket. A guest with an elevated role (admin/billing/
            # owner) shouldn't exist — blocked at invite + change-role —
            # but log if we ever see one so ops can spot it. Derived rows
            # are never external (inheritance.py:303), so this only fires
            # on direct rows.
            if role in ("admin", "billing", "owner"):
                logger.warning(
                    "external_with_elevated_role workspace=%s role=%s",
                    ctx.workspace_id,
                    role,
                )
            guest_count += 1
            continue
        if role in seat_roles:
            seat_count += 1

    # Tier capacity lookup. Legacy rows with NULL tier fall through to the
    # unknown-tier path below (unlimited / no block) rather than silently
    # adopting Pilot defaults — the Pilot hard-block is only fair when
    # the workspace was explicitly set to Pilot.
    tier = ctx.workspace.get("tier") or ""
    cap = get_capacity(tier)
    if cap is None:
        # Unknown tier — treat as unlimited / no block. Safer default
        # than crashing on a legacy row.
        tagline = ""
        included_hours: Optional[int] = None
        included_seats: Optional[int] = None
        hard_block = False
    else:
        tagline = cap.tagline
        included_hours = cap.included_hours
        included_seats = cap.included_seats
        hard_block = (
            cap.hard_block_on_hours
            and cap.included_hours is not None
            and audio_hours >= cap.included_hours
        )

    # Always compute the full admin-view payload so the cache holds one
    # variant; members get a filtered copy at serialisation time.
    # Forecast + next-tier describe the current cycle's end state; they're
    # null for historical months (where the cycle already closed).
    if is_current_month:
        overage_forecast = compute_hour_overage_eur(tier, audio_hours)
        seat_overage = compute_seat_overage_eur(tier, seat_count)
        recommended = tier_next(tier)
    else:
        overage_forecast = None
        seat_overage = None
        recommended = None
    next_rec: Optional[NextTierRecommendation] = None
    if recommended:
        rcap = get_capacity(recommended)
        if rcap:
            next_rec = NextTierRecommendation(
                tier=recommended,
                tagline=rcap.tagline,
                price_eur_monthly=rcap.price_eur_monthly,
                price_note=rcap.price_note,
                included_hours=rcap.included_hours,
                included_seats=rcap.included_seats,
            )

    # Unified seat cap gate for invite UI. Members + guests share the pool.
    # Mirrors seat_capacity.assert_can_add_seat with include_pending=True
    # so the UI disables the invite button as soon as the cap is taken.
    from dembrane.seat_capacity import count_pending_invites

    member_pending, guest_pending = await count_pending_invites(ctx.workspace_id)
    total_pending = member_pending + guest_pending
    seats_used = seat_count + guest_count
    seat_invite_blocked = (
        included_seats is not None
        and tier_hard_blocks_seats(tier)
        and (seats_used + total_pending) >= included_seats
    )

    gates_raw = compute_usage_gates(tier, hours_lifetime, audio_hours)
    gates = UsageGatesResponse(
        over_cap_active=gates_raw.over_cap_active,
        uploads_locked=gates_raw.uploads_locked,
        upgrade_cta_tier=tier_next(tier),
    )

    full = WorkspaceUsageResponse(
        cycle_start=cycle_start,
        cycle_end_exclusive=cycle_end_exclusive,
        tier=tier,
        tier_tagline=tagline,
        audio_hours=audio_hours,
        audio_hours_included=included_hours,
        seat_count=seat_count,
        seat_count_included=included_seats,
        guest_count=guest_count,
        project_count=live_project_count,
        projects=per_project_items,
        pilot_hard_block_active=hard_block,
        seat_invite_blocked=seat_invite_blocked,
        usage_gates=gates,
        overage_forecast_eur=overage_forecast,
        seat_overage_eur=seat_overage,
        next_tier=next_rec,
    )

    # Cache the full payload (admin view). Best-effort — failure to cache
    # never breaks the read.
    await cache_set_json(cache_key, full.model_dump(), USAGE_TTL_SECONDS)

    if not sees_financials:
        return WorkspaceUsageResponse(
            **{
                **full.model_dump(),
                "overage_forecast_eur": None,
                "seat_overage_eur": None,
                "next_tier": None,
            }
        )

    return full


# ────────────────────────────────────────────────────────────────────
# Partner handoff (matrix §10)
# ────────────────────────────────────────────────────────────────────


class HandoffInitiateBody(BaseModel):
    target_organisation_id: str
    message: Optional[str] = Field(default=None, max_length=1000)


class HandoffResponse(BaseModel):
    status: Literal["pending", "completed", "cancelled"]
    workspace_id: str
    handoff_target_team_id: Optional[str] = None


async def _caller_admins_organisation(org_id: str, app_user_id: str) -> bool:
    """Helper — is the caller admin/owner on a specific org?"""
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": app_user_id},
                    "role": {"_in": ["admin", "owner"]},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role"],
                "limit": 1,
            }
        },
    )
    return isinstance(rows, list) and bool(rows)


@router.post(
    "/{workspace_id}/handoff/initiate",
    response_model=HandoffResponse,
)
async def initiate_handoff(
    body: HandoffInitiateBody,
    ctx: DependencyWorkspaceContext,
) -> HandoffResponse:
    """Partner admin initiates a handoff to a client organisation.

    Matrix §10: "Partner initiates → client accepts → billing attribution
    flips." This sets the pending state; the target organisation's admins get a
    PARTNER_HANDOFF_PENDING notification and can accept via /handoff/accept.

    Guards: caller must be an admin/owner of the organisation that currently bills
    the workspace (billed_to_team_id if set, else org_id). Workspace
    admin/owner role is not sufficient — handoff is a billing action.
    """
    ws = ctx.workspace
    billing_organisation_id = ws.get("billed_to_team_id") or ws.get("org_id")
    if not billing_organisation_id:
        raise HTTPException(status_code=500, detail="Workspace has no billing organisation set")

    # Caller authority: admin/owner on the billing organisation.
    if not await _caller_admins_organisation(billing_organisation_id, ctx.app_user_id):
        raise HTTPException(
            status_code=403,
            detail="Only the billing organisation's admins can initiate handoff",
        )

    if body.target_organisation_id == billing_organisation_id:
        raise HTTPException(
            status_code=400,
            detail="Target organisation is already the billing organisation",
        )

    # Target organisation must exist (not soft-deleted).
    target = await async_directus.get_item("org", body.target_organisation_id)
    if not target or target.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Target organisation not found")

    if ws.get("handoff_status") == "pending":
        raise HTTPException(
            status_code=409,
            detail="A handoff is already pending on this workspace",
        )

    await async_directus.update_item(
        "workspace",
        ctx.workspace_id,
        {
            "handoff_status": "pending",
            "handoff_target_team_id": body.target_organisation_id,
        },
    )

    # Notify target organisation admins — they're the ones who action it.
    from dembrane.notifications import emit_to_audience, audience_organisation_admins

    ws_name = ws.get("name") or "a workspace"
    target_admins = await audience_organisation_admins(body.target_organisation_id)
    await emit_to_audience(
        target_admins,
        actor_user_id=ctx.app_user_id,
        event_code="PARTNER_HANDOFF_PENDING",
        title=f"{ws_name} is being handed to your organisation",
        message=(
            f"A partner wants to hand {ws_name} over. "
            "Review the workspace and accept the handoff to start billing."
        ),
        action="NAVIGATE_WS",
        ref_workspace_id=ctx.workspace_id,
        ref_org_id=body.target_organisation_id,
    )

    # org/user IDs redacted: CodeQL flags them as sensitive.
    logger.info(
        "handoff_initiated workspace=%s from=[redacted] to=[redacted] by=[redacted]",
        ctx.workspace_id,
    )

    return HandoffResponse(
        status="pending",
        workspace_id=ctx.workspace_id,
        handoff_target_team_id=body.target_organisation_id,
    )


@router.post(
    "/{workspace_id}/handoff/accept",
    response_model=HandoffResponse,
)
async def accept_handoff(
    ctx: DependencyWorkspaceContext,
) -> HandoffResponse:
    """Client organisation admin accepts a pending handoff. Flips the billing
    attribution and clears the pending state."""
    ws = ctx.workspace
    if ws.get("handoff_status") != "pending":
        raise HTTPException(status_code=409, detail="No pending handoff on this workspace")

    target_organisation_id = ws.get("handoff_target_team_id")
    if not target_organisation_id:
        raise HTTPException(
            status_code=500,
            detail="Pending handoff has no target organisation — inconsistent state",
        )

    if not await _caller_admins_organisation(target_organisation_id, ctx.app_user_id):
        raise HTTPException(
            status_code=403,
            detail="Only the target organisation's admins can accept this handoff",
        )

    prior_billing_organisation = ws.get("billed_to_team_id") or ws.get("org_id")

    await async_directus.update_item(
        "workspace",
        ctx.workspace_id,
        {
            "billed_to_team_id": target_organisation_id,
            "effective_client_team_id": target_organisation_id,
            "handoff_status": "completed",
            "handoff_target_team_id": None,
        },
    )

    # Notify both sides: partner loses billing, client gains ownership.
    from dembrane.notifications import emit_to_audience, audience_organisation_admins

    ws_name = ws.get("name") or "a workspace"

    if prior_billing_organisation:
        partner_admins = await audience_organisation_admins(prior_billing_organisation)
        await emit_to_audience(
            partner_admins,
            actor_user_id=ctx.app_user_id,
            event_code="PARTNER_HANDOFF_ACCEPTED",
            title=f"{ws_name} handoff completed",
            message=(
                "The client accepted. Billing has flipped; your organisation no "
                "longer pays this workspace's subscription."
            ),
            action="NAVIGATE_WS",
            ref_workspace_id=ctx.workspace_id,
            ref_org_id=prior_billing_organisation,
        )

    target_admins = await audience_organisation_admins(target_organisation_id)
    await emit_to_audience(
        [uid for uid in target_admins if uid != ctx.app_user_id],
        actor_user_id=ctx.app_user_id,
        event_code="PARTNER_HANDOFF_ACCEPTED",
        title=f"{ws_name} is now yours",
        message="Your organisation now owns this workspace's subscription.",
        action="NAVIGATE_WS",
        ref_workspace_id=ctx.workspace_id,
        ref_org_id=target_organisation_id,
    )

    # org/user IDs redacted: CodeQL flags them as sensitive.
    logger.info(
        "handoff_accepted workspace=%s from=[redacted] to=[redacted] by=[redacted]",
        ctx.workspace_id,
    )

    return HandoffResponse(status="completed", workspace_id=ctx.workspace_id)


@router.post(
    "/{workspace_id}/handoff/cancel",
    response_model=HandoffResponse,
)
async def cancel_handoff(
    ctx: DependencyWorkspaceContext,
) -> HandoffResponse:
    """Initiating organisation (current billing organisation) can cancel a pending handoff."""
    ws = ctx.workspace
    if ws.get("handoff_status") != "pending":
        raise HTTPException(status_code=409, detail="No pending handoff to cancel")

    billing_organisation_id = ws.get("billed_to_team_id") or ws.get("org_id")
    if not billing_organisation_id or not await _caller_admins_organisation(
        billing_organisation_id, ctx.app_user_id
    ):
        raise HTTPException(
            status_code=403,
            detail="Only the initiating organisation's admins can cancel",
        )

    await async_directus.update_item(
        "workspace",
        ctx.workspace_id,
        {"handoff_status": None, "handoff_target_team_id": None},
    )

    logger.info(
        "handoff_cancelled workspace=%s by=%s",
        ctx.workspace_id,
        ctx.app_user_id,
    )

    return HandoffResponse(status="cancelled", workspace_id=ctx.workspace_id)
