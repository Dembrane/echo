from __future__ import annotations

import asyncio

from redis.asyncio import Redis

from dembrane.settings import get_settings

# One client per event loop, like the async Directus client. A client is bound
# to the loop that opened its connections; reused from another loop (after the
# worker's self-heal reset, or from a private tick loop) every call fails with
# "attached to a different loop" and, in run_async_in_new_loop, that failure
# triggers a further reset.
_clients_by_loop: dict[int, Redis] = {}


async def get_redis_client() -> Redis:
    """Return the shared async Redis client for the running event loop."""
    loop_id = id(asyncio.get_running_loop())
    client = _clients_by_loop.get(loop_id)
    if client is None:
        settings = get_settings()
        # decode responses to str for easier debugging, but keep bytes if preferred.
        client = Redis.from_url(
            settings.cache.redis_url,
            encoding="utf-8",
            decode_responses=False,
        )
        _clients_by_loop[loop_id] = client
    return client


def reset_clients() -> int:
    """Drop every cached client without awaiting close: the recovery hook for a
    poisoned loop. The next call creates a fresh client on the current loop."""
    count = len(_clients_by_loop)
    _clients_by_loop.clear()
    return count
