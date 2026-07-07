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
METHODOLOGY_VERSION_DETAIL_FIELDS = ["id", "note", "created_by", "created_at", "content"]


def _to_related_id(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("id")
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _methodology_card(
    row: dict[str, Any],
    latest_version: dict[str, Any] | None,
    versions_count: int = 0,
) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "description": row.get("description"),
        "framing": row.get("framing"),
        "is_seeded": bool(row.get("is_seeded")),
        "latest_version": latest_version,
        "versions_count": versions_count,
    }


def methodology_card(row: dict[str, Any], versions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    version_rows = versions or []
    latest_version = None
    if version_rows:
        latest_version = {field: version_rows[0].get(field) for field in METHODOLOGY_VERSION_FIELDS}
    return _methodology_card(row, latest_version, len(version_rows))


def methodology_detail(row: dict[str, Any], versions: list[dict[str, Any]]) -> dict[str, Any]:
    detail = methodology_card(row, versions)
    detail["versions"] = [
        {field: version.get(field) for field in METHODOLOGY_VERSION_DETAIL_FIELDS}
        for version in versions
        if isinstance(version, dict)
    ]
    return detail


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
                    "limit": -1,
                }
            },
        )
        version_rows = [version for version in versions if isinstance(version, dict)] if isinstance(versions, list) else []
        out.append(methodology_card(row, version_rows))
    return out
