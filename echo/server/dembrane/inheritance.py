"""Workspace inheritance resolvers — derived model.

Single source of truth for "does user U have access to workspace W?" and
"who is on workspace W?". Inherited access is computed at query time from
org_membership + workspace.settings, never materialised as
workspace_membership rows with source='inherited'.

See docs/workspaces/inheritance-rules.md for the full spec.

Settings shape on workspace.settings (JSON):
    {
        # inherit_organisation_admins: RETIRED. Admin inheritance is now driven
        # solely by the workspace.visibility enum (see
        # workspace_follows_organisation_admins). Stale values may linger in old
        # rows' JSON but are never read.
        "inherit_organisation_members": bool (default False) # organisation members follow organisation access
        "sticky_removed": [                          # tombstones: no re-grant
            {"user_id": str, "removed_at": ISO8601, "removed_by": str}, ...
        ]
    }
"""

from __future__ import annotations

from typing import Optional
from logging import getLogger
from datetime import datetime, timezone

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


def workspace_follows_organisation_admins(workspace: dict) -> bool:
    """True if organisation admins follow this workspace's access (inherit admin role).

    Driven solely by the workspace.visibility enum: 'private' → False, everything
    else (the 'open_to_organisation' default, or an absent value) → True, matching
    the matrix v1.1 §9 default-open rule.

    The legacy settings.inherit_organisation_admins fallback was removed once
    directus/migrations/backfill_workspace_visibility.py had run in every
    environment, so no row reaches here with a NULL visibility.
    """
    return workspace.get("visibility") != "private"


def workspace_follows_organisation_members(workspace: dict) -> bool:
    """True if organisation members (org role 'member') also follow organisation access.

    Matrix v1.1 §6 retires organisation-member derivation — new workspaces DO NOT
    fan members into derived access. They go through "Request access"
    (access_request flow) and get a direct Member row on approval.

    This helper keeps the legacy read so the resolver remains correct for
    workspaces created before the matrix-§6 model landed (the flag persists
    in their settings JSON until the walkback purge). After prod backfill
    + settings purge, this helper always returns False.
    """
    return _settings(workspace).get("inherit_organisation_members", False)


def is_sticky_removed(workspace: dict, user_id: str) -> bool:
    """True if this user has a sticky-remove tombstone on this workspace.

    A tombstone means a workspace admin explicitly removed the user from an
    inherited/derived slot — we do not re-grant them access via derivation.
    """
    tombstones = _settings(workspace).get("sticky_removed") or []
    return any(t.get("user_id") == user_id for t in tombstones)


def derive_workspace_role(
    workspace: dict, org_role: Optional[str], user_id: str
) -> Optional[str]:
    """Derived (non-direct) workspace role for this user, or None. Pure, no I/O.

    This is the single source of truth for the derived-access ladder. Direct
    workspace_membership is checked by the caller and takes precedence — it is
    NOT considered here. Callers pass the workspace row (needs visibility +
    settings) and the user's org_membership.role for this workspace's org.

    Resolution order (must stay in sync with user_can_access's documented order):
        1. Sticky-removed → None (an explicit tombstone is never re-granted,
           even for org owners).
        2. Organisation owner → 'admin', regardless of workspace privacy
           (owner carve-out: an owner can't be locked out of their own org).
        3. Private workspace → None (blocks all remaining derivation).
        4. Organisation admin → 'admin'.
        5. Organisation member → 'member', iff the workspace opts in via
           settings.inherit_organisation_members.

    Returns the derived role string ('admin' / 'member'); the caller wraps it
    with source='inherited'.
    """
    if is_sticky_removed(workspace, user_id):
        return None
    if org_role == "owner":
        return "admin"
    if not workspace_follows_organisation_admins(workspace):
        return None
    if org_role == "admin":
        return "admin"
    if org_role == "member" and workspace_follows_organisation_members(workspace):
        return "member"
    return None


# ── Read-side resolvers ─────────────────────────────────────────────────


async def _get_direct_membership(workspace_id: str, user_id: str) -> Optional[dict]:
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


async def org_workspace_membership_roles(org_id: str, user_id: str) -> list[str]:
    """Roles on the user's active workspace memberships across this org.

    One workspace-id lookup for the org, then one membership lookup. Used to
    decide insider (any member/billing/admin/owner row) vs outsider (only
    external rows).
    """
    workspaces = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {"org_id": {"_eq": org_id}, "deleted_at": {"_null": True}},
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    ws_ids = (
        [w["id"] for w in workspaces if w.get("id")]
        if isinstance(workspaces, list)
        else []
    )
    if not ws_ids:
        return []
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_in": ws_ids},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []
    return [r.get("role") for r in rows if r.get("role")]


async def is_org_external_only(org_id: str, user_id: str) -> bool:
    """True when the user is an outsider (external or observer) in this org
    regardless of any org_membership row.

    Per the confirmed invariant (insider XOR outsider per org), this holds
    when the org role is not admin/owner/billing, the user has at least one
    outsider workspace membership in the org (external or the free read-only
    observer), and zero internal workspace memberships in the org. Robust to a
    stale org_membership left behind when someone was converted to an outsider.
    """
    role = await _get_org_role(org_id, user_id)
    if role in ("admin", "owner", "billing"):
        return False
    roles = await org_workspace_membership_roles(org_id, user_id)
    has_external = any(r in ("external", "observer") for r in roles)
    has_internal = any(r in ("member", "billing", "admin", "owner") for r in roles)
    return has_external and not has_internal


