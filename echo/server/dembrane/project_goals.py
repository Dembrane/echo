from __future__ import annotations

from typing import Any

from dembrane.directus_async import async_directus

GOAL_REVISION_FIELDS = ["id", "content", "set_by", "created_at"]


def to_goal_revision(row: dict[str, Any]) -> dict[str, Any]:
    return {field: row.get(field) for field in GOAL_REVISION_FIELDS}


async def list_project_goal_revisions(project_id: str) -> list[dict[str, Any]]:
    rows = await async_directus.get_items(
        "project_goal_revision",
        {
            "query": {
                "filter": {"project_id": {"_eq": project_id}},
                "fields": GOAL_REVISION_FIELDS,
                "sort": ["-created_at"],
                "limit": 100,
            }
        },
    )
    return [to_goal_revision(row) for row in rows if isinstance(row, dict)]


async def get_current_project_goal_content(project_id: str) -> str | None:
    rows = await async_directus.get_items(
        "project_goal_revision",
        {
            "query": {
                "filter": {"project_id": {"_eq": project_id}},
                "fields": ["content"],
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        return None
    content = rows[0].get("content")
    if not isinstance(content, str) or not content.strip():
        return None
    return content.strip()
