"""
Create user_project_pin junction table for per-user project pinning.

Currently pin_order is a global field on the project row — when one user pins
a project, it's pinned for EVERYONE in the workspace. This is wrong for
multi-user workspaces.

After this migration:
- pin_order on project row is deprecated (keep for backward compat)
- user_project_pin junction table stores per-user pins
- Endpoints read/write this table instead

Run once: python scripts/create_user_pin_schema.py
"""

import sys
import os

# Add server to path so we can import dembrane
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from dembrane.directus import DirectusClient
from dembrane.settings import get_settings

settings = get_settings()
client = DirectusClient(
    base_url=settings.directus.base_url,
    token=settings.directus.token,
)


def collection_exists(name: str) -> bool:
    try:
        result = client._request("GET", f"/collections/{name}")
        return bool(result.get("data"))
    except Exception:
        return False


def field_exists(collection: str, field: str) -> bool:
    try:
        result = client._request("GET", f"/fields/{collection}/{field}")
        return bool(result.get("data"))
    except Exception:
        return False


def main():
    print("Creating user_project_pin junction table...")

    if collection_exists("user_project_pin"):
        print("  ⚠ Collection already exists, skipping creation")
    else:
        # Create collection
        client._request("POST", "/collections", json={
            "collection": "user_project_pin",
            "meta": {
                "collection": "user_project_pin",
                "icon": "push_pin",
                "note": "Per-user project pinning — prevents collision in multi-user workspaces",
                "singleton": False,
                "hidden": False,
            },
            "schema": {"name": "user_project_pin"},
            "fields": [
                {
                    "field": "id",
                    "type": "uuid",
                    "meta": {"interface": "input", "readonly": True, "hidden": True, "special": ["uuid"]},
                    "schema": {"is_primary_key": True, "has_auto_increment": False, "default_value": None},
                },
                {
                    "field": "user_id",
                    "type": "uuid",
                    "meta": {
                        "interface": "select-dropdown-m2o",
                        "special": ["m2o"],
                        "options": {"template": "{{display_name}}"},
                    },
                    "schema": {"is_nullable": False},
                },
                {
                    "field": "project_id",
                    "type": "uuid",
                    "meta": {
                        "interface": "select-dropdown-m2o",
                        "special": ["m2o"],
                        "options": {"template": "{{name}}"},
                    },
                    "schema": {"is_nullable": False},
                },
                {
                    "field": "workspace_id",
                    "type": "uuid",
                    "meta": {
                        "interface": "select-dropdown-m2o",
                        "special": ["m2o"],
                        "note": "Denormalized for fast scoped queries",
                    },
                    "schema": {"is_nullable": True},
                },
                {
                    "field": "pin_order",
                    "type": "integer",
                    "meta": {
                        "interface": "input",
                        "note": "1, 2, or 3 — display order of pinned projects",
                    },
                    "schema": {"is_nullable": False, "default_value": 1},
                },
                {
                    "field": "created_at",
                    "type": "timestamp",
                    "meta": {
                        "interface": "datetime",
                        "readonly": True,
                        "hidden": True,
                        "special": ["date-created"],
                    },
                    "schema": {"is_nullable": False},
                },
            ],
        })
        print("  ✓ Collection created")

    # Create relations
    for field, related, field_name in [
        ("user_id", "app_user", "pins"),
        ("project_id", "project", "user_pins"),
        ("workspace_id", "workspace", None),
    ]:
        try:
            client._request("POST", "/relations", json={
                "collection": "user_project_pin",
                "field": field,
                "related_collection": related,
                "meta": {
                    "one_field": field_name,
                    "sort_field": None,
                    "one_deselect_action": "nullify",
                },
                "schema": {
                    "on_delete": "CASCADE" if field != "workspace_id" else "SET NULL",
                },
            })
            print(f"  ✓ Relation {field} → {related}")
        except Exception as e:
            if "already exists" in str(e).lower() or "duplicate" in str(e).lower():
                print(f"  ⚠ Relation {field} → {related} already exists")
            else:
                print(f"  ✗ Relation {field} → {related} failed: {e}")

    print("\nDone. Run Directus sync to snapshot the schema:")
    print("  cd directus && bash sync.sh -u http://directus:8055 -e admin@dembrane.com -p admin pull")


if __name__ == "__main__":
    main()
