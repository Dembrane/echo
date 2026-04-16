"""
V2 API — workspace-aware endpoints.

All v2 endpoints use app_user.id (not directus_users.id), check workspace
permissions via policies, and return typed Pydantic response models.

Mounted at /api/v2/ in main.py.
"""

from fastapi import APIRouter

from dembrane.api.v2.me import router as me_router
from dembrane.api.v2.onboarding import router as onboarding_router

v2_router = APIRouter()

v2_router.include_router(me_router, prefix="/me", tags=["v2:me"])
v2_router.include_router(onboarding_router, prefix="/onboarding", tags=["v2:onboarding"])
