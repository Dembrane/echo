#!/usr/bin/env python3
"""Idempotent Directus migration for shared analysis objects and recipe runs.

Creates ten collections, each with a CASCADE relation to `project`:

- `analysis_scope`: one producer scope (a recipe over a declared input scope)
  or one view scope. Holds the next request order, the current ready run or
  snapshot, the publication sequence and the writer fence. Its row is the lock
  every publication takes.
- `analysis_run`: one execution of a recipe version, with its pinned inputs,
  parameters, lease, request order, status and immutable output manifest.
- `analysis_step`: one step of a run: cache key, checkpoint, actual model or
  deterministic output, validation outcomes and usage.
- `analysis_object`: a stable, project-scoped identity of one type, with its
  producer lineage key and the current revision pointer.
- `analysis_object_revision`: an immutable statement of an object's content,
  attributes and provenance.
- `analysis_relation`: a typed relation between two exact revisions.
- `analysis_snapshot`: an immutable view manifest.
- `analysis_outbox`: a publication event, inserted in the publication
  transaction and dispatched afterwards.
- `analysis_last_opened`: one row per host per project, holding when that host
  last opened the results list. Nothing else is per host.
- `analysis_request_key`: every idempotency key a request was accepted under,
  mapped to the run that answers it (a key that joined equivalent work in
  flight, or retried a failed run, keeps returning that run).

It also adds `manifest_version` and `snapshot_id` to `map_result`.

Unique keys, composite and partial indexes, CHECK constraints and the
same-project triggers are SQL-only: run `add_analysis_constraints.sql`
afterwards. No policy grants: only the API reads and writes these rows,
behind its own project access checks.

Order, locally:

  python3 add_analysis_schema.py -u http://localhost:8055 -e admin@dembrane.com -p admin
  PGPASSWORD=dembrane psql -h localhost -U dembrane -d dembrane \
      -v ON_ERROR_STOP=1 -f add_analysis_constraints.sql
  cd echo/directus && bash sync.sh -u http://directus:8055 \
      -e admin@dembrane.com -p admin pull
"""

from __future__ import annotations

import sys
import time
import argparse
from typing import Any

