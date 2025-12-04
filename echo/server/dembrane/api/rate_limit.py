from __future__ import annotations

import math

from fastapi import HTTPException, status

from dembrane.redis_async import get_redis_client

RATE_LIMIT_PREFIX = "dembrane:rate_limit"


class RedisUserRateLimiter:
    def __init__(self, *, key: str, capacity: int, window_seconds: float) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be greater than zero")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be greater than zero")

        self.capacity = capacity
        self.window_seconds = window_seconds
        self.key = f"{RATE_LIMIT_PREFIX}:{key}"

    async def check(self, user_id: str) -> None:
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Authenticated user required.",
            )

        client = await get_redis_client()
        redis_key = f"{self.key}:{user_id}"

        count = await client.incr(redis_key)
        if count == 1:
            await client.expire(redis_key, math.ceil(self.window_seconds))
        elif count > self.capacity:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Try again later.",
            )


def create_user_rate_limiter(*, name: str, capacity: int, window_seconds: float) -> RedisUserRateLimiter:
    return RedisUserRateLimiter(key=name, capacity=capacity, window_seconds=window_seconds)


class RedisRateLimiter:
    """Generic rate limiter that can be keyed by any identifier."""

    def __init__(self, *, key: str, capacity: int, window_seconds: float) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be greater than zero")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be greater than zero")

        self.capacity = capacity
        self.window_seconds = window_seconds
        self.key = f"{RATE_LIMIT_PREFIX}:{key}"

    async def check(self, identifier: str) -> None:
        """
        Check rate limit for the given identifier.
        Raises HTTP 429 if limit exceeded.
        """
        if not identifier:
            return  # Skip rate limiting if no identifier

        client = await get_redis_client()
        redis_key = f"{self.key}:{identifier}"

        count = await client.incr(redis_key)
        if count == 1:
            await client.expire(redis_key, math.ceil(self.window_seconds))
        elif count > self.capacity:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Try again later.",
            )


def create_rate_limiter(*, name: str, capacity: int, window_seconds: float) -> RedisRateLimiter:
    """Create a generic rate limiter keyed by any identifier."""
    return RedisRateLimiter(key=name, capacity=capacity, window_seconds=window_seconds)
