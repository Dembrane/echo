"""Server-side PostHog capture (analytics mirror).

The onboarding questionnaire is dual-written: Directus is the durable store,
PostHog is the analytics mirror. Server-side capture is resilient to ad
blockers and never depends on the browser firing the event.

Founder decision D2:
  - Use the same project ingest keys as production (project 160282) and
    echo-next (project 197841).
  - Enable capture ONLY on those two environments. Local, testing, and any
    other deployment opt out entirely so stray hosts can't pollute prod
    analytics.
  - Resolve which project to report into from the default admin URL.

We post directly to the PostHog HTTP capture API (no posthog SDK dependency).
Ingest keys are public by design (they ship in the frontend bundle too).
"""

from __future__ import annotations

from typing import Any, Optional
from logging import getLogger

import httpx

from dembrane.settings import get_settings

logger = getLogger("analytics")

POSTHOG_HOST = "https://eu.i.posthog.com"

# echo (production): project 160282. Mirrors frontend/src/config.ts.
_POSTHOG_TOKEN_PRODUCTION = "phc_o9ZqNqaop7cwLvbbEU2gwvaY5CczpavbNfCxrnu2Ca4a"
# echo-next: project 197841.
_POSTHOG_TOKEN_NEXT = "phc_qMo8i67hwneqDG3x8NW4iTyUiqPMsR9pZ3H5QaJQ4zkM"


def _resolve_posthog_token() -> Optional[str]:
    """Pick the project ingest key from the default admin URL, or None to
    opt out. Only production and echo-next capture; everything else (local,
    testing, previews) returns None."""
    admin_url = (get_settings().urls.admin_base_url or "").lower()
    if "dashboard.dembrane.com" in admin_url:
        return _POSTHOG_TOKEN_PRODUCTION
    if "dashboard.echo-next.dembrane.com" in admin_url:
        return _POSTHOG_TOKEN_NEXT
    return None


def _capture_sync(distinct_id: str, event: str, properties: dict[str, Any]) -> None:
    token = _resolve_posthog_token()
    if not token:
        logger.debug("posthog capture skipped (env opted out): %s", event)
        return
    try:
        resp = httpx.post(
            f"{POSTHOG_HOST}/capture/",
            json={
                "api_key": token,
                "event": event,
                "distinct_id": distinct_id,
                "properties": {**properties, "$lib": "dembrane-server"},
            },
            timeout=5.0,
        )
        if resp.status_code >= 400:
            logger.warning(
                "posthog capture %s returned %s: %s",
                event,
                resp.status_code,
                resp.text[:200],
            )
    except Exception:  # noqa: BLE001 — analytics is best-effort, never raise
        logger.exception("posthog capture failed for event %s", event)


async def capture_event(
    distinct_id: str,
    event: str,
    properties: Optional[dict[str, Any]] = None,
) -> None:
    """Fire-and-forget server-side PostHog event. Runs the blocking HTTP call
    in a thread pool so it doesn't block the event loop. Never raises."""
    from dembrane.async_helpers import run_in_thread_pool

    try:
        await run_in_thread_pool(
            _capture_sync, distinct_id, event, properties or {}
        )
    except Exception:  # noqa: BLE001
        logger.exception("capture_event wrapper failed for %s", event)
