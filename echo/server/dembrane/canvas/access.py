"""Reader semantics for canvas ticks.

Phase 0 deliberately does not mint scoped tokens. The tick pipeline runs
in-process, so this helper verifies that the loop's acting Directus user still
has read access to the project and returns only the narrow ids future tick code
needs. The minted-token version arrives with D2 when execution crosses a process
boundary.
"""

from __future__ import annotations

from dataclasses import dataclass

from dembrane.app_user import get_app_user_or_raise
from dembrane.inheritance import get_user_project_access
from dembrane.directus_async import async_directus


class CanvasReaderAccessDenied(PermissionError):
    """Raised when a canvas tick's acting user can no longer read the project."""


@dataclass(frozen=True)
class CanvasReaderContext:
    project_id: str
    workspace_id: str | None
    directus_user_id: str
    app_user_id: str


async def resolve_canvas_reader_context(
    *,
    acting_directus_user_id: str,
    project_id: str,
) -> CanvasReaderContext:
    """Verify reader access and return the ids a canvas tick may use."""
    app_user = await get_app_user_or_raise(acting_directus_user_id)
    app_user_id = str(app_user["id"])

    project = await async_directus.get_item("project", project_id)
    if not isinstance(project, dict) or project.get("deleted_at"):
        raise CanvasReaderAccessDenied("Project not found")

    access = await get_user_project_access(
        project_id=project_id,
        user_id=app_user_id,
        directus_user_id=acting_directus_user_id,
        project=project,
    )
    if access is None:
        raise CanvasReaderAccessDenied("Project access denied")

    workspace_id = project.get("workspace_id")
    return CanvasReaderContext(
        project_id=project_id,
        workspace_id=str(workspace_id) if workspace_id else None,
        directus_user_id=acting_directus_user_id,
        app_user_id=app_user_id,
    )

