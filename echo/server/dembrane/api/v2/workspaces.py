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
from dembrane.seat_capacity import tier_hard_blocks_seats
from dembrane.api.v2.schemas import (
    MemberPreview,
    WorkspaceUsage,
    WorkspaceSummary,
    OrganisationRollup,
    WorkspaceListResponse,
    CreateWorkspaceRequest,
    CreateWorkspaceResponse,
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
    # For the data-owner self-view (ISSUE-026): compare the workspace's
    # data_owner_email against the current user's email.
    me_email = (app_user.get("email") or "").strip().lower()

    # Get all active workspace memberships
    memberships = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["workspace_id", "role", "source"],
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
    internal_org_ids = {om["org_id"] for om in org_membership_data if om.get("org_id")}

    if len(memberships) == 0 and len(org_membership_data) == 0:
        return WorkspaceListResponse(workspaces=[], organisations=[])

    workspace_ids = [m["workspace_id"] for m in memberships if m.get("workspace_id")]

    # Fetch workspace details — guard against empty _in (some Directus
    # adapters treat that as "no filter" and return every workspace).
    from dembrane.billing_account import nested_billing_fields, billing_from_workspace

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
                        "logo_url",
                        "created_at",
                        # Account scope → pooled (org) vs billed-on-its-own.
                        "billing_account_id.org_id",
                        # Data owner of an external-client workspace (ISSUE-026).
                        "data_owner_email",
                        *nested_billing_fields(),
                    ],
                    "limit": -1,
                }
            },
        )
        if isinstance(fetched, list):
            workspaces = fetched

    for ws in workspaces:
        ws.update(billing_from_workspace(ws))
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
                    # Exclude staff_support so support access never inflates the count.
                    "filter": {
                        "workspace_id": {"_eq": ws_id},
                        "deleted_at": {"_null": True},
                        "source": {"_neq": "staff_support"},
                    },
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

    results: list[WorkspaceSummary] = []
    from dembrane.tier_capacity import next_tier as tier_next, get_capacity, compute_usage_gates
    from dembrane.api.v2.schemas import UsageGatesSummary

    for (membership, ws), (project_count, member_count, usage, previews) in zip(
        valid_memberships, all_aggregates, strict=True
    ):
        org_id = ws.get("org_id", "")
        raw_role = membership.get("role", "")
        source = membership.get("source", "")
        # Preserve the free read-only observer role verbatim (Wave G) — it is a
        # distinct outsider role and must NOT be collapsed into "external", or
        # the frontend would treat the observer as a chat-capable external and
        # skip the read-only wall.
        if raw_role == "observer":
            role = "observer"
        else:
            is_external_access = raw_role == "external" or (
                source == "direct" and org_id not in internal_org_ids
            )
            role = "external" if is_external_access else raw_role
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
                org_id=org_id,
                org_name=org_map.get(org_id, ""),
                role=role,
                is_default=ws.get("is_default", False),
                tier=ws.get("tier", "pioneer"),
                bills_separately=(
                    isinstance(ws.get("billing_account_id"), dict)
                    and not ws["billing_account_id"].get("org_id")
                ),
                is_data_owner=bool(me_email)
                and (ws.get("data_owner_email") or "").strip().lower() == me_email,
                logo_url=ws.get("logo_url"),
                org_logo_url=org_logo_map.get(org_id),
                project_count=project_count,
                member_count=member_count,
                members_preview=previews,
                usage=usage,
                downgraded_at=ws.get("downgraded_at"),
                downgraded_from_tier=ws.get("downgraded_from_tier"),
                created_at=ws.get("created_at"),
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

    return WorkspaceListResponse(
        workspaces=results,
        organisations=organisations,
        recent_removals=recent_removals,
    )


async def _is_org_member_by_email(org_id: str, email: str) -> bool:
    """Whether `email` belongs to an active member of `org_id` (ISSUE-026 guard).

    Used to reject naming an existing org member as an external workspace's data
    owner — the data owner must be outside the org for the separate
    compliance/billing context to make sense.
    """
    users = await async_directus.get_items(
        "app_user",
        {"query": {"filter": {"email": {"_eq": email}}, "fields": ["id"], "limit": 1}},
    )
    if not isinstance(users, list) or not users:
        return False
    uid = users[0].get("id")
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": uid},
                    "deleted_at": {"_null": True},
                },
                "limit": 1,
            }
        },
    )
    return isinstance(rows, list) and len(rows) > 0


