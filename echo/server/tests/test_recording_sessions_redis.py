"""record_presence's MULTI pipeline against a real Redis. Skips when none is
reachable so the suite stays green on a laptop without the devcontainer
services."""

from __future__ import annotations

import uuid
import asyncio

import pytest

import dembrane.recording_sessions as rs
from dembrane.redis_async import get_redis_client


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


async def _redis_available() -> bool:
    try:
        client = await get_redis_client()
        await client.ping()
        return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _run(_redis_available()), reason="no Redis reachable")


def test_concurrent_presence_counts_every_member() -> None:
    account = f"test-{uuid.uuid4()}"

    async def scenario() -> tuple[list[int], int]:
        client = await get_redis_client()
        try:
            counts = await asyncio.gather(
                *(rs.record_presence(account, f"c{i}") for i in range(20))
            )
            return list(counts), await rs.count_active(account)
        finally:
            await client.delete(rs.session_key(account))

    counts, total = _run(scenario())
    assert total == 20
    assert max(counts) == 20
