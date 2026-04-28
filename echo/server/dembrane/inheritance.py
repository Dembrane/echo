"""Workspace inheritance resolvers — derived model.

Single source of truth for "does user U have access to workspace W?" and
"who is on workspace W?". Inherited access is computed at query time from
org_membership + workspace.settings, never materialised as
workspace_membership rows with source='inherited'.

See docs/workspaces/inheritance-rules.md for the full spec.

Settings shape on workspace.settings (JSON):
    {
        "inherit_team_admins": bool  (default True)  # team admins follow team access
        "inherit_team_members": bool (default False) # team members follow team access
        "sticky_removed": [                          # tombstones: no re-grant
            {"user_id": str, "removed_at": ISO8601, "removed_by": str}, ...
        ]
    }
"""

from __future__ import annotations

from logging import getLogger
from datetime import datetime, timezone
from typing import Optional

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus

logger = getLogger("dembrane.inheritance")


# ── Settings helpers (pure) ─────────────────────────────────────────────


def _settings(workspace: dict) -> dict:
    """Return workspace.settings as a dict, handling None + legacy shapes."""
    raw = workspace.get("settings")
    if isinstance(raw, dict):
        return raw
    return {}


def workspace_follows_team_admins(workspace: dict) -> bool:
    """True if team admins follow this workspace's access (inherit admin role).

    Resolution order (matrix v1.1 §6 transition):
      1. workspace.visibility column, when present: 'open_to_team' → True,
         'private' → False.
      2. Legacy settings.inherit_team_admins flag on pre-enum rows.
      3. Default True (open) — matches matrix §9 default.
    """
    visibility = workspace.get("visibility")
    if visibility == "open_to_team":
        return True
    if visibility == "private":
        return False
    # Legacy fallback until the walkback purges settings flags.
    return _settings(workspace).get("inherit_team_admins", True)


def workspace_follows_team_members(workspace: dict) -> bool:
    """True if team members (org role 'member') also follow team access.

    Matrix v1.1 §6 retires team-member derivation — new workspaces DO NOT
    fan members into derived access. They go through "Request access"
    (access_request flow) and get a direct Member row on approval.

    This helper keeps the legacy read so the resolver remains correct for
    workspaces created before the matrix-§6 model landed (the flag persists
    in their settings JSON until the walkback purge). After prod backfill
    + settings purge, this helper always returns False.
    """
    return _settings(workspace).get("inherit_team_members", False)


def is_sticky_removed(workspace: dict, user_id: str) -> bool:
    """True if this user has a sticky-remove tombstone on this workspace.

    A tombstone means a workspace admin explicitly removed the user from an
    inherited/derived slot — we do not re-grant them access via derivation.
    """
    tombstones = _settings(workspace).get("sticky_removed") or []
    return any(t.get("user_id") == user_id for t in tombstones)


# ── Read-side resolvers ─────────────────────────────────────────────────


async def _get_direct_membership(
    workspace_id: str, user_id: str
) -> Optional[dict]:
    """Active (non-deleted) workspace_membership row for (ws, user), or None.

    Direct is the stored state. Its presence short-circuits derivation.
    """
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "limit": 1,
            }
        },
    )
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


async def _get_org_role(org_id: str, user_id: str) -> Optional[str]:
    """Return the user's org_membership.role in this org, or None.

    Only active (non-deleted) rows count.
    """
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role"],
                "limit": 1,
            }
        },
    )
    if isinstance(rows, list) and rows:
        return rows[0].get("role")
    return None


async def user_can_access(
    workspace_id: str, user_id: str
) -> Optional[tuple[str, str]]:
    """Return (role, source) for this user on this workspace, or None.

    `source` is 'direct' (from a stored workspace_membership row) or
    'inherited' (derived from org_membership + workspace settings).

    Resolution order (priority):
        1. Direct workspace membership wins outright.
        2. Team owner always derives 'admin' access, even on private
           workspaces — prevents a rogue admin from locking the team
           owner out of their own org's workspaces. Sticky-removal still
           respected (an owner who was explicitly tombstoned stays out).
        3. Team admin → derived 'admin' role, unless private or sticky.
        4. Team member → derived 'member' role, iff workspace opts in via
           settings.inherit_team_members AND not sticky.

    Note: project-level shares for private projects are handled separately
    in get_user_project_access (PRD §"Permission Resolution"); this function
    answers workspace-level access only.
    """
    direct = await _get_direct_membership(workspace_id, user_id)
    if direct:
        return direct["role"], "direct"

    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace or workspace.get("deleted_at"):
        return None

    if is_sticky_removed(workspace, user_id):
        return None

    org_id = workspace.get("org_id")
    if not org_id:
        return None

    org_role = await _get_org_role(org_id, user_id)

    # Team-owner carve-out: owners always derive admin access, regardless
    # of workspace privacy. Otherwise, any workspace admin could set
    # inherit_team_admins=false and lock the owner out of their own
    # workspace — which breaks the "workspace lives in a team" contract.
    if org_role == "owner":
        return "admin", "inherited"

    # Private workspace short-circuits team-admin and team-member
    # derivation below.
    if not workspace_follows_team_admins(workspace):
        return None

    if org_role == "admin":
        return "admin", "inherited"

    if org_role == "member" and workspace_follows_team_members(workspace):
        return "member", "inherited"

    return None