async def _invite_data_owner_observer(
    *,
    workspace_id: str,
    workspace_name: str,
    org_name: str,
    email: str,
    invited_by: str,
) -> None:
    """Add the external client's data-owner representative as a free `observer`
    and email them that they're the data owner of this workspace (ISSUE-026).

    Observers are free and valid only on external-client workspaces (which this
    always is when called). Creates a pending workspace_invite + sends the mail
    via the same path as the invite endpoint.
    """
    from datetime import timedelta

    from dembrane.api.v2.invites import compute_invite_hash, _enqueue_invite_email
    from dembrane.api.v2._invite_helpers import build_invite_accept_url

    expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    invite_id = generate_uuid()
    await async_directus.create_item(
        "workspace_invite",
        {
            "id": invite_id,
            "workspace_id": workspace_id,
            "email": email,
            "role": "observer",
            "invited_by": invited_by,
            "expires_at": expires_at,
        },
    )
    invite_url = build_invite_accept_url(
        invite_type="workspace",
        admin_base_url=settings.urls.admin_base_url,
        hash_value=compute_invite_hash(invite_id),
        inviter_name=org_name or "dembrane",
        subject_name=workspace_name,
        role="observer",
        email=email,
    )
    _enqueue_invite_email(
        to=email,
        subject=f"You're the data owner for {workspace_name} on dembrane",
        template="workspace_invite",
        template_data={
            "inviter_name": org_name or "dembrane",
            "workspace_name": workspace_name,
            "invite_url": invite_url,
        },
        failure_context=f"data_owner_observer / workspace {workspace_id}",
    )


