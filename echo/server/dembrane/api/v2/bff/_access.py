"""Shared access layer for /v2/bff/* endpoints.

The frontend used to read project-scoped data directly via Directus SDK.
Directus row-level ACL doesn't know about our v2 inheritance/sharing
model — a workspace member reaching a workspace through a derived organisation
admin row was 403'ing on item reads. These helpers centralize the
access check so every BFF route funnels through the same logic:

    resolve_project_access(project_id, auth)           → project + access
    resolve_conversation_access(conv_id, auth)         → conv + access
    resolve_conversation_chunk_access(chunk_id, auth)  → chunk + conv + access
    resolve_chat_access(chat_id, auth)                 → chat + access
    resolve_chat_message_access(msg_id, auth)          → msg + chat + access
    resolve_report_access(report_id, auth)             → report + access
    resolve_report_metric_access(metric_id, auth)      → metric + report + access
    resolve_tag_access(tag_id, auth)                   → tag + access
    resolve_analysis_run_access(run_id, auth)          → run + access

Every function returns a `ResourceAccess` object carrying role, source,
tier, custom_policies, and a `require()` method that enforces the
matrix policies/tier gates in one call.

Design choices worth knowing about:

- **Soft-delete respect.** deleted_at != null ⇒ 404. Applies at every
  level. Some child collections (conversation_chunk, project_tag,
  project_chat_message, project_analysis_run) don't have deleted_at,
  but their parent does; the parent is always rechecked here so a
  "deleted project" can't leak through a child row.

- **404, not 403.** When the caller can't access, we return 404 rather
  than 403 — consistent with project_sharing's model of not confirming
  a private project's existence to outsiders. The one exception is
  policy-level denials (`require(policy)` raises 403) because at that
  point we've already admitted the resource exists; we're saying "you
  see it, you just can't do THAT to it."

- **External role.** Externals (role='external') get the strictly
  scoped external preset per matrix §4 — ADR-0003. No flag-swap needed
  anymore: the role field itself is the source of truth.

- **Tier gate reuse.** has_policy() already handles tier gates when
  workspace_tier is passed. We always pass it so any endpoint that
  require()s project:share / workspace:export / etc. gets the tier
  check for free.

- **Private-project shares use PROJECT_ROLE_PRESETS.** When access came
  in via source='project_share', require() evaluates against the
  viewer/editor preset, not the workspace preset.
"""

from __future__ import annotations

from typing import Optional
from logging import getLogger
from dataclasses import field, dataclass

from fastapi import HTTPException

from dembrane.app_user import get_app_user_or_raise
from dembrane.policies import (
    PROJECT_ROLE_PRESETS,
    WORKSPACE_ROLE_PRESETS,
    TIER_REQUIRED_FOR_POLICY,
    has_policy,
    meets_tier,
)
from dembrane.inheritance import get_user_project_access
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = getLogger("api.v2.bff.access")


@dataclass
class ResourceAccess:
    """Result of an access assertion.

    Carries everything an endpoint needs to decide if the current call
    is allowed. Handlers should only talk to this object via
    `allows(policy)` or `require(policy)`; never poke at role/tier
    strings directly.
    """

    app_user_id: str
    directus_user_id: str
    project_id: str
    workspace_id: Optional[str]
    tier: Optional[str]
    role: str
    source: str
    custom_policies: list[str] = field(default_factory=list)
    # Cached so cache-invalidation paths skip a second workspace fetch.
    org_id: Optional[str] = None
    # project dict cached from the initial fetch; sub-resource resolvers
    # reuse it instead of re-fetching.
    project: dict = field(default_factory=dict)

    @property
    def _presets(self) -> dict[str, list[str]]:
        # Private-project shares (viewer/editor) have their own preset
        # table. Everything else evaluates against the workspace preset.
        return PROJECT_ROLE_PRESETS if self.source == "project_share" else WORKSPACE_ROLE_PRESETS

    def allows(self, policy: str) -> bool:
        """Does this role (+tier) grant `policy`? Silent — returns bool.

        role='external' uses the strictly scoped external preset directly
        (ADR-0003) — no flag-swap. Project-share access (source='project_share')
        evaluates against the viewer/editor preset table instead.
        """
        return has_policy(
            role=self.role,
            custom_policies=self.custom_policies,
            required=policy,
            presets=self._presets,
            workspace_tier=self.tier,
        )

    def require(self, policy: str) -> None:
        """Raise 403 if `policy` isn't granted.

        Error message surfaces the tier gate when that's the reason,
        so the UI can render an "upgrade required" hint instead of a
        generic forbidden.
        """
        if self.allows(policy):
            return
        required_tier = TIER_REQUIRED_FOR_POLICY.get(policy)
        if required_tier and self.tier is not None and not meets_tier(self.tier, required_tier):
            raise HTTPException(
                status_code=403,
                detail=(f"This action requires the {required_tier} tier (currently {self.tier})."),
            )
        raise HTTPException(status_code=403, detail="Not allowed")


