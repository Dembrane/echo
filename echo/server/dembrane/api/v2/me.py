"""GET /v2/me — lightweight user profile with onboarding status."""

from logging import getLogger

from fastapi import APIRouter

from dembrane.app_user import resolve_app_user, get_directus_user_profile
from dembrane.api.v2.schemas import MeResponse
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.me")


@router.get("", response_model=MeResponse)
async def get_me(auth: DependencyDirectusSession) -> MeResponse:
    """Lightweight user profile with onboarding status.

    Called on every page load — must be fast. Returns app_user info
    if onboarded, or just directus_user info if not yet onboarded.
    """
    # Check if user has completed onboarding (has app_user record)
    app_user = await resolve_app_user(auth.user_id)

    # Fetch display info from Directus (needed regardless of onboarding state)
    directus_profile = await get_directus_user_profile(auth.user_id)

    if not directus_profile:
        logger.warning(f"Directus user not found for id {auth.user_id}")
        return MeResponse(
            directus_user_id=auth.user_id,
            email="",
            display_name="",
            onboarding_completed=False,
        )

    if app_user:
        return MeResponse(
            id=app_user["id"],
            directus_user_id=auth.user_id,
            email=app_user.get("email") or directus_profile.get("email", ""),
            display_name=app_user.get("display_name") or directus_profile.get("display_name", ""),
            avatar=directus_profile.get("avatar"),
            onboarding_completed=True,
        )

    return MeResponse(
        directus_user_id=auth.user_id,
        email=directus_profile.get("email", ""),
        display_name=directus_profile.get("display_name", ""),
        avatar=directus_profile.get("avatar"),
        onboarding_completed=False,
    )