async def is_org_billing_only(org_id: str, user_id: str) -> bool:
    """True when the user is a biller in this org (finance visibility only,
    matrix v1.1 §4/§5) — they must never be granted operational access.

    Two ways to be a biller:
      - org_membership.role = 'billing' (org-level biller), regardless of
        workspace rows, or
      - workspace-scoped biller: org role is not admin/owner, and the user's
        workspace roles in this org include 'billing' with no operational
        role (member/admin/owner) anywhere in the org.
    """
    role = await _get_org_role(org_id, user_id)
    if role == "billing":
        return True
    if role in ("admin", "owner"):
        return False
    roles = await org_workspace_membership_roles(org_id, user_id)
    has_billing = any(r == "billing" for r in roles)
    has_operational = any(r in ("member", "admin", "owner") for r in roles)
    return has_billing and not has_operational


async def user_can_access(workspace_id: str, user_id: str) -> Optional[tuple[str, str]]:
    """Return (role, source) for this user on this workspace, or None.

    `source` is 'direct' (from a stored workspace_membership row) or
    'inherited' (derived from org_membership + workspace settings).

    Resolution order (priority):
        1. Direct workspace membership wins outright.
        2. Organisation owner always derives 'admin' access, even on private
           workspaces — prevents a rogue admin from locking the organisation
           owner out of their own org's workspaces. Sticky-removal still
           respected (an owner who was explicitly tombstoned stays out).
        3. Organisation admin → derived 'admin' role, unless private or sticky.
        4. Organisation member → derived 'member' role, iff workspace opts in via
           settings.inherit_organisation_members AND not sticky.

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

    org_id = workspace.get("org_id")
    if not org_id:
        return None

    org_role = await _get_org_role(org_id, user_id)

    # Derived ladder (sticky → owner carve-out → privacy → admin → member-opt-in)
    # lives in derive_workspace_role so the batched org-members rollup
    # (_rollup_workspace_access) shares one copy of the rules.
    derived = derive_workspace_role(workspace, org_role, user_id)
    if derived:
        return derived, "inherited"
    return None


async def get_effective_members(workspace_id: str) -> list[dict]:
    """Return every user with access to this workspace — direct + derived.

    Output shape (one row per user):
        {
            "user_id": str,
            "role": str,
            "source": "direct" | "inherited",
            "custom_policies": list, # only stored for direct rows
            "created_at": str | None,
        }

    Direct rows take precedence; a user with both a direct row and a derived
    path appears once with their direct role. External collaborators
    surface as role='external' (see ADR-0003) — no separate flag.
    """
    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace or workspace.get("deleted_at"):
        return []

    direct_rows = (
        await async_directus.get_items(
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
                        "custom_policies",
                        "created_at",
                    ],
                    "limit": -1,
                }
            },
        )
        or []
    )
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
                "custom_policies": row.get("custom_policies") or [],
                "created_at": row.get("created_at"),
            }
        )

    org_id = workspace.get("org_id")
    if not org_id:
        return out

    # Organisation owners always derive access (organisation-owner carve-out in
    # user_can_access). Everyone else only derives on open workspaces.
    follows_admins = workspace_follows_organisation_admins(workspace)
    if not follows_admins:
        roles_in_scope = ["owner"]
    else:
        roles_in_scope = ["owner", "admin"]
        if workspace_follows_organisation_members(workspace):
            roles_in_scope.append("member")

    org_rows = (
        await async_directus.get_items(
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
        )
        or []
    )
    if not isinstance(org_rows, list):
        org_rows = []

    for row in org_rows:
        uid = row.get("user_id")
        if not uid or uid in direct_user_ids:
            continue
        if is_sticky_removed(workspace, uid):
            continue
        derived_role = "admin" if row.get("role") in ("owner", "admin") else "member"
        out.append(
            {
                "user_id": uid,
                "role": derived_role,
                "source": "inherited",
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
    workspace.visibility (enum). The inherit_organisation_members concept retired
    — organisation members request access explicitly via the access_request flow.
    """
    await async_directus.create_item(
        "workspace_membership",
        {
            "id": generate_uuid(),
            "workspace_id": workspace_id,
            "user_id": creator_app_user_id,
            "role": "owner",
            "source": "direct",
        },
    )


async def on_organisation_member_removed(org_id: str, user_id: str) -> list[str]:
    """User left or was removed from the organisation.

    Soft-delete every source='direct' workspace_membership this user has in
    the organisation's workspaces. Derived access stops automatically because
    org_membership is gone.

    Returns list of workspace_ids affected.
    """
    workspaces = (
        await async_directus.get_items(
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
        )
        or []
    )
    if not isinstance(workspaces, list) or not workspaces:
        return []

    ws_ids = [w["id"] for w in workspaces if w.get("id")]
    if not ws_ids:
        return []

    memberships = (
        await async_directus.get_items(
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
        )
        or []
    )
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
    await async_directus.update_item("workspace", workspace_id, {"settings": settings})


async def sticky_unremove(workspace_id: str, user_id: str) -> None:
    """Remove a tombstone so derivation can re-grant access. Not exposed in
    this release — reserved for a future "restore inherited access" admin
    action. Kept here so the inverse is co-located with sticky_remove.
    """
    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace:
        return

    settings = _settings(workspace)
    tombstones = [t for t in (settings.get("sticky_removed") or []) if t.get("user_id") != user_id]
    settings = {**settings, "sticky_removed": tombstones}
    await async_directus.update_item("workspace", workspace_id, {"settings": settings})
