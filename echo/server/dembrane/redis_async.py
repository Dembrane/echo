from __future__ import annotations

import asyncio
from typing import Optional

from redis.asyncio import Redis

from dembrane.settings import get_settings

_redis_client: Optional[Redis] = None
_lock = asyncio.Lock()


async def get_redis_client() -> Redis:
    """
    Lazily initialise and return a shared async Redis client.
    """
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    async with _lock:
        if _redis_client is None:
            settings = get_settings()
            redis_url = settings.cache.redis_url
            # decode responses to str for easier debugging, but keep bytes if preferred.
            _redis_client = Redis.from_url(
                redis_url,
                encoding="utf-8",
                decode_responses=False,
            )
        return _redis_client
