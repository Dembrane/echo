"""Typed response models for v2 API endpoints."""

from __future__ import annotations

from typing import Optional

from pydantic import AliasChoices, BaseModel, EmailStr, Field


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
    # True if the user has projects that predate workspaces (no workspace_id).
    # Drives the onboarding split: new users (false) get a signup-time
    # team-name field; existing users (true) get the "Welcome back, we've
    # added teams" migration screen. Independent of onboarding_completed.
    has_legacy_projects: bool = False


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
    # Matrix §8 cap signals for card-level rendering. Populated from
    # tier_capacity at serialisation time so clients don't need to join
    # tier → cap themselves.
    hours_included: Optional[int] = None    # None = unlimited tier
    hours_pct: Optional[float] = None       # 0..1; null when unlimited
    at_cap: bool = False
    approaching_cap: bool = False


class WorkspaceSummary(BaseModel):
    id: str
    name: str
    org_id: str
    org_name: str
    role: str
    is_default: bool
    tier: str
    logo_url: Optional[str] = None
    project_count: int
    member_count: int
    is_external: bool
    members_preview: list[MemberPreview] = []
    usage: WorkspaceUsage = WorkspaceUsage()
    # Post-downgrade banner state (matrix v1.1 §3). Set on downgrade,
    # cleared on next upgrade. Frontend renders the banner for 7 days
    # past downgraded_at; auto-returns on dismiss if the admin attempts
    # a frozen feature.
    downgraded_at: Optional[str] = None
    downgraded_from_tier: Optional[str] = None


class TeamRollup(BaseModel):
    """Aggregated stats across all workspaces in a team."""

    id: str
    name: str
    role: str
    logo_url: Optional[str] = None
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
    # Visibility choice on the create form. Maps to workspace.visibility
    # (matrix v1.1 §6). True → 'open_to_team', False → 'private'.
    # Private requires innovator+ tier — solo users can still pick it but
    # the set_private policy enforces at mutation time.
    inherit_team_admins: bool = True
    # Accepted for backward compatibility; ignored on write. Team members
    # no longer auto-inherit access (matrix §6 retires derivation). They
    # use Request access.
    inherit_team_members: bool = False
    # tier is always "pioneer" on creation — upgrades happen via billing/admin


class CreateWorkspaceResponse(BaseModel):
    id: str
    name: str
    org_id: str
    tier: str


# ── /v2/workspaces/:id/invite ──


class WorkspaceInviteRequest(BaseModel):
    """Invite payload.

    is_org_member accepts two aliases because the value lives under two
    names across the codebase: the API/UI uses is_org_member, while the
    Directus workspace_invite column is include_org_membership. Rather
    than force one convention (and silently accept the other as a
    no-op, which was the root cause of the "Guests can't be …" error
    when testing the billing role), we take either.
    """

    model_config = {"populate_by_name": True}

    email: EmailStr
    role: str = "member"
    is_org_member: bool = Field(
        default=False,
        validation_alias=AliasChoices("is_org_member", "include_org_membership"),
    )


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