@router.post("", response_model=CreateWorkspaceResponse)
async def create_workspace(
    body: CreateWorkspaceRequest,
    auth: DependencyDirectusSession,
) -> CreateWorkspaceResponse:
    """Create a new workspace (self-serve).

    Any org admin/owner can create a workspace in their org; staff can create
    in any org. Billing is provisioned at create time: the workspace joins the
    org's pooled billing account, or gets its own (workspace-scoped) account when
    a data owner is named (the external "for another client" case — see below).
    Payment is the gate, not staff approval — so the workspace_request flow is no
    longer needed for new workspaces.
    """
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
    elif not auth.is_admin:
        # Caller named an org: they must be an admin/owner of it.
        mem = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "user_id": {"_eq": app_user_id},
                        "org_id": {"_eq": org_id},
                        "role": {"_in": ["owner", "admin"]},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )
        if not isinstance(mem, list) or len(mem) == 0:
            raise HTTPException(
                status_code=403,
                detail="You must be an organisation admin or owner to create a workspace here.",
            )

    # Visibility is stored on workspace.visibility (sole source of truth on new
    # rows). Non-open visibility is gated at Innovator+ below, once the billing
    # account (which carries the tier) is resolved.
    visibility = body.visibility
    ws_id = generate_uuid()

    # A workspace is external (separate billing + compliance context) when the
    # creator names a data owner — an owning organisation + representative email
    # distinct from this org (ISSUE-026, generalized 2026-06-21). There is no
    # `bill_separately` flag: the presence of a data owner IS the signal, and the
    # billing context is then carried by the workspace-scoped billing account
    # (read off billing_account_id), not a boolean. Absent a data owner the
    # workspace is internal and joins the org's pooled account.
    data_owner_email = (body.data_owner_email or "").strip().lower() or None
    data_owner_org_name = (getattr(body, "data_owner_org_name", None) or "").strip() or None
    separate = bool(data_owner_email)
    if separate:
        if not data_owner_org_name:
            raise HTTPException(
                status_code=400,
                detail="The owning organisation's name is required when you name a data owner.",
            )
        if not body.partner_agreement_accepted:
            raise HTTPException(
                status_code=400,
                detail="You must accept the partner agreement to create an external-client workspace.",
            )
        # The data owner must be EXTERNAL to this org (ISSUE-026): an external
        # workspace exists for a separate compliance/billing context, so naming
        # an existing org member as its data owner is contradictory. Block it;
        # for internal collaborators, create an internal workspace instead.
        if data_owner_email and await _is_org_member_by_email(org_id, data_owner_email):
            raise HTTPException(
                status_code=400,
                detail=(
                    "That data owner is already a member of your organisation. "
                    "External-client workspaces need a data owner outside your "
                    "organisation; for internal collaborators, create an "
                    "internal workspace instead."
                ),
            )

    # Org manages billing by default: the workspace joins the org's account.
    # A named data owner (external client) mints a workspace-scoped account
    # instead, billed on its own and handoff-ready.
    from dembrane.billing_account import (
        link_account_to_workspace,
        org_account_for_new_workspace,
        create_workspace_scoped_account,
        billing_account_blocks_new_workspace,
    )

    if separate:
        account_id = await create_workspace_scoped_account(
            tier="free", created_by=app_user_id, label=f"{body.name.strip()} billing"
        )
    else:
        account_id = await org_account_for_new_workspace(org_id=org_id, created_by=app_user_id)
        # Validate the org's billing account can take a new workspace.
        account = await async_directus.get_item("billing_account", account_id)
        blocked = billing_account_blocks_new_workspace(account)
        if blocked:
            raise HTTPException(status_code=402, detail=blocked)
        # Free tier: one workspace per org (org-pooled accounts only; separate
        # client-billed workspaces are unrestricted). Staff bypass.
        from dembrane.free_tier import (
            FREE_TIER_MAX_WORKSPACES,
            is_free_tier,
            count_org_workspaces,
            free_tier_limit_error,
        )

        if (
            not auth.is_admin
            and is_free_tier((account or {}).get("tier"))
            and await count_org_workspaces(org_id, billing_account_id=account_id)
            >= FREE_TIER_MAX_WORKSPACES
        ):
            raise free_tier_limit_error("workspaces")
    # Paywall: non-open visibility at creation requires Innovator+ on the account
    # the workspace will bill to. The account may already be a paid org-pooled
    # account, so resolve the real tier rather than assuming free. Staff bypass.
    if visibility != "open_to_organisation" and not auth.is_admin:
        from dembrane.policies import has_policy

        acct = await async_directus.get_item("billing_account", account_id)
        acct_tier = (acct or {}).get("tier") or "free"
        if not has_policy("owner", [], "workspace:set_private", workspace_tier=acct_tier):
            raise HTTPException(
                status_code=402,
                detail=(
                    "Invite-only and private workspaces require the Innovator plan "
                    "or above. Create the workspace as open, then change its "
                    "visibility after upgrading."
                ),
            )

    # Record internal-vs-external use, derived purely from whether a data owner
    # was named (`separate`). This is the canonical marker the free-observer role
    # keys on (observers exist only in external-client workspaces); the billing
    # context itself is carried by the workspace-scoped account.
    usage_context = "external" if separate else "internal"
    ws_row: dict = {
        "id": ws_id,
        "org_id": org_id,
        "name": body.name.strip(),
        "visibility": visibility,
        "is_default": False,
        "created_by": app_user_id,
        "billing_account_id": account_id,
        "usage_context": usage_context,
    }
    if separate:
        # Owning org + data owner + agreement acceptance for the external workspace.
        ws_row["data_owner_org_name"] = data_owner_org_name
        ws_row["data_owner_email"] = data_owner_email
        ws_row["partner_agreement_accepted_at"] = datetime.now(timezone.utc).isoformat()
    await async_directus.create_item("workspace", ws_row)
    if separate:
        await link_account_to_workspace(account_id, ws_id)

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

    # Pool seats across the account's workspaces. Adding the creator as owner of
    # a new workspace is a net-new seat only if they weren't already a seat-holder
    # anywhere on the account; count_account_seats dedupes distinct users, so an
    # existing member creating a workspace reconciles to €0 net-new (no-op).
    # Best-effort: a billing hiccup must never fail workspace creation (reconcile
    # flags the account on its own).
    from dembrane.billing_service import reconcile_account_seats

    try:
        await reconcile_account_seats(account_id)
    except Exception:
        logger.exception("Seat reconcile failed after creating workspace %s", ws_id)

    # External-client workspace: add the data owner's representative as a free
    # observer and email them that they're the data owner (ISSUE-026). Best-effort
    # — a mail/invite hiccup must never fail workspace creation.
    if separate and data_owner_email:
        try:
            await _invite_data_owner_observer(
                workspace_id=ws_id,
                workspace_name=body.name.strip(),
                org_name=data_owner_org_name or "",
                email=data_owner_email,
                invited_by=app_user_id,
            )
        except Exception:
            logger.exception("Failed to add data-owner observer for workspace %s", ws_id)

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
            else "The new workspace is restricted — organisation admins can join it; members can't see it."
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

    # Resolve the billing account before the soft-delete (the workspace row still
    # carries billing_account_id afterwards, but resolve up front to be explicit).
    from dembrane.billing_service import get_account_for_workspace

    billing_account = await get_account_for_workspace(ctx.workspace_id)

    now_iso = datetime.now(timezone.utc).isoformat()
    await async_directus.update_item("workspace", ctx.workspace_id, {"deleted_at": now_iso})
    logger.info(f"Deleted workspace {ctx.workspace_id} by {ctx.app_user_id} (role={ctx.role})")

    # Deletion frees this workspace's seats (count_account_seats ignores deleted
    # workspaces), so re-price immediately rather than waiting for the cron
    # (ISSUE-010). Min-1-seat is preserved inside reconcile; deleting the last
    # workspace does not auto-cancel -- cancellation stays an explicit action.
    # Best-effort: a billing hiccup must never fail the delete (reconcile flags
    # the account on its own).
    if billing_account:
        from dembrane.billing_service import reconcile_account_seats

        try:
            await reconcile_account_seats(billing_account["id"])
        except Exception:
            logger.exception("Seat reconcile failed after deleting workspace %s", ctx.workspace_id)

    return {"status": "deleted"}


