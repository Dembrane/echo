from __future__ import annotations

import json
import asyncio
from typing import Any, List
from logging import getLogger

from fastapi import Request, APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.directus import directus
from dembrane.redis_async import get_redis_client
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.rate_limit import create_rate_limiter

logger = getLogger("api.stats")

StatsRouter = APIRouter(tags=["stats"])

STATS_CACHE_KEY = "dembrane:stats:public"
STATS_CACHE_LOCK_KEY = "dembrane:stats:public:lock"
STATS_CACHE_TTL_SECONDS = 3600  # 1 hour
STATS_LOCK_TTL_SECONDS = 30  # Lock expires after 30s to prevent deadlocks

_stats_rate_limiter = create_rate_limiter(
    name="public_stats",
    capacity=10,
    window_seconds=60,  # 10 requests per IP per minute
)


class StatsResponse(BaseModel):
    projects_count: int
    conversations_count: int
    hours_recorded: int


def _get_client_ip(request: Request) -> str:
    """Extract client IP, respecting X-Forwarded-For behind reverse proxies."""
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        # First IP in the chain is the original client
        return forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


def _fetch_admin_user_ids() -> List[str]:
    """Fetch IDs of admin users from Directus (sync, must be wrapped)."""
    admin_users = directus.get_users(
        {
            "query": {
                "filter": {"role": {"name": {"_eq": "Administrator"}}},
                "fields": ["id"],
                "limit": -1,
            }
        }
    )
    if not admin_users:
        return []
    return [u["id"] for u in admin_users if u.get("id")]


def _fetch_projects(admin_user_ids: List[str]) -> List[dict[str, Any]]:
    """Fetch non-admin projects created since 2024 (sync, must be wrapped)."""
    filter_conditions: List[dict[str, Any]] = [
        {"created_at": {"_gte": "2024-01-01T00:00:00Z"}},
    ]
    if admin_user_ids:
        filter_conditions.append(
            {"directus_user_id": {"_nin": admin_user_ids}},
        )

    return directus.get_items(
        "project",
        {
            "query": {
                "filter": {"_and": filter_conditions},
                "fields": ["id"],
                "limit": -1,
            }
        },
    )


def _fetch_conversation_stats(project_ids: List[str]) -> tuple[int, float]:
    """
    Fetch conversation count and total duration for given project IDs.
    Returns (count, total_seconds).
    Sync — must be wrapped.
    """
    if not project_ids:
        return 0, 0.0

    conversations = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"project_id": {"_in": project_ids}},
                "fields": ["duration"],
                "limit": -1,
            }
        },
    )
    if not conversations:
        return 0, 0.0

    count = len(conversations)
    total_seconds = sum(c.get("duration") or 0 for c in conversations)
    return count, total_seconds


async def _compute_stats() -> StatsResponse:
    """Compute fresh stats by querying Directus."""
    admin_user_ids = await run_in_thread_pool(_fetch_admin_user_ids)
    logger.debug("Admin user IDs to exclude: %s", admin_user_ids)

    projects = await run_in_thread_pool(_fetch_projects, admin_user_ids)
    project_ids = [p["id"] for p in projects] if projects else []
    logger.debug("Non-admin projects since 2024: %d", len(project_ids))

    conversations_count, total_seconds = await run_in_thread_pool(
        _fetch_conversation_stats, project_ids
    )
    hours_recorded = round(total_seconds / 3600)

    return StatsResponse(
        projects_count=len(project_ids),
        conversations_count=conversations_count,
        hours_recorded=hours_recorded,
    )


async def _get_cached_stats() -> StatsResponse | None:
    """Try to read stats from Redis cache."""
    try:
        redis = await get_redis_client()
        raw = await redis.get(STATS_CACHE_KEY)
        if raw:
            # Redis client has decode_responses=False, so raw is bytes
            data = json.loads(raw)
            logger.debug("Stats cache hit")
            return StatsResponse(**data)
    except Exception as e:
        logger.warning("Stats cache read error: %s", e)
    return None


async def _set_cached_stats(stats: StatsResponse) -> None:
    """Store stats in Redis cache with TTL."""
    try:
        redis = await get_redis_client()
        await redis.setex(
            STATS_CACHE_KEY,
            STATS_CACHE_TTL_SECONDS,
            json.dumps(stats.model_dump()),
        )
        logger.debug("Stats cached with TTL %ds", STATS_CACHE_TTL_SECONDS)
    except Exception as e:
        logger.warning("Stats cache write error: %s", e)


async def _acquire_lock() -> bool:
    """Try to acquire a Redis lock for cache computation. Returns True if acquired."""
    try:
        redis = await get_redis_client()
        # SET NX (only if not exists) with expiry to prevent deadlocks
        acquired = await redis.set(
            STATS_CACHE_LOCK_KEY,
            "1",
            nx=True,
            ex=STATS_LOCK_TTL_SECONDS,
        )
        return acquired is not None
    except Exception as e:
        logger.warning("Lock acquire error: %s", e)
        return False


async def _release_lock() -> None:
    """Release the Redis lock."""
    try:
        redis = await get_redis_client()
        await redis.delete(STATS_CACHE_LOCK_KEY)
    except Exception as e:
        logger.warning("Lock release error: %s", e)


@StatsRouter.get("/", response_model=StatsResponse)
async def get_public_stats(request: Request) -> StatsResponse:
    """
    Public endpoint returning aggregate platform statistics.
    Rate-limited to 10 requests per IP per minute.
    Results are cached in Redis for 1 hour.
    Uses a lock to prevent cache stampede on expiry.
    """
    client_ip = _get_client_ip(request)
    await _stats_rate_limiter.check(client_ip)

    # Check cache first
    cached = await _get_cached_stats()
    if cached is not None:
        return cached

    # Cache miss — try to acquire lock to prevent stampede
    if await _acquire_lock():
        try:
            # Double-check cache (another request may have populated it)
            cached = await _get_cached_stats()
            if cached is not None:
                return cached

            # Compute and cache fresh stats
            stats = await _compute_stats()
            await _set_cached_stats(stats)
            return stats
        finally:
            await _release_lock()
    else:
        # Another request is computing — wait for it to finish, polling cache
        for _ in range(STATS_LOCK_TTL_SECONDS * 2):  # Wait up to lock TTL
            await asyncio.sleep(0.5)
            cached = await _get_cached_stats()
            if cached is not None:
                return cached

        # Lock holder likely failed — return 503 instead of stampeding Directus
        logger.warning("Stats computation timed out waiting for lock holder")
        raise HTTPException(
            status_code=503,
            detail="Stats temporarily unavailable. Try again shortly.",
            headers={"Retry-After": "5"},
        )
