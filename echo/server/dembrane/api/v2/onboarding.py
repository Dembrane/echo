"""POST /v2/onboarding/complete — one-time user onboarding."""

from logging import getLogger

from fastapi import APIRouter

from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.api.v2.schemas import OnboardingCompleteRequest, OnboardingCompleteResponse

router = APIRouter()
logger = getLogger("api.v2.onboarding")


@router.post("/complete", response_model=OnboardingCompleteResponse)
async def complete_onboarding(
    body: OnboardingCompleteRequest,
    auth: DependencyDirectusSession,
) -> OnboardingCompleteResponse:
    """Placeholder — implemented in commit 4."""
    raise NotImplementedError("Onboarding endpoint not yet implemented")
