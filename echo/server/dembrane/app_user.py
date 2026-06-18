"""
App user resolution and creation helpers.

Maps directus_users.id → app_user.id. Used by all v2 endpoints.
"""

from __future__ import annotations

from typing import Optional
from logging import getLogger

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus

logger = getLogger("dembrane.app_user")


async def resolve_app_user(directus_user_id: str) -> Optional[dict]:
    """Look up app_user by directus_user_id. Returns None if not onboarded."""
    items = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"directus_user_id": {"_eq": directus_user_id}},
                "limit": 1,
            }
        },
    )
    if isinstance(items, list) and len(items) > 0:
        return items[0]
    return None


async def get_app_user_or_raise(directus_user_id: str) -> dict:
    """Look up app_user or raise. For endpoints that require onboarding."""
    from fastapi import HTTPException

    app_user = await resolve_app_user(directus_user_id)
    if not app_user:
        raise HTTPException(status_code=403, detail="User not onboarded")
    return app_user


async def create_app_user(
    directus_user_id: str,
    email: str,
    display_name: str,
) -> dict:
    """Create a new app_user. Returns the created record (unwrapped).

    Records `terms_accepted_at` (ISSUE-013): registration cannot complete
    without ticking "I accept the terms", so reaching app_user creation
    implies acceptance. No version string yet — presence means accepted.
    """
    from datetime import datetime, timezone

    app_user_id = generate_uuid()
    result = await async_directus.create_item(
        "app_user",
        {
            "id": app_user_id,
            "directus_user_id": directus_user_id,
            "email": email,
            "display_name": display_name,
            "terms_accepted_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    return result["data"]


async def get_directus_user_profile(directus_user_id: str) -> Optional[dict]:
    """Fetch display name and email from directus_users."""
    users = await async_directus.get_users(
        {
            "query": {
                "filter": {"id": {"_eq": directus_user_id}},
                "fields": ["id", "first_name", "last_name", "email", "avatar"],
                "limit": 1,
            }
        },
    )
    if isinstance(users, list) and len(users) > 0:
        user = users[0]
        first = user.get("first_name") or ""
        last = user.get("last_name") or ""
        user["display_name"] = f"{first} {last}".strip() or user.get("email", "")
        return user
    return None
