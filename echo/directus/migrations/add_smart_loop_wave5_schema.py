#!/usr/bin/env python3
"""Idempotent migration for SMART loop Wave 5 goal/methodology schema.

Run against local Directus, then pull the snapshot:

  python3 add_smart_loop_wave5_schema.py \
      -u http://localhost:8055 -e admin@dembrane.com -p admin
  cd echo/directus && bash sync.sh -u http://localhost:8055 \
      -e admin@dembrane.com -p admin pull
"""

from __future__ import annotations

import sys
import uuid
import argparse
from typing import Any

from add_smart_loop_phase0_schema import (
    Directus,
    login,
    relation,
    uuid_pk,
    json_field,
    m2o_field,
    text_field,
    ensure_field,
    string_field,
    _field_base,
    ensure_schema,
    ensure_relation,
    ensure_collection,
    timestamp_field,
)

DEMBRANE_METHODOLOGY_CONTENT = {
    "opening_move": "interview the host toward a goal",
    "description": (
        "Figure out what this project is for before shaping reports or canvases. "
        "Use a short interview to turn the host's intent into a project goal, then "
        "let that goal steer the artifacts the project produces."
    ),
}


def bool_field(
    collection: str,
    field: str,
    *,
    sort: int,
    default_value: bool = False,
) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        "boolean",
        sort=sort,
        interface="boolean",
        data_type="boolean",
        default_value=default_value,
        is_nullable=True,
        width="half",
    )


def _items_query(filter_: str, fields: str = "*") -> str:
    return f"/items/{filter_}&fields={fields}&limit=1"


def _first_item(dx: Directus, path: str) -> dict[str, Any] | None:
    response = dx.get(path)
    rows = response.get("data")
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0]
    return None


def _create_item(dx: Directus, collection: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = dx.post(f"/items/{collection}", payload)
    row = response.get("data")
    return row if isinstance(row, dict) else {}


def ensure_wave5_schema(dx: Directus) -> None:
    print("Step 0/4: phase 0 dependencies")
    ensure_schema(dx)

    uuid_ref = {"type_": "uuid", "data_type": "uuid"}

    print("Step 1/4: collections")
    for sort, collection in enumerate(
        ("project_goal_revision", "methodology", "methodology_version"),
        start=30,
    ):
        ensure_collection(dx, collection, sort)
        ensure_field(dx, collection, uuid_pk(collection))

    print("Step 2/4: fields")
    fields_by_collection = {
        "project_goal_revision": [
            m2o_field("project_goal_revision", "project_id", "project", sort=2, **uuid_ref),
            text_field("project_goal_revision", "content", sort=3, required=True),
            string_field(
                "project_goal_revision",
                "set_by",
                sort=4,
                required=True,
                choices=["host-edit", "interview", "loop"],
            ),
            string_field("project_goal_revision", "chat_id", sort=5),
            string_field("project_goal_revision", "created_by", sort=6),
            timestamp_field("project_goal_revision", "created_at", sort=7, special=["date-created"]),
        ],
        "methodology": [
            string_field("methodology", "name", sort=2, required=True),
            text_field("methodology", "description", sort=3),
            text_field("methodology", "framing", sort=4),
            string_field("methodology", "owner_directus_user_id", sort=5),
            m2o_field("methodology", "workspace_id", "workspace", sort=6, **uuid_ref),
            string_field(
                "methodology",
                "visibility",
                sort=7,
                default_value="private",
                choices=["private", "workspace", "public"],
            ),
            bool_field("methodology", "is_seeded", sort=8, default_value=False),
            timestamp_field("methodology", "created_at", sort=9, special=["date-created"]),
            timestamp_field(
                "methodology",
                "updated_at",
                sort=10,
                special=["date-updated"],
                readonly=True,
            ),
        ],
        "methodology_version": [
            m2o_field("methodology_version", "methodology_id", "methodology", sort=2, **uuid_ref),
            json_field("methodology_version", "content", sort=3, required=True),
            string_field("methodology_version", "note", sort=4),
            string_field("methodology_version", "created_by", sort=5),
            timestamp_field("methodology_version", "created_at", sort=6, special=["date-created"]),
        ],
        "project": [
            m2o_field("project", "methodology_version_id", "methodology_version", sort=80, **uuid_ref)
        ],
    }
    for collection, fields in fields_by_collection.items():
        for field in fields:
            ensure_field(dx, collection, field)

    print("Step 3/4: relations")
    relation_specs = [
        ("project_goal_revision", "project_id", "project"),
        ("methodology", "workspace_id", "workspace"),
        ("methodology_version", "methodology_id", "methodology"),
        ("project", "methodology_version_id", "methodology_version"),
    ]
    for collection, field, related_collection in relation_specs:
        ensure_relation(dx, collection, field, relation(collection, field, related_collection))

    print("Step 4/4: seeded dembrane methodology")
    seed = _first_item(
        dx,
        _items_query(
            "methodology?filter[name][_eq]=dembrane&filter[is_seeded][_eq]=true",
            "id",
        ),
    )
    if seed:
        methodology_id = seed["id"]
        print("  seed methodology dembrane: exists, skipping")
    else:
        methodology_id = str(uuid.uuid4())
        print("  seed methodology dembrane: creating")
        _create_item(
            dx,
            "methodology",
            {
                "id": methodology_id,
                "name": "dembrane",
                "description": "The default dembrane setup methodology.",
                "framing": (
                    "Figure out what this project is for, then shape reports and "
                    "canvases around that goal."
                ),
                "visibility": "public",
                "is_seeded": True,
            },
        )

    version = _first_item(
        dx,
        _items_query(
            f"methodology_version?filter[methodology_id][_eq]={methodology_id}",
            "id",
        ),
    )
    if version:
        print("  seed methodology version: exists, skipping")
    else:
        print("  seed methodology version: creating")
        _create_item(
            dx,
            "methodology_version",
            {
                "id": str(uuid.uuid4()),
                "methodology_id": methodology_id,
                "content": DEMBRANE_METHODOLOGY_CONTENT,
                "note": "Seeded dembrane methodology v1",
            },
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-u", "--url", required=True)
    parser.add_argument("-e", "--email", required=True)
    parser.add_argument("-p", "--password", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        token = login(args.url, args.email, args.password)
        ensure_wave5_schema(Directus(args.url, token, dry_run=args.dry_run))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