# ── Tier management (staff-only per D1 / Ask 2s) ────────────────────────


class SetTierRequest(BaseModel):
    # "free" must be accepted: staff downgrade an account to free from the
    # dashboard. Omitting it made the /tier PATCH 422 on a free selection.
    tier: Literal["free", "pilot", "pioneer", "innovator", "changemaker", "guardian"]
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

    from dembrane.billing_account import resolve_workspace_tier, update_workspace_billing

    from_tier = (await resolve_workspace_tier(workspace_id)) or "pioneer"
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
    account_update: dict = {"tier": to_tier}
    if direction == "downgrade":
        account_update["downgraded_at"] = now_iso
        account_update["downgraded_from_tier"] = from_tier
    elif direction == "upgrade":
        account_update["downgraded_at"] = None
        account_update["downgraded_from_tier"] = None
    await update_workspace_billing(workspace_id, account_update)

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


class AnnualPricing(BaseModel):
    per_month_eur: int
    total_per_year_eur: int


class MonthlyPricing(BaseModel):
    per_month_eur: int


class TierPricing(BaseModel):
    """Per-tier nested pricing payload (per seat / month).

    - Free: pricing is None at the parent level (never instantiated).
    - Paid tiers: `annual_billing` + `monthly_billing` populated.
    """

    annual_billing: Optional[AnnualPricing] = None
    monthly_billing: Optional[MonthlyPricing] = None


class NextTierRecommendation(BaseModel):
    tier: str
    tagline: str
    pricing: Optional[TierPricing] = None
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
    # Unified seat total (members + externals) — matches what
    # assert_can_add_seat counts. This is the bar numerator.
    seat_count: int
    seat_count_included: Optional[int]
    # Breakdown for the host-facing card. Sum of member_count +
    # external_count == seat_count. observer_count is the free, read-only
    # bucket and is NOT part of seat_count (free-vs-paid distribution).
    member_count: int
    external_count: int
    observer_count: int = 0
    # Pending workspace_invite rows (not yet accepted, not expired). Counted
    # in the bar via seat_invite_blocked; surfaced separately for the
    # "Pending invites" sub-row.
    pending_count: int
    project_count: int
    projects: list[ProjectUsageItem]
    pilot_hard_block_active: bool = False  # deprecated: always False, use usage_gates
    # Unified seat cap gate for invite UI. True when (members + externals +
    # pending) meets or exceeds included_seats on a hard-blocking tier.
    seat_invite_blocked: bool = False
    usage_gates: UsageGatesResponse = UsageGatesResponse()

    # Admin + billing only — None for members.
    next_tier: Optional[NextTierRecommendation] = None

    # Free-tier gating block. None on paid tiers and on pre-deploy cached
    # payloads. See dembrane.free_tier.build_free_tier_usage_block.
    free_tier: Optional[dict] = None


