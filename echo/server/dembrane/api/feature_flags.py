"""FastAPI dependencies that gate routes behind feature flags."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from dembrane.settings import get_settings


def require_canvas_enabled() -> None:
    """404 (not 403, to hide existence) when the canvas feature is disabled."""
    if not get_settings().feature_flags.enable_canvas:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


def require_project_canvas_enabled(project: dict[str, Any] | None) -> None:
    """404 unless the global flag is on AND this project opted into the canvas beta.

    Canvas is off by default everywhere; a host flips project.is_canvas_enabled
    via the experimental toggle in project settings. Pass the already-fetched
    project row (e.g. ResourceAccess.project) to avoid a second read.
    """
    require_canvas_enabled()
    if not (project or {}).get("is_canvas_enabled"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


async def project_canvas_enabled(project_id: str) -> bool:
    """Plain boolean: the global flag AND the project's beta toggle.

    Also used outside FastAPI (agentic worker, tick pipeline) to decide
    whether canvas capabilities exist for a project at all.
    """
    if not get_settings().feature_flags.enable_canvas:
        return False
    from dembrane.directus_async import async_directus

    try:
        project = await async_directus.get_item("project", project_id)
    except Exception:
        return False
    return bool(isinstance(project, dict) and project.get("is_canvas_enabled"))


async def require_canvas_enabled_for_project(project_id: str) -> None:
    """Dependency variant for routes with a {project_id} path param."""
    if not await project_canvas_enabled(project_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
