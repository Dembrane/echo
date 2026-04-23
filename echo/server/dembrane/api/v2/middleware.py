"""V2 API middleware: workspace context and permission enforcement."""

from __future__ import annotations

from logging import getLogger

from fastapi import HTTPException

from dembrane.policies import has_policy, meets_tier
from dembrane.app_user import resolve_app_user
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.directus_async import async_directus
from dembrane.inheritance import user_can_access

logger = getLogger("api.v2.middleware")


class WorkspaceContext:
    """Resolved workspace context for a request.

    Injected via FastAPI Depends. Validates that the authenticated user
    has access to the workspace and provides their role/policies.
    """

    def __init__(
        self,
        workspace_id: str,
        workspace: dict,
        app_user_id: str,
        role: str,
        custom_policies: list[str],
        source: str,
        is_external: bool,
    ):
        self.workspace_id = workspace_id
        self.workspace = workspace
        self.app_user_id = app_user_id
        self.role = role
        self.custom_policies = custom_policies
        self.source = source
        self.is_external = is_external

    def has_policy(self, required: str) -> bool:
        # Tier auto-wiring is in policies.has_policy — workspace_tier is
        # forwarded so tier gates fire without per-endpoint require_tier
        # calls.
        return has_policy(
            self.role,
            self.custom_policies,
            required,
            workspace_tier=self.workspace.get("tier"),
        )

    def require_policy(self, required: str) -> None:
        if not self.has_policy(required):
            raise HTTPException(status_code=403, detail="Access denied")

    def require_tier(self, minimum_tier: str) -> None:
        current = self.workspace.get("tier", "pioneer")
        if not meets_tier(current, minimum_tier):
            raise HTTPException(
                status_code=403,
                detail=f"This feature requires the {minimum_tier} plan or above",
            )


async def get_workspace_context(
    workspace_id: str,
    auth: DependencyDirectusSession,
) -> WorkspaceContext:
    """FastAPI dependency that validates workspace access.

    Access resolution runs through dembrane.inheritance.user_can_access, which
    is the single source of truth — a user may have access via a stored
    direct membership OR via derivation from their org role + workspace
    settings. See docs/workspaces/inheritance-rules.md.

    Usage:
        @router.get("/workspaces/{workspace_id}/projects")
        async def list_projects(ctx: WorkspaceContext = Depends(get_workspace_context)):
            ctx.require_policy("project:read")
            ...
    """
    app_user = await resolve_app_user(auth.user_id)
    if not app_user:
        raise HTTPException(status_code=403, detail="User not onboarded")

    app_user_id = app_user["id"]

    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace or workspace.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    resolved = await user_can_access(workspace_id, app_user_id)
    if resolved is None:
        raise HTTPException(status_code=403, detail="No access to this workspace")

    role, source = resolved

    # Direct rows can carry custom_policies + is_external. Inherited rows
    # derive from org role — they get the plain role preset, never external.
    custom_policies: list[str] = []
    is_external = False
    if source == "direct":
        rows = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": workspace_id},
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["custom_policies", "is_external"],
                    "limit": 1,
                }
            },
        )
        if isinstance(rows, list) and rows:
            custom_policies = rows[0].get("custom_policies") or []
            is_external = bool(rows[0].get("is_external", False))

    # Normalize legacy role names at context build so every downstream
    # check — has_policy, role-hierarchy compares, UI serialisation — sees
    # the current role set. D11: viewer → member.
    from dembrane.policies import _normalize_legacy_role
    normalized_role = _normalize_legacy_role(role) or role

    return WorkspaceContext(
        workspace_id=workspace_id,
        workspace=workspace,
        app_user_id=app_user_id,
        role=normalized_role,
        custom_policies=custom_policies,
        source=source,
        is_external=is_external,
    )


# ────────────────────────────────────────────────────────────────────
# Pilot hard-block — host-side operations only (matrix §8)
# ────────────────────────────────────────────────────────────────────


async def _current_cycle_hours(workspace_id: str) -> float:
    """Sum of conversation.duration across this workspace's projects for
    the current calendar month (UTC). Respects soft-delete on both
    project and conversation."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    month_start = now.replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    if now.month == 12:
        next_start = month_start.replace(year=now.year + 1, month=1)
    else:
        next_start = month_start.replace(month=now.month + 1)

    projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(projects, list) or not projects:
        return 0.0

    ids = [p["id"] for p in projects if p.get("id")]
    if not ids:
        return 0.0

    conversations = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "project_id": {"_in": ids},
                    "deleted_at": {"_null": True},
                    "created_at": {
                        "_gte": month_start.isoformat(),
                        "_lt": next_start.isoformat(),
                    },
                },
                "fields": ["duration"],
                "limit": -1,
            }
        },
    )
    if not isinstance(conversations, list):
        return 0.0

    total = sum(int(c.get("duration") or 0) for c in conversations)
    return total / 3600.0


async def require_no_pilot_block(
    ctx: WorkspaceContext,
) -> None:
    """Raise 402 if this workspace is a Pilot workspace at or past its
    10-hour cap. Matrix §8: **host-side** operations are blocked; the
    participant portal (recording, upload, transcription) is never gated
    on this.

    Use this dep in addition to `get_workspace_context` on host-side
    endpoints: project creation, chat / agentic analysis, transcript
    view, report generate/update, data export.

    Copy choice (response body) includes the participant-reassurance line
    verbatim per matrix — the UI's level-3 modal (screens/status-banner)
    lifts this text for the hard-block screen.
    """
    from dembrane.tier_capacity import is_hard_blocked

    tier = ctx.workspace.get("tier")
    if not tier:
        return  # legacy NULL tier — treat as unlimited (not Pilot)

    # Only Pilot hard-blocks. Short-circuit before reaching the DB.
    if tier != "pilot":
        return

    hours = await _current_cycle_hours(ctx.workspace_id)
    if is_hard_blocked(tier, hours):
        raise HTTPException(
            status_code=402,
            detail=(
                "Pilot limit reached. Host-side tools are paused. "
                "Recording keeps working — your participants are unaffected. "
                "Upgrade to continue."
            ),
        )