class TierCapacityItem(BaseModel):
    tier: str
    tagline: str
    pricing: Optional[TierPricing] = None
    billing_period_applicable: bool
    duration: str
    included_seats: Optional[int]
    included_hours: Optional[int]
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
    from dembrane.tier_capacity import TIER_CAPACITIES, build_tier_pricing

    items: list[TierCapacityItem] = []
    for cap in TIER_CAPACITIES.values():
        raw_pricing = build_tier_pricing(cap.tier)
        pricing = TierPricing(**raw_pricing) if raw_pricing else None
        items.append(
            TierCapacityItem(
                tier=cap.tier,
                tagline=cap.tagline,
                pricing=pricing,
                billing_period_applicable=cap.billing_period_applicable,
                duration=cap.duration,
                included_seats=cap.included_seats,
                included_hours=cap.included_hours,
                hard_block_on_hours=cap.hard_block_on_hours,
                training_included=cap.training_included,
            )
        )
    return items


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

    Members see raw numbers. Admin + billing additionally see the next-tier
    recommendation (matrix §8).

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
    )

    ctx.require_policy("workspace:view_usage")

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
                cached = {**cached, "next_tier": None}
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

    # Seat breakdown via the shared counter so this matches /v2/orgs/:id/usage.
    from dembrane.seat_capacity import compute_effective_seat_state

    seat_count, member_count, external_count, observer_count = await compute_effective_seat_state(
        ctx.workspace_id
    )

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
    # The next-tier recommendation describes the current cycle's end state; it's
    # null for historical months (where the cycle already closed).
    recommended = tier_next(tier) if is_current_month else None
    next_rec: Optional[NextTierRecommendation] = None
    if recommended:
        rcap = get_capacity(recommended)
        if rcap:
            from dembrane.tier_capacity import build_tier_pricing

            raw_pricing = build_tier_pricing(recommended)
            next_rec = NextTierRecommendation(
                tier=recommended,
                tagline=rcap.tagline,
                pricing=TierPricing(**raw_pricing) if raw_pricing else None,
                included_hours=rcap.included_hours,
                included_seats=rcap.included_seats,
            )

    # Unified seat cap gate for invite UI. Members + externals share the pool.
    # Mirrors seat_capacity.assert_can_add_seat with include_pending=True
    # so the UI disables the invite button as soon as the cap is taken.
    from dembrane.seat_capacity import count_pending_invites

    member_pending, external_pending, _observer_pending = await count_pending_invites(
        ctx.workspace_id
    )
    pending_count = member_pending + external_pending
    seat_invite_blocked = (
        included_seats is not None
        and tier_hard_blocks_seats(tier)
        and (seat_count + pending_count) >= included_seats
    )

    gates_raw = compute_usage_gates(tier, hours_lifetime, audio_hours)
    gates = UsageGatesResponse(
        over_cap_active=gates_raw.over_cap_active,
        uploads_locked=gates_raw.uploads_locked,
        upgrade_cta_tier=tier_next(tier),
    )

    # Free-tier gating block (single source the frontend reads for blur /
    # locked-composer / disabled-create states). Computed on the fresh path
    # only; the cached branch carries whatever it stored (None pre-deploy).
    # The extra Directus fan-out runs for free tier only; paid and legacy
    # (None) tiers get an inactive block with no queries. project_ids is
    # reused from above so the helpers don't refetch it five times.
    from dembrane.free_tier import is_free_tier, build_free_tier_usage_block

    if is_free_tier(tier):
        from dembrane.free_tier import (
            count_workspace_chats,
            count_workspace_reports,
            resolve_workspace_primary_chat_id,
            resolve_workspace_primary_report_id,
        )

        (
            free_chats_used,
            free_primary_chat_id,
            free_reports_used,
            free_primary_report_id,
        ) = await asyncio.gather(
            count_workspace_chats(ctx.workspace_id, project_ids),
            resolve_workspace_primary_chat_id(ctx.workspace_id, project_ids),
            count_workspace_reports(ctx.workspace_id, project_ids),
            resolve_workspace_primary_report_id(ctx.workspace_id, project_ids),
        )
        free_tier_block = build_free_tier_usage_block(
            tier=tier,
            chats_used=free_chats_used,
            primary_chat_id=free_primary_chat_id,
            reports_used=free_reports_used,
            primary_report_id=free_primary_report_id,
        )
    else:
        free_tier_block = build_free_tier_usage_block(
            tier=tier,
            chats_used=0,
            primary_chat_id=None,
            reports_used=0,
            primary_report_id=None,
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
        member_count=member_count,
        external_count=external_count,
        observer_count=observer_count,
        pending_count=pending_count,
        project_count=live_project_count,
        projects=per_project_items,
        pilot_hard_block_active=hard_block,
        seat_invite_blocked=seat_invite_blocked,
        usage_gates=gates,
        next_tier=next_rec,
        free_tier=free_tier_block,
    )

    # Cache the full payload (admin view). Best-effort — failure to cache
    # never breaks the read.
    await cache_set_json(cache_key, full.model_dump(), USAGE_TTL_SECONDS)

    if not sees_financials:
        return WorkspaceUsageResponse(**{**full.model_dump(), "next_tier": None})

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


