"""Typed response models for v2 API endpoints."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import Field, EmailStr, BaseModel

# ── /v2/me ──


class OrgSummary(BaseModel):
    """Org membership info for the current user."""

    id: str
    name: str
    role: str  # owner / admin / member
    is_partner: bool = False  # staff-set; gates the partner create-workspace branch


class TrainingStatus(BaseModel):
    """Per-user training (high-risk license) status. The training_license row
    is the verification record; `trained_until` is its expiry."""

    trained: bool = False
    trained_until: Optional[str] = None  # ISO expiry of the active license
    expiring_soon: bool = False  # within 30 days of expiry


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
    # organisation-name field; existing users (true) get the "Welcome back, we've
    # added organisations" migration screen. Independent of onboarding_completed.
    has_legacy_projects: bool = False
    # Post-register questionnaire answers (ISSUE-012). Null until the user
    # submits the questions step. Shape:
    # {"version": "17-jun-26", "data": [{"q1": "..."}, ...]}. The frontend
    # reads this to decide whether to nudge the (required but non-blocking)
    # questions step.
    onboarding_answer_json: Optional[dict[str, Any]] = None
    # Training (ISSUE-020): per-user license status + the high-risk flag that
    # (with no active license) drives the non-blocking Inbox nudge (ISSUE-014).
    training_status: TrainingStatus = TrainingStatus()
    high_risk_context: bool = False


# ── /v2/onboarding ──


class OnboardingCompleteRequest(BaseModel):
    org_name: str = Field(min_length=1, max_length=100)


class OnboardingCompleteResponse(BaseModel):
    app_user_id: str
    org_id: str
    workspace_id: str


class OnboardingAnswersRequest(BaseModel):
    """Post-register questionnaire answers (ISSUE-012). Required but
    non-blocking — a skip still routes the user on. `version` tags the
    question set so answers stay interpretable as questions evolve."""

    version: str = Field(default="17-jun-26", max_length=40)
    # Free-form per-question answers. Stored verbatim under the `data` key.
    # Known keys today: q1 (use context), q2 (high-risk yes/no), q3 (training).
    data: list[dict[str, Any]] = Field(default_factory=list)
    # User dismissed the questionnaire. Still persisted (with no answers) so the
    # login gate stops re-nudging them; never triggers staff follow-up.
    skipped: bool = False


class OnboardingAnswersResponse(BaseModel):
    status: str
    # Echoes back what got persisted so the client can update its cache
    # without a refetch.
    onboarding_answer_json: dict[str, Any]


# ── /v2/workspaces ──


class MemberPreview(BaseModel):
    """Minimal member info for avatar bubbles."""

    display_name: str
    avatar: Optional[str] = None


class UsageGatesSummary(BaseModel):
    """Workspace-level gate flags for over-cap UI gating (list view)."""

    over_cap_active: bool = False
    uploads_locked: bool = False
    upgrade_cta_tier: Optional[str] = None


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
    hours_included: Optional[int] = None  # None = unlimited tier
    hours_pct: Optional[float] = None  # 0..1; null when unlimited
    at_cap: bool = False
    approaching_cap: bool = False
    usage_gates: UsageGatesSummary = UsageGatesSummary()


class WorkspaceSummary(BaseModel):
    id: str
    name: str
    org_id: str
    org_name: str
    role: str
    is_default: bool
    tier: str
    # Bills on its own (workspace-scoped) account rather than the org's pooled
    # plan — surfaced so tier displays can mark it "(Partner)".
    bills_separately: bool = False
    logo_url: Optional[str] = None
    # Parent organisation's logo — handy for card rendering so the client doesn't
    # need a second lookup. Nullable because organisations without a logo exist.
    org_logo_url: Optional[str] = None
    project_count: int
    member_count: int
    members_preview: list[MemberPreview] = []
    usage: WorkspaceUsage = WorkspaceUsage()
    # Post-downgrade banner state (matrix v1.1 §3). Set on downgrade,
    # cleared on next upgrade. Frontend renders the banner for 7 days
    # past downgraded_at; auto-returns on dismiss if the admin attempts
    # a frozen feature.
    downgraded_at: Optional[str] = None
    downgraded_from_tier: Optional[str] = None
    created_at: Optional[str] = None


class OrganisationRollup(BaseModel):
    """Aggregated stats across all workspaces in a organisation."""

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


class RecentRemoval(BaseModel):
    workspace_id: str
    workspace_name: str
    org_name: str
    ended_at: str  # ISO timestamp from workspace_membership.deleted_at


class WorkspaceListResponse(BaseModel):
    workspaces: list[WorkspaceSummary]
    organisations: list[OrganisationRollup] = []
    # Memberships soft-deleted in the last 30 days. Powers the empty-state
    # message on /w so a removed guest sees "your access ended" instead of
    # "create your first workspace".
    recent_removals: list[RecentRemoval] = []


# ── /v2/workspaces CRUD ──


class CreateWorkspaceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    org_id: Optional[str] = None  # defaults to user's primary org
    # Visibility choice on the create form. Maps to workspace.visibility
    # (matrix v1.1 §6). True → 'open_to_organisation', False → 'private'.
    # Private requires innovator+ tier — solo users can still pick it but
    # the set_private policy enforces at mutation time.
    inherit_organisation_admins: bool = True
    # Accepted for backward compatibility; ignored on write. Organisation members
    # no longer auto-inherit access (matrix §6 retires derivation). They
    # use Request access.
    inherit_organisation_members: bool = False
    # Billing: default false → the workspace joins the org's billing account
    # (org manages billing). True → mint a workspace-scoped account billed
    # separately (the partner "for another client" path; handoff-ready).
    bill_separately: bool = False


class CreateWorkspaceResponse(BaseModel):
    id: str
    name: str
    org_id: str
    tier: str


# ── /v2/workspaces/:id/invite ──


class WorkspaceInviteRequest(BaseModel):
    """Invite payload.

    `role` is the single axis for the invite — external collaborators are
    invited as role='external' (ADR-0003); the free read-only collaborator is
    role='observer' (Wave G). Both are outsiders (no org_membership). Out-of-enum
    values fail at Pydantic validation (422); the endpoint enforces role-hierarchy
    escalation rules separately.
    """

    email: EmailStr
    role: Literal["admin", "member", "billing", "external", "observer"] = "member"


class WorkspaceInviteResponse(BaseModel):
    # invited | added | reactivated | already_member | already_invited
    status: str
    email: str
    user_existed: bool
    email_sent: bool = True  # False if SendGrid failed or was not configured
    invite_url: Optional[str] = None  # present only for invited / already_invited


# ── /v2/projects/:id/move ──


class MoveProjectRequest(BaseModel):
    target_workspace_id: str


class MoveProjectResponse(BaseModel):
    project_id: str
    workspace_id: str
