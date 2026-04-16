"""Typed response models for v2 API endpoints."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


# ── /v2/me ──


class MeResponse(BaseModel):
    """Lightweight user profile. Called on every page load — must be fast."""

    id: Optional[str] = None  # app_user.id (null if not onboarded)
    directus_user_id: str
    email: str
    display_name: str
    avatar: Optional[str] = None
    onboarding_completed: bool


# ── /v2/onboarding ──


class OnboardingCompleteRequest(BaseModel):
    org_name: str


class OnboardingCompleteResponse(BaseModel):
    app_user_id: str
    org_id: str
    workspace_id: str


# ── /v2/workspaces ──


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


class WorkspaceListResponse(BaseModel):
    workspaces: list[WorkspaceSummary]


# ── /v2/workspaces/:id/invite ──


class WorkspaceInviteRequest(BaseModel):
    email: str
    role: str = "member"


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
