from __future__ import annotations

from copy import deepcopy
from typing import Any

from dembrane.directus import DirectusBadRequest


class InMemoryDirectus:
    def __init__(self) -> None:
        self._collections: dict[str, dict[str, dict[str, Any]]] = {
            "project_agentic_run": {},
            "project_agentic_run_event": {},
        }
        self._counters: dict[str, int] = {
            "project_agentic_run": 0,
            "project_agentic_run_event": 0,
        }

    def create_item(self, collection: str, item_data: dict[str, Any]) -> dict[str, Any]:
        if collection not in self._collections:
            self._collections[collection] = {}
            self._counters[collection] = 0

        record = deepcopy(item_data)
        if not record.get("id"):
            self._counters[collection] += 1
            record["id"] = f"{collection}-{self._counters[collection]}"

        self._collections[collection][record["id"]] = record
        return {"data": deepcopy(record)}

    def update_item(self, collection: str, item_id: str, item_data: dict[str, Any]) -> dict[str, Any]:
        table = self._collections.get(collection, {})
        if item_id not in table:
            raise DirectusBadRequest(f"Item not found: {collection}:{item_id}")

        table[item_id].update(deepcopy(item_data))
        return {"data": deepcopy(table[item_id])}

    def get_items(self, collection: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        query = (params or {}).get("query", {})
        rows = [deepcopy(row) for row in self._collections.get(collection, {}).values()]

        filter_dict = query.get("filter")
        if filter_dict:
            rows = [row for row in rows if self._match_filter(row, filter_dict)]

        sort = query.get("sort")
        if sort:
            reverse = sort.startswith("-")
            field = sort[1:] if reverse else sort
            rows.sort(key=lambda row: row.get(field), reverse=reverse)

        limit = query.get("limit")
        if isinstance(limit, int):
            rows = rows[:limit]

        return rows

    def delete_item(self, collection: str, item_id: str) -> None:
        table = self._collections.get(collection, {})
        if item_id not in table:
            raise DirectusBadRequest(f"Item not found: {collection}:{item_id}")
        del table[item_id]

    def _match_filter(self, row: dict[str, Any], filter_dict: dict[str, Any]) -> bool:
        for key, condition in filter_dict.items():
            value = row.get(key)

            if isinstance(condition, dict):
                for operator, expected in condition.items():
                    if operator == "_eq" and value != expected:
                        return False
                    if operator == "_gt" and (value is None or value <= expected):
                        return False
                    if operator == "_gte" and (value is None or value < expected):
                        return False
                    if operator == "_lt" and (value is None or value >= expected):
                        return False
                    if operator == "_lte" and (value is None or value > expected):
                        return False
                    if operator == "_in" and value not in expected:
                        return False
            else:
                if value != condition:
                    return False

        return True
