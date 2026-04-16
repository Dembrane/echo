"""GET /v2/me — lightweight user profile with onboarding status."""

from logging import getLogger

from fastapi import APIRouter

from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.me")


@router.get("")
async def get_me(auth: DependencyDirectusSession) -> dict:
    """Placeholder — implemented in commit 3."""
    return {"directus_user_id": auth.user_id, "onboarding_completed": False}
