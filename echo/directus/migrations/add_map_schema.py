#!/usr/bin/env python3
"""Idempotent Directus migration for Map: generated argument maps per project.

Creates three Map-owned collections with a CASCADE relation to `project`:

- `map_result`: one row per generation attempt. A ready row is a saved map
  revision; its manifest lists the arguments, their evidence and the
  embeddings they reference.
- `map_embedding`: one row per embedded statement per embedding configuration.
  The `embedding vector` column, its checks and the unique key are SQL-only
  (Directus does not model pgvector): run `add_map_vectors.sql` afterwards.
- `map_fact_check`: the fact-check state of one claim revision.

No policy grants: only the API reads and writes these rows, behind its own
project access checks.

Order, locally:

  python3 add_map_schema.py -u http://localhost:8055 -e admin@dembrane.com -p admin
  PGPASSWORD=dembrane psql -h localhost -U dembrane -d dembrane \
      -v ON_ERROR_STOP=1 -f add_map_vectors.sql
  cd echo/directus && bash sync.sh -u http://directus:8055 \
      -e admin@dembrane.com -p admin pull
"""

from __future__ import annotations

import sys
import argparse
from typing import Any

from add_smart_loop_phase0_schema import (
    Directus,
    login,
    m2o_field,
    relation,
    json_field,
    text_field,
    ensure_field,
    string_field,
    integer_field,
    ensure_relation,
    timestamp_field,
    ensure_collection,
)

RESULT = "map_result"
EMBEDDING = "map_embedding"
FACT_CHECK = "map_fact_check"


def _string(collection: str, field: str, *, sort: int, length: int, required: bool) -> dict:
    definition = string_field(collection, field, sort=sort, required=required)
    definition["schema"]["max_length"] = length
    return definition


def _project(collection: str) -> dict[str, Any]:
    return m2o_field(
        collection,
        "project_id",
        "project",
        sort=2,
        type_="uuid",
        data_type="uuid",
        required=True,
    )


def _created(collection: str, sort: int) -> dict[str, Any]:
    return timestamp_field(
        collection, "created_at", sort=sort, special=["date-created"], readonly=True
    )


def _updated(collection: str, sort: int) -> dict[str, Any]:
    return timestamp_field(
        collection, "updated_at", sort=sort, special=["date-updated"], readonly=True
    )


def result_fields() -> list[dict[str, Any]]:
    c = RESULT
    return [
        _project(c),
        _string(c, "status", sort=3, length=32, required=True),
        _string(c, "execution_ref", sort=4, length=128, required=False),
        _string(c, "source_fingerprint", sort=5, length=64, required=False),
        _string(c, "recipe_version", sort=6, length=64, required=True),
        json_field(c, "embedding_config", sort=7),
        json_field(c, "progress", sort=8),
        json_field(c, "manifest", sort=9),
        text_field(c, "error", sort=10),
        _string(c, "requested_by", sort=11, length=64, required=False),
        _created(c, 12),
        _updated(c, 13),
        timestamp_field(c, "completed_at", sort=14),
    ]


def embedding_fields() -> list[dict[str, Any]]:
    c = EMBEDDING
    return [
        _project(c),
        _string(c, "input_hash", sort=3, length=64, required=True),
        _string(c, "config_key", sort=4, length=64, required=True),
        _string(c, "model", sort=5, length=255, required=True),
        integer_field(c, "dims", sort=6, required=True),
        _created(c, 7),
    ]


def fact_check_fields() -> list[dict[str, Any]]:
    c = FACT_CHECK
    return [
        _project(c),
        _string(c, "claim_key", sort=3, length=64, required=True),
        text_field(c, "statement", sort=4, required=True),
        _string(c, "status", sort=5, length=32, required=True),
        integer_field(c, "attempt", sort=6, default_value=0, required=True),
        _string(c, "verdict", sort=7, length=32, required=False),
        text_field(c, "justification", sort=8),
        json_field(c, "sources", sort=9),
        text_field(c, "error", sort=10),
        _string(c, "model", sort=11, length=255, required=False),
        _string(c, "prompt_version", sort=12, length=128, required=False),
        _string(c, "requested_by", sort=13, length=64, required=False),
        timestamp_field(c, "started_at", sort=14),
        timestamp_field(c, "completed_at", sort=15),
        _created(c, 16),
        _updated(c, 17),
    ]


def ensure_map_schema(dx: Directus) -> None:
    for sort, (collection, fields) in enumerate(
        (
            (RESULT, result_fields()),
            (EMBEDDING, embedding_fields()),
            (FACT_CHECK, fact_check_fields()),
        ),
        start=50,
    ):
        ensure_collection(dx, collection, sort=sort)
        for definition in fields:
            ensure_field(dx, collection, definition)
        ensure_relation(
            dx,
            collection,
            "project_id",
            relation(collection, "project_id", "project", on_delete="CASCADE"),
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
        ensure_map_schema(Directus(args.url, token, dry_run=args.dry_run))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print("Directus metadata is ready. Next: add_map_vectors.sql, then pull the snapshot.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
