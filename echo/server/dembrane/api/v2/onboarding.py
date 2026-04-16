"""POST /v2/onboarding/complete — one-time user onboarding.

Creates app_user + org + default workspace + moves all user's projects.
Idempotent: if already onboarded, returns existing IDs without creating anything.
"""

from logging import getLogger

from fastapi import APIRouter, HTTPException

from dembrane.utils import generate_uuid
from dembrane.app_user import resolve_app_user, create_app_user, get_directus_user_profile
from dembrane.directus_async import async_directus
from dembrane.api.v2.schemas import OnboardingCompleteRequest, OnboardingCompleteResponse
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.onboarding")


@router.post("/complete", response_model=OnboardingCompleteResponse)
async def complete_onboarding(
    body: OnboardingCompleteRequest,
    auth: DependencyDirectusSession,
) -> OnboardingCompleteResponse:
    """Complete user onboarding. Creates org + workspace + moves projects.

    Idempotent: safe to call multiple times. If already onboarded, returns
    existing IDs. If partially completed (e.g., app_user exists but no org),
    picks up where it left off.
    """
    directus_user_id = auth.user_id
    org_name = body.org_name.strip()

    if not org_name:
        raise HTTPException(status_code=400, detail="Organization name is required")

    # ── Step 1: Get or create app_user ──

    app_user = await resolve_app_user(directus_user_id)

    if not app_user:
        profile = await get_directus_user_profile(directus_user_id)
        if not profile:
            raise HTTPException(status_code=404, detail="Directus user not found")

        app_user = await create_app_user(
            directus_user_id=directus_user_id,
            email=profile.get("email", ""),
            display_name=profile.get("display_name", ""),
        )
        logger.info(f"Created app_user {app_user['id']} for directus user {directus_user_id}")

    app_user_id = app_user["id"]

    # ── Step 2: Get or create org ──

    existing_orgs = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "user_id": {"_eq": app_user_id},
                    "role": {"_eq": "owner"},
                    "deleted_at": {"_null": True},
                },
                "fields": ["org_id"],
                "limit": 1,
            }
        },
    )

    if isinstance(existing_orgs, list) and len(existing_orgs) > 0:
        org_id = existing_orgs[0]["org_id"]
        logger.info(f"User {app_user_id} already owns org {org_id}, skipping org creation")
    else:
        org_id = generate_uuid()
        await async_directus.create_item("org", {
            "id": org_id,
            "name": org_name,
            "created_by": app_user_id,
        })
        await async_directus.create_item("org_membership", {
            "id": generate_uuid(),
            "org_id": org_id,
            "user_id": app_user_id,
            "role": "owner",
        })
        logger.info(f"Created org {org_id} '{org_name}' for user {app_user_id}")

    # ── Step 3: Get or create default workspace ──

    existing_workspaces = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "is_default": {"_eq": True},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )

    if isinstance(existing_workspaces, list) and len(existing_workspaces) > 0:
        workspace_id = existing_workspaces[0]["id"]
        logger.info(f"Default workspace {workspace_id} already exists for org {org_id}")
    else:
        workspace_id = generate_uuid()
        await async_directus.create_item("workspace", {
            "id": workspace_id,
            "org_id": org_id,
            "name": "Default",
            "is_default": True,
            "tier": "pioneer",
            "created_by": app_user_id,
        })
        await async_directus.create_item("workspace_membership", {
            "id": generate_uuid(),
            "workspace_id": workspace_id,
            "user_id": app_user_id,
            "role": "owner",
            "source": "inherited",
        })
        logger.info(f"Created default workspace {workspace_id} for org {org_id}")

    # ── Step 4: Move user's projects into the workspace ──

    projects = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": {
                    "directus_user_id": {"_eq": directus_user_id},
                    "workspace_id": {"_null": True},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    )

    moved_count = 0
    if isinstance(projects, list):
        for project in projects:
            await async_directus.update_item(
                "project",
                project["id"],
                {"workspace_id": workspace_id},
            )
            moved_count += 1

    if moved_count > 0:
        logger.info(f"Moved {moved_count} projects into workspace {workspace_id}")

    return OnboardingCompleteResponse(
        app_user_id=app_user_id,
        org_id=org_id,
        workspace_id=workspace_id,
    )