async def _assert_workspace_scoped_billing(ws: dict) -> dict:
    """Raise 409 unless the workspace bills on its own (workspace-scoped) account.

    Returns the billing-account row so callers can reuse it. The authoritative
    test for "external collaboration" in a billing context is account scope: an
    org-scoped account pools many workspaces (internal); a workspace-scoped one
    funds exactly this workspace (the partner / external-client case). ISSUE-027.
    """
    account_id = ws.get("billing_account_id")
    account = await async_directus.get_item("billing_account", account_id) if account_id else None
    if not account or account.get("org_id"):
        raise HTTPException(
            status_code=409,
            detail=(
                "This workspace is billed under its organisation's shared plan, so "
                "it can't be handed off. Only workspaces billed on their own "
                "(for an external client) can be transferred."
            ),
        )
    return account


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

    # ISSUE-027: handoff only applies to external-client workspaces, which bill on
    # their OWN (workspace-scoped) account. An org-pooled (internal) workspace was
    # never an external collaboration — refuse, otherwise the re-parent would
    # detach a workspace from a shared org plan.
    await _assert_workspace_scoped_billing(ws)

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

    # Defensive: must still be a workspace-scoped account (ISSUE-027). The
    # account is NOT re-scoped to the client org — it stays workspace-scoped so
    # the prepaid term/seats stay isolated to this one workspace and notification
    # routing keeps resolving through the workspace's admins (which now include
    # the client org via inheritance). Billing follows the workspace because
    # billed_to_team_id flips below; tier/seats/paid-through carry over for free
    # since it is the same account row — no credit math.
    account = await _assert_workspace_scoped_billing(ws)

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

    # The workspace's resolved org changed: refresh usage caches for both orgs +
    # the workspace + the account so the client org's usage box shows it at once.
    from dembrane.cache_utils import invalidate_org_usage, invalidate_workspace_usage
    from dembrane.billing_service import invalidate_account_usage_caches

    await invalidate_workspace_usage(ctx.workspace_id)
    await invalidate_org_usage(target_organisation_id)
    if prior_billing_organisation:
        await invalidate_org_usage(prior_billing_organisation)
    if account.get("id"):
        await invalidate_account_usage_caches(account["id"])

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
        message=(
            "Your organisation now owns this workspace. Our team will coordinate "
            "the billing transfer with you. Nothing changes until then."
        ),
        action="NAVIGATE_WS",
        ref_workspace_id=ctx.workspace_id,
        ref_org_id=target_organisation_id,
    )

    # org/user IDs redacted (CodeQL flags them as sensitive); billing facts of the
    # transfer are non-PII and logged for the account manager (ISSUE-027 AC).
    logger.info(
        "handoff_accepted workspace=%s account=%s tier=%s provisioned_seats=%s "
        "paid_through=%s from=[redacted] to=[redacted] by=[redacted]",
        ctx.workspace_id,
        account.get("id"),
        account.get("tier"),
        account.get("provisioned_seats"),
        account.get("tier_expires_at"),
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
