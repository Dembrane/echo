"""
V2 API — workspace-aware endpoints.

All v2 endpoints use app_user.id (not directus_users.id), check workspace
permissions via policies, and return typed Pydantic response models.

Mounted at /api/v2/ in main.py.
"""

from fastapi import APIRouter

from dembrane.api.v2.me import router as me_router
from dembrane.api.v2.orgs import router as orgs_router
from dembrane.api.v2.onboarding import router as onboarding_router
from dembrane.api.v2.invites import router as invites_router
from dembrane.api.v2.projects import router as projects_router
from dembrane.api.v2.workspaces import router as workspaces_router
from dembrane.api.v2.workspace_projects import router as workspace_projects_router
from dembrane.api.v2.workspace_settings import router as workspace_settings_router

v2_router = APIRouter()

v2_router.include_router(me_router, prefix="/me", tags=["v2:me"])
v2_router.include_router(onboarding_router, prefix="/onboarding", tags=["v2:onboarding"])

# Team (org) management — user-facing word is "team", internal is "org" (see D1).
v2_router.include_router(orgs_router, prefix="/orgs", tags=["v2:orgs"])

# Workspace-scoped: /workspaces, /workspaces/{id}/invite, /workspaces/{id}/projects
v2_router.include_router(workspaces_router, prefix="/workspaces", tags=["v2:workspaces"])
v2_router.include_router(invites_router, prefix="/workspaces", tags=["v2:invites"])
v2_router.include_router(workspace_projects_router, prefix="/workspaces", tags=["v2:workspace-projects"])
v2_router.include_router(workspace_settings_router, prefix="/workspaces", tags=["v2:workspace-settings"])

# Project-level: /projects/{id}/move
v2_router.include_router(projects_router, prefix="/projects", tags=["v2:projects"])
