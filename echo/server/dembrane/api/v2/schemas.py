"""Typed response models for v2 API endpoints."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, EmailStr, Field


# ── /v2/me ──


class OrgSummary(BaseModel):
    """Org membership info for the current user."""

    id: str
    name: str
    role: str  # owner / admin / member


class MeResponse(BaseModel):
    """Lightweight user profile. Called on every page load — must be fast."""

    id: Optional[str] = None  # app_user.id (null if not onboarded)
    directus_user_id: str
    email: str
    display_name: str
    avatar: Optional[str] = None
    onboarding_completed: bool
    orgs: list[OrgSummary] = []
    has_pending_invites: bool = False
    # Derived from Directus JWT `admin_access` claim (i.e. Administrator role
    # in Directus). Gates internal-only UI like workspace tier-set + audit.
    is_staff: bool = False


# ── /v2/onboarding ──


class OnboardingCompleteRequest(BaseModel):
    org_name: str = Field(min_length=1, max_length=100)


class OnboardingCompleteResponse(BaseModel):
    app_user_id: str
    org_id: str
    workspace_id: str


# ── /v2/workspaces ──


class MemberPreview(BaseModel):
    """Minimal member info for avatar bubbles."""

    display_name: str
    avatar: Optional[str] = None


class WorkspaceUsage(BaseModel):
    """Usage stats for a workspace (all-time + current month)."""

    audio_hours: float = 0.0
    conversation_count: int = 0
    # Current calendar month
    audio_hours_this_month: float = 0.0
    conversations_this_month: int = 0


class WorkspaceSummary(BaseModel):
    id: str
    name: str
    org_id: str
    org_name: str
    role: str
    is_default: bool
    tier: str
    project_count: int
    member_count: int
    is_external: bool
    members_preview: list[MemberPreview] = []
    usage: WorkspaceUsage = WorkspaceUsage()


class TeamRollup(BaseModel):
    """Aggregated stats across all workspaces in a team."""

    id: str
    name: str
    role: str
    total_projects: int = 0
    total_members: int = 0  # unique across workspaces
    total_audio_hours: float = 0.0
    total_conversations: int = 0
    workspace_count: int = 0
    # Current calendar month
    total_audio_hours_this_month: float = 0.0
    total_conversations_this_month: int = 0


class WorkspaceListResponse(BaseModel):
    workspaces: list[WorkspaceSummary]
    teams: list[TeamRollup] = []


# ── /v2/workspaces CRUD ──


class CreateWorkspaceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    org_id: Optional[str] = None  # defaults to user's primary org
    # Wizard step 2 access choice: which org roles derive access to this
    # workspace. Admins always follow team access (default true). Members
    # are opt-in (default false). Both false = private workspace.
    inherit_team_admins: bool = True
    inherit_team_members: bool = False
    # tier is always "pioneer" on creation — upgrades happen via billing/admin


class CreateWorkspaceResponse(BaseModel):
    id: str
    name: str
    org_id: str
    tier: str


# ── /v2/workspaces/:id/invite ──


class WorkspaceInviteRequest(BaseModel):
    email: EmailStr
    role: str = "member"
    is_org_member: bool = False  # True = add to org, False = external


class WorkspaceInviteResponse(BaseModel):
    status: str  # "invited" | "added" (existing user → immediate membership)
    email: str
    user_existed: bool
    email_sent: bool = True  # False if SendGrid failed or was not configured


# ── /v2/projects/:id/move ──


class MoveProjectRequest(BaseModel):
    target_workspace_id: str


class MoveProjectResponse(BaseModel):
    project_id: str
    workspace_id: str