# ── Helpers ────────────────────────────────────────────────────────────


async def _get_workspace_bits(
    workspace_id: Optional[str],
    app_user_id: str,
) -> tuple[Optional[str], list[str], Optional[str]]:
    """Fetch (tier, custom_policies, org_id) for this workspace.

    Legacy projects (workspace_id=None) return (None, [], None) — no
    tier gates apply to those; they're pre-workspaces data.
    """
    if not workspace_id:
        return None, [], None

    workspace = await async_directus.get_item("workspace", workspace_id)
    org_id: Optional[str] = (workspace or {}).get("org_id")
    # Tier lives on the billing account, not the workspace.
    from dembrane.billing_account import resolve_workspace_tier

    tier: Optional[str] = await resolve_workspace_tier(workspace_id) if workspace else None

    # Caller's direct row, if any. This is where custom_policies live;
    # derived rows (organisation admin inheritance) don't carry them.
    mem = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["custom_policies"],
                "limit": 1,
            }
        },
    )
    custom: list[str] = []
    if isinstance(mem, list) and mem:
        raw = mem[0].get("custom_policies")
        if isinstance(raw, list):
            custom = [p for p in raw if isinstance(p, str)]

    return tier, custom, org_id


async def resolve_project_access(
    project_id: str,
    auth: DependencyDirectusSession,
) -> ResourceAccess:
    """Assert access to a project. Returns a ResourceAccess bundle."""
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    # Single project fetch — pass it into get_user_project_access so
    # the access check doesn't re-read the same row. That helper
    # previously did its own get_item, which doubled the project fetch
    # on every BFF request.
    project = await async_directus.get_item("project", project_id)
    if not project or project.get("deleted_at"):
        # 404 even for callers who could hypothetically access — don't
        # confirm existence of soft-deleted rows to anyone but staff.
        raise HTTPException(status_code=404, detail="Project not found")

    access = await get_user_project_access(
        project_id=project_id,
        user_id=app_user_id,
        directus_user_id=auth.user_id,
        project=project,
    )
    if access is None:
        raise HTTPException(status_code=404, detail="Project not found")
    role, source = access

    workspace_id = project.get("workspace_id")
    tier, custom, org_id = await _get_workspace_bits(workspace_id, app_user_id)

    return ResourceAccess(
        app_user_id=app_user_id,
        directus_user_id=auth.user_id,
        project_id=project_id,
        workspace_id=workspace_id,
        tier=tier,
        role=role,
        source=source,
        custom_policies=custom,
        org_id=org_id,
        project=project,
    )


async def resolve_conversation_access(
    conversation_id: str,
    auth: DependencyDirectusSession,
) -> tuple[ResourceAccess, dict]:
    """Assert access to a conversation via its parent project.

    Returns (access, conversation_dict). 404 when the conversation is
    missing, soft-deleted, or the caller can't access the parent.
    """
    conv = await async_directus.get_item("conversation", conversation_id)
    if not conv or conv.get("deleted_at") or not conv.get("project_id"):
        raise HTTPException(status_code=404, detail="Conversation not found")
    access = await resolve_project_access(conv["project_id"], auth)
    access.require("conversation:read")
    return access, conv


async def resolve_conversation_chunk_access(
    chunk_id: str,
    auth: DependencyDirectusSession,
) -> tuple[ResourceAccess, dict, dict]:
    """Assert access to a conversation_chunk via its parent conversation.

    Returns (access, chunk_dict, conversation_dict). Chunks don't carry
    deleted_at themselves, but the parent conversation does and is
    rechecked.
    """
    chunk = await async_directus.get_item("conversation_chunk", chunk_id)
    if not chunk or not chunk.get("conversation_id"):
        raise HTTPException(status_code=404, detail="Chunk not found")
    access, conv = await resolve_conversation_access(chunk["conversation_id"], auth)
    return access, chunk, conv


