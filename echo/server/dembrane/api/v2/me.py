"""GET /v2/me — lightweight user profile with onboarding status."""

from logging import getLogger
from datetime import datetime, timezone

from fastapi import APIRouter

from dembrane.app_user import resolve_app_user, get_directus_user_profile
from dembrane.directus_async import async_directus
from dembrane.api.v2.schemas import MeResponse, OrgSummary
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.me")


@router.get("", response_model=MeResponse)
async def get_me(auth: DependencyDirectusSession) -> MeResponse:
    """Lightweight user profile with onboarding status, org memberships,
    and pending invite check."""

    app_user = await resolve_app_user(auth.user_id)
    directus_profile = await get_directus_user_profile(auth.user_id)

    if not directus_profile:
        logger.warning(f"Directus user not found for id {auth.user_id}")
        return MeResponse(
            directus_user_id=auth.user_id,
            email="",
            display_name="",
            onboarding_completed=False,
        )

    email = directus_profile.get("email", "")

    # Check for pending workspace invites (by email, regardless of onboarding)
    has_pending_invites = False
    if email:
        pending = await async_directus.get_items(
            "workspace_invite",
            {
                "query": {
                    "filter": {
                        "email": {"_eq": email},
                        "accepted_at": {"_null": True},
                        "expires_at": {"_gt": datetime.now(timezone.utc).isoformat()},
                    },
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )
        has_pending_invites = isinstance(pending, list) and len(pending) > 0

    if not app_user:
        return MeResponse(
            directus_user_id=auth.user_id,
            email=email,
            display_name=directus_profile.get("display_name", ""),
            avatar=directus_profile.get("avatar"),
            onboarding_completed=False,
            has_pending_invites=has_pending_invites,
        )

    # Fetch org memberships
    orgs: list[OrgSummary] = []
    org_memberships = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "user_id": {"_eq": app_user["id"]},
                    "deleted_at": {"_null": True},
                },
                "fields": ["org_id", "role"],
                "limit": -1,
            }
        },
    )
    if isinstance(org_memberships, list) and len(org_memberships) > 0:
        org_ids = [m["org_id"] for m in org_memberships if m.get("org_id")]
        org_data = await async_directus.get_items(
            "org",
            {
                "query": {
                    "filter": {"id": {"_in": org_ids}, "deleted_at": {"_null": True}},
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        org_map = {o["id"]: o for o in (org_data or []) if isinstance(o, dict)}
        for m in org_memberships:
            org = org_map.get(m["org_id"])
            if org:
                orgs.append(OrgSummary(
                    id=org["id"],
                    name=org.get("name", ""),
                    role=m["role"],
                ))

    return MeResponse(
        id=app_user["id"],
        directus_user_id=auth.user_id,
        email=app_user.get("email") or email,
        display_name=app_user.get("display_name") or directus_profile.get("display_name", ""),
        avatar=directus_profile.get("avatar"),
        onboarding_completed=True,
        orgs=orgs,
        has_pending_invites=has_pending_invites,
    )
