"""Map's live events: generation progress and fact-check changes, per project.

Carried by `dembrane.live_events` (Redis pub/sub, one SSE stream per page).
Once map generation runs through the analysis executor, the page also follows
the project's analysis channel, where executor runs publish queued, progress,
ready and failed events; map view snapshots announce themselves on the map
channel as `ready` with their snapshot id."""

from __future__ import annotations

from typing import Any

from dembrane import live_events
from dembrane.analysis.executor import live_channel


def project_channel(project_id: str) -> str:
    return f"map:project:{project_id}"


def map_channels(project_id: str, *, runs: bool) -> list[str]:
    """The channels a map page listens to; `runs` adds the executor's."""
    return [project_channel(project_id), *([live_channel(project_id)] if runs else [])]


async def publish_map_event(project_id: str, event: dict[str, Any]) -> None:
    if project_id:
        await live_events.publish(project_channel(project_id), event)