from add_smart_loop_phase0_schema import (
    Directus,
    login,
    _field_base,
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

SCOPE = "analysis_scope"
RUN = "analysis_run"
STEP = "analysis_step"
OBJECT = "analysis_object"
REVISION = "analysis_object_revision"
RELATION = "analysis_relation"
SNAPSHOT = "analysis_snapshot"
OUTBOX = "analysis_outbox"
REQUEST_KEY = "analysis_request_key"
LAST_OPENED = "analysis_last_opened"
MAP_RESULT = "map_result"

COLLECTIONS = (
    SCOPE, RUN, STEP, OBJECT, REVISION, RELATION, SNAPSHOT, OUTBOX, REQUEST_KEY, LAST_OPENED,
)  # fmt: skip


def _string(
    collection: str,
    field: str,
    *,
    sort: int,
    length: int,
    required: bool,
    default: str | None = None,
) -> dict[str, Any]:
    definition = string_field(collection, field, sort=sort, required=required, default_value=default)
    definition["schema"]["max_length"] = length
    return definition


def _uuid_ref(collection: str, field: str, related: str, *, sort: int, required: bool) -> dict[str, Any]:
    return m2o_field(
        collection,
        field,
        related,
        sort=sort,
        type_="uuid",
        data_type="uuid",
        required=required,
    )


def _project(collection: str) -> dict[str, Any]:
    return _uuid_ref(collection, "project_id", "project", sort=2, required=True)


def _counter(collection: str, field: str, *, sort: int, default: int) -> dict[str, Any]:
    return integer_field(collection, field, sort=sort, default_value=default, required=True)


def _hash(collection: str, field: str, *, sort: int, required: bool) -> dict[str, Any]:
    return _string(collection, field, sort=sort, length=64, required=required)


def _hash_version(collection: str, sort: int) -> dict[str, Any]:
    return _string(collection, "hash_version", sort=sort, length=16, required=True, default="c14n-v1")


def _created(collection: str, sort: int) -> dict[str, Any]:
    return timestamp_field(
        collection, "created_at", sort=sort, special=["date-created"], readonly=True
    )


def _updated(collection: str, sort: int) -> dict[str, Any]:
    return timestamp_field(
        collection, "updated_at", sort=sort, special=["date-updated"], readonly=True
    )


def scope_fields() -> list[dict[str, Any]]:
    c = SCOPE
    return [
        _project(c),
        _string(c, "kind", sort=3, length=16, required=True),
        _string(c, "recipe_id", sort=4, length=128, required=False),
        _string(c, "view_id", sort=5, length=128, required=False),
        _string(c, "scope_key", sort=6, length=255, required=True),
        _counter(c, "next_request_order", sort=7, default=1),
        _counter(c, "generation_epoch", sort=8, default=0),
        _counter(c, "publication_sequence", sort=9, default=0),
        _uuid_ref(c, "current_run_id", RUN, sort=10, required=False),
        integer_field(c, "current_request_order", sort=11),
        _uuid_ref(c, "current_snapshot_id", SNAPSHOT, sort=12, required=False),
        _string(c, "writer", sort=13, length=16, required=True, default="analysis"),
        _counter(c, "writer_fence", sort=14, default=0),
        _created(c, 15),
        _updated(c, 16),
    ]


def run_fields() -> list[dict[str, Any]]:
    c = RUN
    return [
        _project(c),
        _uuid_ref(c, "scope_id", SCOPE, sort=3, required=True),
        _string(c, "recipe_id", sort=4, length=128, required=True),
        _string(c, "recipe_version", sort=5, length=64, required=True),
        json_field(c, "definition", sort=6, required=True),
        _string(c, "mode", sort=7, length=16, required=True),
        _counter(c, "epoch", sort=8, default=0),
        _string(c, "idempotency_key", sort=9, length=255, required=True),
        integer_field(c, "request_order", sort=10, required=True),
        _hash(c, "request_fingerprint", sort=11, required=True),
        _hash(c, "input_fingerprint", sort=12, required=False),
        _hash_version(c, 13),
        json_field(c, "input_manifest", sort=14),
        json_field(c, "parameters", sort=15),
        json_field(c, "context", sort=16),
        json_field(c, "depends_on", sort=17),
        _string(c, "status", sort=18, length=32, required=True),
        json_field(c, "progress", sort=19),
        _string(c, "lease", sort=20, length=64, required=False),
        _counter(c, "attempt", sort=21, default=0),
        _string(c, "execution_ref", sort=22, length=128, required=False),
        json_field(c, "output_manifest", sort=23),
        json_field(c, "checks", sort=24),
        json_field(c, "metrics", sort=25),
        text_field(c, "error", sort=26),
        _uuid_ref(c, "reused_run_id", RUN, sort=27, required=False),
        _string(c, "requested_by", sort=28, length=64, required=False),
        _created(c, 29),
        _updated(c, 30),
        timestamp_field(c, "started_at", sort=31),
        timestamp_field(c, "completed_at", sort=32),
        # The scope's writer fence when the run was accepted; publication and
        # every checkpoint require the scope to still be at it.
        _counter(c, "writer_fence", sort=33, default=0),
        # The lease is this worker's only until then; every checkpoint extends it.
        timestamp_field(c, "lease_expires_at", sort=34),
    ]


def step_fields() -> list[dict[str, Any]]:
    c = STEP
    return [
        _project(c),
        _uuid_ref(c, "run_id", RUN, sort=3, required=True),
        _string(c, "step_key", sort=4, length=128, required=True),
        _string(c, "step_version", sort=5, length=64, required=True),
        _string(c, "kind", sort=6, length=16, required=True),
        _hash(c, "cache_key", sort=7, required=True),
        _hash_version(c, 8),
        _string(c, "status", sort=9, length=16, required=True),
        _counter(c, "attempt", sort=10, default=1),
        _string(c, "lease", sort=11, length=64, required=False),
        _uuid_ref(c, "reused_step_id", STEP, sort=12, required=False),
        json_field(c, "checkpoint", sort=13),
        json_field(c, "output", sort=14),
        json_field(c, "validation", sort=15),
        json_field(c, "usage", sort=16),
        text_field(c, "error", sort=17),
        _created(c, 18),
        _updated(c, 19),
        timestamp_field(c, "completed_at", sort=20),
    ]


def object_fields() -> list[dict[str, Any]]:
    c = OBJECT
    return [
        _project(c),
        _string(c, "type", sort=3, length=64, required=True),
        _string(c, "lineage_key", sort=4, length=255, required=True),
        _uuid_ref(c, "scope_id", SCOPE, sort=5, required=False),
        _uuid_ref(c, "current_revision_id", REVISION, sort=6, required=False),
        _counter(c, "revision_count", sort=7, default=0),
        _created(c, 8),
        _updated(c, 9),
    ]


def revision_fields() -> list[dict[str, Any]]:
    c = REVISION
    return [
        _project(c),
        _uuid_ref(c, "object_id", OBJECT, sort=3, required=True),
        integer_field(c, "revision_number", sort=4, required=True),
        _string(c, "type", sort=5, length=64, required=True),
        integer_field(c, "schema_version", sort=6, required=True),
        _string(c, "status", sort=7, length=16, required=True),
        _string(c, "origin", sort=8, length=16, required=True),
        json_field(c, "payload", sort=9, required=True),
        json_field(c, "attributes", sort=10),
        json_field(c, "provenance", sort=11, required=True),
        _hash(c, "content_hash", sort=12, required=True),
        _hash_version(c, 13),
        _uuid_ref(c, "run_id", RUN, sort=14, required=False),
        _uuid_ref(c, "parent_revision_id", REVISION, sort=15, required=False),
        json_field(c, "embedding_refs", sort=16),
        _string(c, "actor_id", sort=17, length=64, required=False),
        text_field(c, "reason", sort=18),
        _created(c, 19),
        timestamp_field(c, "published_at", sort=20),
        # What the host said they changed: typo, clarity, meaning, withdraw,
        # restore, rollback. Null on generated revisions and on everything
        # written before the audit trail asked; nothing is backfilled.
        _string(c, "change_kind", sort=21, length=16, required=False),
    ]


def last_opened_fields() -> list[dict[str, Any]]:
    """One row per host per project: when they last opened the results list.
    The host's own state, so `what is new since I last looked` has an answer
    that survives a new browser. No row means a first visit, and then nothing
    is new."""
    c = LAST_OPENED
    return [
        _project(c),
        _string(c, "user_id", sort=3, length=64, required=True),
        timestamp_field(c, "opened_at", sort=4),
    ]


def relation_fields() -> list[dict[str, Any]]:
    c = RELATION
    return [
        _project(c),
        _string(c, "type", sort=3, length=64, required=True),
        _string(c, "basis", sort=4, length=16, required=True),
        _string(c, "status", sort=5, length=16, required=True),
        _uuid_ref(c, "from_revision_id", REVISION, sort=6, required=True),
        _uuid_ref(c, "to_revision_id", REVISION, sort=7, required=True),
        _uuid_ref(c, "from_object_id", OBJECT, sort=8, required=True),
        _uuid_ref(c, "to_object_id", OBJECT, sort=9, required=True),
        json_field(c, "attributes", sort=10),
        json_field(c, "provenance", sort=11),
        _hash(c, "content_hash", sort=12, required=True),
        _hash_version(c, 13),
        _uuid_ref(c, "run_id", RUN, sort=14, required=False),
        _created(c, 15),
        timestamp_field(c, "published_at", sort=16),
    ]


def snapshot_fields() -> list[dict[str, Any]]:
    c = SNAPSHOT
    return [
        _project(c),
        _uuid_ref(c, "scope_id", SCOPE, sort=3, required=True),
        _uuid_ref(c, "parent_snapshot_id", SNAPSHOT, sort=4, required=False),
        _string(c, "view_id", sort=5, length=128, required=True),
        _counter(c, "manifest_version", sort=6, default=1),
        json_field(c, "manifest", sort=7, required=True),
        json_field(c, "settings", sort=8),
        json_field(c, "versions", sort=9),
        json_field(c, "embedding_config", sort=10),
        _hash(c, "content_hash", sort=11, required=True),
        _hash_version(c, 12),
        _string(c, "created_by", sort=13, length=64, required=False),
        _created(c, 14),
        # The outbox event whose consumer assembled this snapshot: a durable,
        # unique record of that effect, so a repeated dispatch finds it.
        _field_base(c, "source_event_id", "uuid", sort=15, data_type="uuid"),
    ]


def request_key_fields() -> list[dict[str, Any]]:
    c = REQUEST_KEY
    return [
        _project(c),
        _string(c, "idempotency_key", sort=3, length=255, required=True),
        _uuid_ref(c, "run_id", RUN, sort=4, required=True),
        _uuid_ref(c, "scope_id", SCOPE, sort=5, required=True),
        _string(c, "mode", sort=6, length=16, required=True),
        _created(c, 7),
    ]


def outbox_fields() -> list[dict[str, Any]]:
    c = OUTBOX
    return [
        _project(c),
        _uuid_ref(c, "scope_id", SCOPE, sort=3, required=True),
        integer_field(c, "sequence", sort=4, required=True),
        _string(c, "event_type", sort=5, length=64, required=True),
        _uuid_ref(c, "run_id", RUN, sort=6, required=False),
        _uuid_ref(c, "snapshot_id", SNAPSHOT, sort=7, required=False),
        json_field(c, "payload", sort=8),
        _string(c, "status", sort=9, length=16, required=True, default="pending"),
        _counter(c, "attempts", sort=10, default=0),
        _string(c, "claim", sort=11, length=64, required=False),
        timestamp_field(c, "next_attempt_at", sort=12),
        json_field(c, "consumers", sort=13),
        text_field(c, "last_error", sort=14),
        _created(c, 15),
        _updated(c, 16),
        timestamp_field(c, "delivered_at", sort=17),
    ]


def map_result_fields() -> list[dict[str, Any]]:
    c = MAP_RESULT
    return [
        _counter(c, "manifest_version", sort=15, default=1),
        _uuid_ref(c, "snapshot_id", SNAPSHOT, sort=16, required=False),
    ]


# (collection, field, related collection, on delete)
RELATIONS: tuple[tuple[str, str, str, str], ...] = (
    *((collection, "project_id", "project", "CASCADE") for collection in COLLECTIONS),
    (SCOPE, "current_run_id", RUN, "SET NULL"),
    (SCOPE, "current_snapshot_id", SNAPSHOT, "SET NULL"),
    (RUN, "scope_id", SCOPE, "CASCADE"),
    (RUN, "reused_run_id", RUN, "SET NULL"),
    (STEP, "run_id", RUN, "CASCADE"),
    (STEP, "reused_step_id", STEP, "SET NULL"),
    (OBJECT, "scope_id", SCOPE, "SET NULL"),
    (OBJECT, "current_revision_id", REVISION, "SET NULL"),
    (REVISION, "object_id", OBJECT, "CASCADE"),
    (REVISION, "run_id", RUN, "SET NULL"),
    (REVISION, "parent_revision_id", REVISION, "SET NULL"),
    (RELATION, "from_revision_id", REVISION, "CASCADE"),
    (RELATION, "to_revision_id", REVISION, "CASCADE"),
    (RELATION, "from_object_id", OBJECT, "CASCADE"),
    (RELATION, "to_object_id", OBJECT, "CASCADE"),
    (RELATION, "run_id", RUN, "SET NULL"),
    (SNAPSHOT, "scope_id", SCOPE, "CASCADE"),
    (SNAPSHOT, "parent_snapshot_id", SNAPSHOT, "SET NULL"),
    (OUTBOX, "scope_id", SCOPE, "CASCADE"),
    (OUTBOX, "run_id", RUN, "SET NULL"),
    (OUTBOX, "snapshot_id", SNAPSHOT, "SET NULL"),
    (REQUEST_KEY, "run_id", RUN, "CASCADE"),
    (REQUEST_KEY, "scope_id", SCOPE, "CASCADE"),
    (MAP_RESULT, "snapshot_id", SNAPSHOT, "SET NULL"),
)


def _patient(dx: Directus, attempts: int = 8) -> Directus:
    """Retry a request Directus refused with 503 ("under pressure"): creating a
    field alters a table, and a burst of them trips its pressure limiter."""
    original = dx._request

    def request(method: str, path: str, body: dict[str, Any] | None = None) -> dict:
        for attempt in range(attempts):
            try:
                return original(method, path, body)
            except RuntimeError as exc:
                if "-> 503" not in str(exc) or attempt == attempts - 1:
                    raise
                time.sleep(2 * (attempt + 1))
        raise AssertionError("unreachable")

    dx._request = request  # type: ignore[method-assign]
    return dx


def ensure_analysis_schema(dx: Directus) -> None:
    dx = _patient(dx)
    fields_by_collection = {
        SCOPE: scope_fields(),
        RUN: run_fields(),
        STEP: step_fields(),
        OBJECT: object_fields(),
        REVISION: revision_fields(),
        RELATION: relation_fields(),
        SNAPSHOT: snapshot_fields(),
        OUTBOX: outbox_fields(),
        REQUEST_KEY: request_key_fields(),
        LAST_OPENED: last_opened_fields(),
    }
    # Collections first: the tables reference each other in a cycle (a scope
    # points at its current run, a run at its scope), so every table exists
    # before any field or foreign key names another.
    print("Step 1/3: collections")
    for sort, collection in enumerate(COLLECTIONS, start=60):
        ensure_collection(dx, collection, sort=sort)
    print("Step 2/3: fields")
    for collection, fields in fields_by_collection.items():
        for definition in fields:
            ensure_field(dx, collection, definition)
    for definition in map_result_fields():
        ensure_field(dx, MAP_RESULT, definition)
    print("Step 3/3: relations")
    for collection, field, related, on_delete in RELATIONS:
        ensure_relation(
            dx, collection, field, relation(collection, field, related, on_delete=on_delete)
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
        ensure_analysis_schema(Directus(args.url, token, dry_run=args.dry_run))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print("Directus metadata is ready. Next: add_analysis_constraints.sql, then pull the snapshot.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