async def get_effective_members(workspace_id: str) -> list[dict]:
    """Return every user with access to this workspace — direct + derived.

    Output shape (one row per user):
        {
            "user_id": str,
            "role": str,
            "source": "direct" | "inherited",
            "is_external": bool,     # only meaningful for direct rows
            "custom_policies": list, # only stored for direct rows
            "created_at": str | None,
        }

    Direct rows take precedence; a user with both a direct row and a derived
    path appears once with their direct role.
    """
    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace or workspace.get("deleted_at"):
        return []

    direct_rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "deleted_at": {"_null": True},
                },
                "fields": [
                    "user_id",
                    "role",
                    "is_external",
                    "custom_policies",
                    "created_at",
                ],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(direct_rows, list):
        direct_rows = []

    out: list[dict] = []
    direct_user_ids: set[str] = set()
    for row in direct_rows:
        uid = row.get("user_id")
        if not uid:
            continue
        direct_user_ids.add(uid)
        out.append(
            {
                "user_id": uid,
                "role": row.get("role", ""),
                "source": "direct",
                "is_external": bool(row.get("is_external", False)),
                "custom_policies": row.get("custom_policies") or [],
                "created_at": row.get("created_at"),
            }
        )

    org_id = workspace.get("org_id")
    if not org_id:
        return out

    # Team owners always derive access (team-owner carve-out in
    # user_can_access). Everyone else only derives on open workspaces.
    follows_admins = workspace_follows_team_admins(workspace)
    if not follows_admins:
        roles_in_scope = ["owner"]
    else:
        roles_in_scope = ["owner", "admin"]
        if workspace_follows_team_members(workspace):
            roles_in_scope.append("member")

    org_rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "role": {"_in": roles_in_scope},
                    "deleted_at": {"_null": True},
                },
                "fields": ["user_id", "role"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(org_rows, list):
        org_rows = []

    for row in org_rows:
        uid = row.get("user_id")
        if not uid or uid in direct_user_ids:
            continue
        if is_sticky_removed(workspace, uid):
            continue
        derived_role = (
            "admin" if row.get("role") in ("owner", "admin") else "member"
        )
        out.append(
            {
                "user_id": uid,
                "role": derived_role,
                "source": "inherited",
                "is_external": False,  # derived cannot be external
                "custom_policies": [],  # no custom policies on derived slots
                "created_at": None,
            }
        )

    return out


# ── Write-side transitions ──────────────────────────────────────────────


async def on_workspace_created(
    workspace_id: str,
    creator_app_user_id: str,
) -> None:
    """After POST /v2/workspaces creates the workspace row, insert the
    creator as source='direct', role='owner'.

    No settings-flag writes anymore (matrix v1.1 §6). Visibility lives on
    workspace.visibility (enum). The inherit_team_members concept retired
    — team members request access explicitly via the access_request flow.
    """
    await async_directus.create_item(
        "workspace_membership",
        {
            "id": generate_uuid(),
            "workspace_id": workspace_id,
            "user_id": creator_app_user_id,
            "role": "owner",
            "source": "direct",
            "is_external": False,
        },
    )


async def on_team_member_removed(org_id: str, user_id: str) -> list[str]:
    """User left or was removed from the team.

    Soft-delete every source='direct' workspace_membership this user has in
    the team's workspaces. Derived access stops automatically because
    org_membership is gone.

    Returns list of workspace_ids affected.
    """
    workspaces = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(workspaces, list) or not workspaces:
        return []

    ws_ids = [w["id"] for w in workspaces if w.get("id")]
    if not ws_ids:
        return []

    memberships = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_in": ws_ids},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "workspace_id"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(memberships, list):
        return []

    now_iso = datetime.now(timezone.utc).isoformat()
    affected: list[str] = []
    for m in memberships:
        await async_directus.update_item(
            "workspace_membership",
            m["id"],
            {"deleted_at": now_iso},
        )
        affected.append(m["workspace_id"])
    return affected


async def get_user_project_access(
    project_id: str,
    user_id: str,
    *,
    directus_user_id: Optional[str] = None,
    project: Optional[dict] = None,
) -> Optional[tuple[str, str]]:
    """Return (role, source) for this user on this project, or None.

    Implements the PRD §"Permission Resolution" access ladder, extended
    for the derived-inheritance model:

      1. Legacy creator fallback — `project.directus_user_id` equals the
         caller's Directus id. Treat as ('owner', 'legacy'). Only used for
         projects created before workspaces existed. Requires the caller
         to pass their directus_user_id (we don't resolve it here to
         avoid circular imports).

      2. Workspace access — if the project is visible to the whole
         workspace (visibility='workspace'), inherit the caller's
         workspace role (direct or derived via user_can_access).

      3. Private projects — workspace admin/owner retain access; everyone
         else requires a project_membership row. Source = 'workspace'
         for admins/owners, 'project_share' for direct shares.

    Returns None when the project is private and the caller has no
    admin/owner role on the workspace and no project_membership row.

    `project` may be passed in by callers who already fetched the row
    (e.g. bff/_access.resolve_project_access) to avoid a second read.
    Passing `None` means we fetch it here.
    """
    if project is None:
        project = await async_directus.get_item("project", project_id)
    if not project or project.get("deleted_at"):
        return None

    workspace_id = project.get("workspace_id")

    # Legacy creator — kept for backward compat only, ONLY for projects
    # that never landed in a workspace (pre-workspaces data that onboarding
    # hasn't moved yet). If a project is attached to a workspace, access
    # must flow through the workspace regardless of who originally created
    # it — otherwise a workspace-removed user could still read a project
    # they once created.
    if (
        not workspace_id
        and directus_user_id
        and project.get("directus_user_id")
        and project["directus_user_id"] == directus_user_id
    ):
        return "owner", "legacy"

    if not workspace_id:
        return None

    visibility = project.get("visibility") or "workspace"

    resolved_ws = await user_can_access(workspace_id, user_id)
    if resolved_ws is None:
        # No workspace access at all — project is unreachable regardless
        # of visibility or any project_membership (we don't allow
        # cross-workspace sharing).
        if visibility == "private":
            # Check project_membership anyway for the rare case where a
            # workspace member lost direct access but still has a share
            # row — policy: shares require workspace access, so this
            # case is inaccessible. Return None.
            return None
        return None

    ws_role, ws_source = resolved_ws

    if visibility == "workspace":
        # Inherit the workspace role verbatim. Source reflects where
        # workspace access came from (direct vs inherited).
        return ws_role, ws_source

    # visibility == "private"
    if ws_role in ("admin", "owner"):
        return ws_role, "workspace"

    # Not an admin — needs an explicit share row.
    share_rows = await async_directus.get_items(
        "project_membership",
        {
            "query": {
                "filter": {
                    "project_id": {"_eq": project_id},
                    "user_id": {"_eq": user_id},
                },
                "fields": ["role"],
                "limit": 1,
            }
        },
    )
    if isinstance(share_rows, list) and share_rows:
        share_role = share_rows[0].get("role", "viewer")
        return share_role, "project_share"

    return None


async def sticky_remove(
    workspace_id: str,
    user_id: str,
    by_user_id: str,
) -> None:
    """Append a sticky-remove tombstone so the user is not re-granted
    inherited/derived access on this workspace. Idempotent — skip if already
    present.
    """
    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace:
        return

    settings = _settings(workspace)
    tombstones = list(settings.get("sticky_removed") or [])
    if any(t.get("user_id") == user_id for t in tombstones):
        return  # already tombstoned

    tombstones.append(
        {
            "user_id": user_id,
            "removed_at": datetime.now(timezone.utc).isoformat(),
            "removed_by": by_user_id,
        }
    )
    settings = {**settings, "sticky_removed": tombstones}
    await async_directus.update_item(
        "workspace", workspace_id, {"settings": settings}
    )


async def sticky_unremove(workspace_id: str, user_id: str) -> None:
    """Remove a tombstone so derivation can re-grant access. Not exposed in
    this release — reserved for a future "restore inherited access" admin
    action. Kept here so the inverse is co-located with sticky_remove.
    """
    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace:
        return

    settings = _settings(workspace)
    tombstones = [
        t for t in (settings.get("sticky_removed") or [])
        if t.get("user_id") != user_id
    ]
    settings = {**settings, "sticky_removed": tombstones}
    await async_directus.update_item(
        "workspace", workspace_id, {"settings": settings}
    )
