"""Typed response models for v2 API endpoints."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, EmailStr


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


# ── /v2/onboarding ──


class OnboardingCompleteRequest(BaseModel):
    org_name: str


class OnboardingCompleteResponse(BaseModel):
    app_user_id: str
    org_id: str
    workspace_id: str


# ── /v2/workspaces ──


class MemberPreview(BaseModel):
    """Minimal member info for avatar bubbles."""

    display_name: str
    avatar: Optional[str] = None


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


class WorkspaceListResponse(BaseModel):
    workspaces: list[WorkspaceSummary]


# ── /v2/workspaces/:id/invite ──


class WorkspaceInviteRequest(BaseModel):
    email: EmailStr
    role: str = "member"
    is_org_member: bool = False  # True = add to org, False = external


class WorkspaceInviteResponse(BaseModel):
    status: str  # "invited" | "added" (existing user → immediate membership)
    email: str
    user_existed: bool


# ── /v2/projects/:id/move ──


class MoveProjectRequest(BaseModel):
    target_workspace_id: str


class MoveProjectResponse(BaseModel):
    project_id: str
    workspace_id: str
