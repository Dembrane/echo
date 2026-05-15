"""
V2 API — workspace-aware endpoints.

All v2 endpoints use app_user.id (not directus_users.id), check workspace
permissions via policies, and return typed Pydantic response models.

Mounted at /api/v2/ in main.py.
"""

from fastapi import APIRouter

from dembrane.api.v2.me import router as me_router
from dembrane.api.v2.auth import router as auth_router
from dembrane.api.v2.orgs import router as orgs_router
from dembrane.api.v2.admin import router as admin_router
from dembrane.api.v2.invites import router as invites_router
from dembrane.api.v2.bff.tags import (
    router as bff_tags_router,
    run_router as bff_analysis_runs_router,
    project_router as bff_projects_write_router,
)
from dembrane.api.v2.projects import router as projects_router
from dembrane.api.v2.bff.chats import (
    router as bff_chats_router,
    message_router as bff_chat_message_router,
)
from dembrane.api.v2.onboarding import router as onboarding_router
from dembrane.api.v2.workspaces import router as workspaces_router
from dembrane.api.v2.bff.reports import (
    router as bff_reports_router,
    metric_router as bff_report_metric_router,
)
from dembrane.api.v2.notifications import router as notifications_router
from dembrane.api.v2.access_requests import (
    router as access_requests_router,
    discover_router as access_requests_discover_router,
)
from dembrane.api.v2.project_sharing import router as project_sharing_router
from dembrane.api.v2.bff.conversations import (
    router as bff_conversations_router,
    chunk_router as bff_chunk_router,
    junction_router as bff_conv_tag_router,
)
from dembrane.api.v2.workspace_projects import router as workspace_projects_router
from dembrane.api.v2.workspace_requests import (
    router as workspace_requests_router,
    history_router as workspace_request_history_router,
)
from dembrane.api.v2.workspace_settings import router as workspace_settings_router

v2_router = APIRouter()

v2_router.include_router(me_router, prefix="/me", tags=["v2:me"])
# Public auth helpers (email-availability check). No auth — the
# registration form needs to call this before the user has a session.
v2_router.include_router(auth_router, prefix="/auth", tags=["v2:auth"])
v2_router.include_router(
    notifications_router, prefix="/me/notifications", tags=["v2:notifications"]
)
v2_router.include_router(onboarding_router, prefix="/onboarding", tags=["v2:onboarding"])

# Organisation (org) management — user-facing word is "organisation", internal is "org" (see D1).
v2_router.include_router(orgs_router, prefix="/orgs", tags=["v2:orgs"])
v2_router.include_router(access_requests_discover_router, prefix="/orgs", tags=["v2:discover"])

# Workspace-scoped: /workspaces, /workspaces/{id}/invite, /workspaces/{id}/projects
v2_router.include_router(workspaces_router, prefix="/workspaces", tags=["v2:workspaces"])
v2_router.include_router(invites_router, prefix="/workspaces", tags=["v2:invites"])
v2_router.include_router(
    workspace_projects_router, prefix="/workspaces", tags=["v2:workspace-projects"]
)
v2_router.include_router(
    workspace_settings_router, prefix="/workspaces", tags=["v2:workspace-settings"]
)
v2_router.include_router(access_requests_router, prefix="/workspaces", tags=["v2:access-requests"])
v2_router.include_router(
    workspace_requests_router, prefix="/workspace-requests", tags=["v2:workspace-requests"]
)
v2_router.include_router(
    workspace_request_history_router, prefix="/workspaces", tags=["v2:workspace-requests"]
)

# Project-level: /projects/{id}/move + /projects/{id}/members (private sharing)
v2_router.include_router(projects_router, prefix="/projects", tags=["v2:projects"])
v2_router.include_router(project_sharing_router, prefix="/projects", tags=["v2:project-sharing"])

# BFF endpoints — funnel the old direct-Directus frontend calls through
# an access-aware layer (see api/v2/bff/_access.py). Everything under
# /v2/bff/* enforces the v2 inheritance/sharing model before touching
# Directus with admin privileges. Once every frontend call has
# migrated, Directus collection ACLs for these tables can be locked to
# admin-only (see scripts/lock_directus_permissions.py).
v2_router.include_router(
    bff_conversations_router, prefix="/bff/conversations", tags=["v2:bff:conv"]
)
v2_router.include_router(
    bff_chunk_router, prefix="/bff/conversation-chunks", tags=["v2:bff:chunks"]
)
v2_router.include_router(
    bff_conv_tag_router,
    prefix="/bff/conversation-project-tags",
    tags=["v2:bff:conv-tags"],
)
v2_router.include_router(bff_chats_router, prefix="/bff/chats", tags=["v2:bff:chats"])
v2_router.include_router(
    bff_chat_message_router,
    prefix="/bff/chat-messages",
    tags=["v2:bff:chat-messages"],
)
v2_router.include_router(bff_reports_router, prefix="/bff/reports", tags=["v2:bff:reports"])
v2_router.include_router(
    bff_report_metric_router,
    prefix="/bff/report-metrics",
    tags=["v2:bff:report-metrics"],
)
v2_router.include_router(bff_tags_router, prefix="/bff/tags", tags=["v2:bff:tags"])
v2_router.include_router(
    bff_analysis_runs_router,
    prefix="/bff/analysis-runs",
    tags=["v2:bff:analysis-runs"],
)
v2_router.include_router(
    bff_projects_write_router,
    prefix="/bff/projects",
    tags=["v2:bff:projects-write"],
)

# Staff-only admin tools (billing rollup, at-risk, tier change, partner ledger).
# is_admin JWT claim is the gate for now; storage-backed staff policies
# (staff:can_set_tier etc.) are declared in policies.py but not wired.
v2_router.include_router(admin_router, prefix="/admin", tags=["v2:admin"])
