"""Read side shared by the in-app and public popcorn pages.

The presentation polls its data at up to five times a second while the stage
is empty, and every viewer in the room may hold a tab open, so the bundle is
memoised for a moment per report. The tick nudges the channel when it writes,
and the stale window is shorter than the page's own poll interval.
"""

from __future__ import annotations

import time
from typing import Any

from dembrane.settings import get_settings
from dembrane.directus_async import async_directus
from dembrane.popcorn.service import (
    build_bundle,
    normalize_state,
    get_latest_config,
    normalize_settings,
    get_loop_for_report,
)

BUNDLE_CACHE_SECONDS = 0.5
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _as_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    return str(value) if value is not None else None


async def load_settings(report: dict[str, Any]) -> dict[str, Any]:
    config = await get_latest_config(str(report["id"]))
    return normalize_settings(
        (config or {}).get("popcorn_settings"),
        fallback_title=str(report.get("user_instructions") or "Popcorn"),
    )


async def bundle_for_report(
    report: dict[str, Any],
    project: dict[str, Any] | None = None,
    *,
    host: bool = False,
) -> dict[str, Any]:
    report_id = str(report["id"])
    cache_key = f"{report_id}:{'host' if host else 'public'}"
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached and now - cached[0] < BUNDLE_CACHE_SECONDS:
        return cached[1]

    loop = await get_loop_for_report(report_id)
    settings = await load_settings(report)
    if project is None:
        project_id = _as_id(report.get("project_id"))
        project = (
            await async_directus.get_item("project", project_id) if project_id else None
        ) or {}
    bundle = build_bundle(
        state=normalize_state((loop or {}).get("popcorn_state")),
        settings=settings,
        report=report,
        project=project,
        participant_base_url=get_settings().urls.participant_base_url,
        admin_base_url=get_settings().urls.admin_base_url,
        host=host,
    )
    _cache[cache_key] = (now, bundle)
    if len(_cache) > 512:
        oldest = sorted(_cache.items(), key=lambda item: item[1][0])[: len(_cache) - 256]
        for key, _ in oldest:
            _cache.pop(key, None)
    return bundle


def forget_bundle(report_id: str) -> None:
    for key in (f"{report_id}:host", f"{report_id}:public"):
        _cache.pop(key, None)
