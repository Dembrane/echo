"""Map's live events: generation progress and fact-check changes, per project.

Carried by `dembrane.live_events` (Redis pub/sub, one SSE stream per page)."""

from __future__ import annotations

from typing import Any

from dembrane import live_events


def project_channel(project_id: str) -> str:
    return f"map:project:{project_id}"


async def publish_map_event(project_id: str, event: dict[str, Any]) -> None:
    if project_id:
        await live_events.publish(project_channel(project_id), event)
