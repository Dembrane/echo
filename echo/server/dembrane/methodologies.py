from __future__ import annotations

from typing import Any

from dembrane.directus_async import async_directus

METHODOLOGY_FIELDS = [
    "id",
    "name",
    "description",
    "framing",
    "owner_directus_user_id",
    "workspace_id",
    "visibility",
    "is_seeded",
]
METHODOLOGY_VERSION_FIELDS = ["id", "note", "created_at"]


def _to_related_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _methodology_card(row: dict[str, Any], latest_version: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "description": row.get("description"),
        "framing": row.get("framing"),
        "is_seeded": bool(row.get("is_seeded")),
        "latest_version": latest_version,
    }


async def list_visible_methodologies(
    *,
    workspace_id: str,
    directus_user_id: str,
) -> list[dict[str, Any]]:
    rows = await async_directus.get_items(
        "methodology",
        {
            "query": {
                "filter": {
                    "_or": [
                        {"visibility": {"_eq": "public"}},
                        {
                            "_and": [
                                {"visibility": {"_eq": "workspace"}},
                                {"workspace_id": {"_eq": workspace_id}},
                            ]
                        },
                        {"owner_directus_user_id": {"_eq": directus_user_id}},
                    ]
                },
                "fields": METHODOLOGY_FIELDS,
                "sort": ["is_seeded", "name"],
                "limit": -1,
            }
        },
    )
    methodology_rows = rows if isinstance(rows, list) else []

    out: list[dict[str, Any]] = []
    for row in methodology_rows:
        if not isinstance(row, dict):
            continue
        methodology_id = _to_related_id(row.get("id"))
        if methodology_id is None:
            continue
        versions = await async_directus.get_items(
            "methodology_version",
            {
                "query": {
                    "filter": {"methodology_id": {"_eq": methodology_id}},
                    "fields": METHODOLOGY_VERSION_FIELDS,
                    "sort": ["-created_at"],
                    "limit": 1,
                }
            },
        )
        latest_version = None
        if isinstance(versions, list) and versions and isinstance(versions[0], dict):
            latest_version = {
                field: versions[0].get(field) for field in METHODOLOGY_VERSION_FIELDS
            }
        out.append(_methodology_card(row, latest_version))
    return out