async def resolve_chat_access(
    chat_id: str,
    auth: DependencyDirectusSession,
) -> tuple[ResourceAccess, dict]:
    """Assert access to a project_chat via its parent project."""
    chat = await async_directus.get_item("project_chat", chat_id)
    if not chat or chat.get("deleted_at") or not chat.get("project_id"):
        raise HTTPException(status_code=404, detail="Chat not found")
    access = await resolve_project_access(chat["project_id"], auth)
    access.require("chat:use")
    return access, chat


async def resolve_chat_message_access(
    message_id: str,
    auth: DependencyDirectusSession,
) -> tuple[ResourceAccess, dict, dict]:
    """Assert access to a chat message via its parent chat."""
    msg = await async_directus.get_item("project_chat_message", message_id)
    if not msg or not msg.get("project_chat_id"):
        raise HTTPException(status_code=404, detail="Message not found")
    # project_chat_id may come back as either an id string or a
    # relation dict depending on how it was queried. Normalize.
    chat_id = (
        msg["project_chat_id"]
        if isinstance(msg["project_chat_id"], str)
        else msg["project_chat_id"].get("id")
    )
    access, chat = await resolve_chat_access(chat_id, auth)
    return access, msg, chat


async def resolve_report_access(
    report_id: str,
    auth: DependencyDirectusSession,
) -> tuple[ResourceAccess, dict]:
    """Assert access to a project_report via its parent project."""
    report = await async_directus.get_item("project_report", report_id)
    if not report or report.get("deleted_at") or not report.get("project_id"):
        raise HTTPException(status_code=404, detail="Report not found")
    access = await resolve_project_access(report["project_id"], auth)
    access.require("report:view")
    return access, report


async def resolve_report_metric_access(
    metric_id: str,
    auth: DependencyDirectusSession,
) -> tuple[ResourceAccess, dict, dict]:
    """Assert access to a report metric via its parent report."""
    metric = await async_directus.get_item("project_report_metric", metric_id)
    if not metric or not metric.get("project_report_id"):
        raise HTTPException(status_code=404, detail="Metric not found")
    rid = (
        metric["project_report_id"]
        if isinstance(metric["project_report_id"], str)
        else metric["project_report_id"].get("id")
    )
    access, report = await resolve_report_access(rid, auth)
    return access, metric, report


async def resolve_tag_access(
    tag_id: str,
    auth: DependencyDirectusSession,
) -> tuple[ResourceAccess, dict]:
    """Assert access to a project_tag via its parent project."""
    tag = await async_directus.get_item("project_tag", tag_id)
    if not tag or not tag.get("project_id"):
        raise HTTPException(status_code=404, detail="Tag not found")
    access = await resolve_project_access(tag["project_id"], auth)
    return access, tag


async def resolve_analysis_run_access(
    run_id: str,
    auth: DependencyDirectusSession,
) -> tuple[ResourceAccess, dict]:
    """Assert access to a project_analysis_run via its parent project."""
    run = await async_directus.get_item("project_analysis_run", run_id)
    if not run or not run.get("project_id"):
        raise HTTPException(status_code=404, detail="Analysis run not found")
    access = await resolve_project_access(run["project_id"], auth)
    return access, run


# Convenience for list endpoints: resolve by project_id, then the caller
# iterates children under async_directus with admin privileges.
async def resolve_project_access_by_param(
    project_id: str,
    auth: DependencyDirectusSession,
) -> ResourceAccess:
    return await resolve_project_access(project_id, auth)


# ── Fetch helpers that always respect deleted_at ──────────────────────


def filter_exclude_deleted(filter_: Optional[dict]) -> dict:
    """Return a filter dict that excludes soft-deleted rows.

    Use for collections that carry `deleted_at` (project, conversation,
    project_chat, project_report). If a deleted_at clause already
    exists in `filter_`, we respect it; otherwise we add
    `deleted_at IS NULL`.
    """
    base = dict(filter_ or {})
    if "deleted_at" not in base:
        base["deleted_at"] = {"_null": True}
    return base


__all__ = [
    "ResourceAccess",
    "filter_exclude_deleted",
    "resolve_analysis_run_access",
    "resolve_chat_access",
    "resolve_chat_message_access",
    "resolve_conversation_access",
    "resolve_conversation_chunk_access",
    "resolve_project_access",
    "resolve_project_access_by_param",
    "resolve_report_access",
    "resolve_report_metric_access",
    "resolve_tag_access",
]
