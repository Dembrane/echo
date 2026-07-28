#!/usr/bin/env python3
"""Idempotent migration for SMART loop phase 0 schema.

Run against local Directus, then pull the snapshot:

  python3 add_smart_loop_phase0_schema.py \
      -u http://localhost:8055 -e admin@dembrane.com -p admin
  cd echo/directus && bash sync.sh -u http://localhost:8055 \
      -e admin@dembrane.com -p admin pull
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class Directus:
    def __init__(self, base_url: str, token: str, dry_run: bool = False) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.dry_run = dry_run

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8")
            raise RuntimeError(f"{method} {path} -> {exc.code}: {detail}") from None

    def get(self, path: str) -> dict:
        return self._request("GET", path)

    def post(self, path: str, body: dict[str, Any]) -> dict:
        if self.dry_run:
            print(f"    [dry-run] POST {path}")
            return {}
        return self._request("POST", path, body)

    def collection_exists(self, collection: str) -> bool:
        try:
            self.get(f"/collections/{urllib.parse.quote(collection)}")
            return True
        except RuntimeError:
            return False

    def field_exists(self, collection: str, field: str) -> bool:
        try:
            self.get(
                f"/fields/{urllib.parse.quote(collection)}/{urllib.parse.quote(field)}"
            )
            return True
        except RuntimeError:
            return False

    def relation_exists(self, collection: str, field: str) -> bool:
        try:
            response = self.get(
                f"/relations/{urllib.parse.quote(collection)}/{urllib.parse.quote(field)}"
            )
            return bool(response.get("data"))
        except RuntimeError:
            return False


def login(base_url: str, email: str, password: str) -> str:
    url = f"{base_url.rstrip('/')}/auth/login"
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))["data"]["access_token"]


def _field_base(
    collection: str,
    field: str,
    type_: str,
    *,
    sort: int,
    interface: str = "input",
    required: bool = False,
    hidden: bool = False,
    readonly: bool = False,
    special: list[str] | None = None,
    options: dict[str, Any] | None = None,
    display: str | None = None,
    display_options: dict[str, Any] | None = None,
    data_type: str | None = None,
    default_value: Any = None,
    is_nullable: bool = True,
    is_unique: bool = False,
    is_primary_key: bool = False,
    max_length: int | None = None,
    width: str = "full",
) -> dict[str, Any]:
    return {
        "collection": collection,
        "field": field,
        "type": type_,
        "meta": {
            "collection": collection,
            "field": field,
            "hidden": hidden,
            "interface": interface,
            "readonly": readonly,
            "required": required,
            "searchable": True,
            "sort": sort,
            "special": special,
            "options": options,
            "display": display,
            "display_options": display_options,
            "width": width,
        },
        "schema": {
            "name": field,
            "table": collection,
            "data_type": data_type,
            "default_value": default_value,
            "max_length": max_length,
            "is_nullable": is_nullable,
            "is_unique": is_unique,
            "is_primary_key": is_primary_key,
            "is_generated": False,
            "has_auto_increment": False,
        },
    }


def uuid_pk(collection: str) -> dict[str, Any]:
    return _field_base(
        collection,
        "id",
        "uuid",
        sort=1,
        hidden=True,
        readonly=True,
        special=["uuid"],
        data_type="uuid",
        is_nullable=False,
        is_unique=True,
        is_primary_key=True,
    )


def string_field(
    collection: str,
    field: str,
    *,
    sort: int,
    required: bool = False,
    default_value: str | None = None,
    choices: list[str] | None = None,
) -> dict[str, Any]:
    options = None
    if choices is not None:
        options = {"choices": [{"text": value, "value": value} for value in choices]}
    return _field_base(
        collection,
        field,
        "string",
        sort=sort,
        interface="select-dropdown" if choices else "input",
        required=required,
        options=options,
        data_type="character varying",
        default_value=default_value,
        is_nullable=not required,
        max_length=255,
    )


def text_field(collection: str, field: str, *, sort: int, required: bool = False) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        "text",
        sort=sort,
        interface="input-multiline",
        required=required,
        data_type="text",
        is_nullable=not required,
    )


def json_field(collection: str, field: str, *, sort: int, required: bool = False) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        "json",
        sort=sort,
        interface="input-code",
        required=required,
        special=["cast-json"],
        options={"language": "json"},
        data_type="json",
        is_nullable=not required,
    )


def integer_field(
    collection: str,
    field: str,
    *,
    sort: int,
    default_value: int | None = None,
    required: bool = False,
) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        "integer",
        sort=sort,
        interface="input",
        required=required,
        data_type="integer",
        default_value=default_value,
        is_nullable=not required,
    )


def timestamp_field(
    collection: str,
    field: str,
    *,
    sort: int,
    required: bool = False,
    special: list[str] | None = None,
    readonly: bool = False,
) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        "timestamp",
        sort=sort,
        interface="datetime",
        display="datetime",
        display_options={"relative": True},
        required=required,
        readonly=readonly,
        special=special,
        data_type="timestamp with time zone",
        is_nullable=not required,
        width="half",
    )


def m2o_field(
    collection: str,
    field: str,
    related_collection: str,
    *,
    sort: int,
    data_type: str,
    type_: str,
    required: bool = False,
) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        type_,
        sort=sort,
        interface="select-dropdown-m2o",
        required=required,
        special=["m2o"],
        data_type=data_type,
        is_nullable=not required,
    ) | {
        "schema": {
            **_field_base(
                collection,
                field,
                type_,
                sort=sort,
                data_type=data_type,
                is_nullable=not required,
            )["schema"],
            "foreign_key_table": related_collection,
            "foreign_key_column": "id",
        }
    }


def relation(
    collection: str,
    field: str,
    related_collection: str,
    *,
    on_delete: str = "SET NULL",
) -> dict[str, Any]:
    return {
        "collection": collection,
        "field": field,
        "related_collection": related_collection,
        "meta": {
            "many_collection": collection,
            "many_field": field,
            "one_collection": related_collection,
            "one_field": None,
            "one_deselect_action": "nullify",
            "junction_field": None,
            "sort_field": None,
        },
        "schema": {
            "table": collection,
            "column": field,
            "foreign_key_table": related_collection,
            "foreign_key_column": "id",
            "on_update": "NO ACTION",
            "on_delete": on_delete,
        },
    }


def ensure_collection(dx: Directus, collection: str, sort: int) -> None:
    if dx.collection_exists(collection):
        print(f"  collection {collection}: exists, skipping")
        return
    print(f"  collection {collection}: creating")
    dx.post(
        "/collections",
        {
            "collection": collection,
            "meta": {
                "collection": collection,
                "accountability": "all",
                "archive_app_filter": True,
                "collapse": "open",
                "hidden": False,
                "singleton": False,
                "sort": sort,
                "versioning": False,
            },
            "schema": {"name": collection},
            "fields": [uuid_pk(collection)],
        },
    )


def ensure_field(dx: Directus, collection: str, field: dict[str, Any]) -> None:
    field_name = field["field"]
    if dx.field_exists(collection, field_name):
        print(f"  field {collection}.{field_name}: exists, skipping")
        return
    print(f"  field {collection}.{field_name}: creating")
    dx.post(f"/fields/{collection}", field)


def ensure_relation(dx: Directus, collection: str, field: str, payload: dict[str, Any]) -> None:
    if dx.relation_exists(collection, field):
        print(f"  relation {collection}.{field}: exists, skipping")
        return
    print(f"  relation {collection}.{field}: creating")
    dx.post("/relations", payload)


def ensure_schema(dx: Directus) -> None:
    print("Step 1/5: project_report.kind")
    ensure_field(
        dx,
        "project_report",
        string_field(
            "project_report",
            "kind",
            sort=20,
            required=True,
            default_value="report",
            choices=["report", "canvas"],
        ),
    )

    print("Step 2/5: reach-back columns")
    for collection in ("support_request", "usage_insight"):
        for sort, field in enumerate(("chat_id", "app_user_id", "message_id"), start=20):
            ensure_field(dx, collection, string_field(collection, field, sort=sort))

    print("Step 3/5: canvas collections")
    for sort, collection in enumerate(
        ("canvas_config_revision", "canvas_generation", "agent_loop", "agent_loop_run"),
        start=20,
    ):
        ensure_collection(dx, collection, sort)
        ensure_field(dx, collection, uuid_pk(collection))

    print("Step 4/5: canvas fields")
    project_report_id = {"type_": "bigInteger", "data_type": "bigint"}
    uuid_ref = {"type_": "uuid", "data_type": "uuid"}

    fields_by_collection = {
        "canvas_config_revision": [
            m2o_field("canvas_config_revision", "report_id", "project_report", sort=2, **project_report_id),
            text_field("canvas_config_revision", "brief", sort=3),
            json_field("canvas_config_revision", "gather_spec", sort=4),
            integer_field("canvas_config_revision", "cadence_minutes", sort=5, default_value=5),
            string_field("canvas_config_revision", "created_by", sort=6),
            string_field("canvas_config_revision", "note", sort=7),
            timestamp_field("canvas_config_revision", "created_at", sort=8, special=["date-created"]),
        ],
        "canvas_generation": [
            m2o_field("canvas_generation", "report_id", "project_report", sort=2, **project_report_id),
            m2o_field("canvas_generation", "config_revision_id", "canvas_config_revision", sort=3, **uuid_ref),
            text_field("canvas_generation", "content_html", sort=4),
            string_field(
                "canvas_generation",
                "status",
                sort=5,
                default_value="ok",
                choices=["ok", "no_op", "error"],
            ),
            string_field(
                "canvas_generation",
                "tick_kind",
                sort=6,
                choices=["scheduled", "manual", "preview"],
            ),
            text_field("canvas_generation", "detail", sort=7),
            timestamp_field("canvas_generation", "created_at", sort=8, special=["date-created"]),
        ],
        "agent_loop": [
            m2o_field("agent_loop", "project_id", "project", sort=2, **uuid_ref),
            m2o_field("agent_loop", "report_id", "project_report", sort=3, **project_report_id),
            string_field("agent_loop", "name", sort=4),
            string_field(
                "agent_loop",
                "status",
                sort=5,
                default_value="active",
                choices=["active", "paused", "expired", "stopped"],
            ),
            timestamp_field("agent_loop", "expires_at", sort=6, required=True),
            integer_field("agent_loop", "cadence_minutes", sort=7, default_value=5),
            string_field("agent_loop", "acting_directus_user_id", sort=8),
            string_field("agent_loop", "chat_id", sort=9),
            string_field("agent_loop", "created_from_chat_id", sort=10),
            integer_field("agent_loop", "failure_count", sort=11, default_value=0),
            json_field("agent_loop", "caps", sort=12),
            timestamp_field("agent_loop", "created_at", sort=13, special=["date-created"]),
            timestamp_field("agent_loop", "updated_at", sort=14, special=["date-updated"], readonly=True),
        ],
        "agent_loop_run": [
            m2o_field("agent_loop_run", "loop_id", "agent_loop", sort=2, **uuid_ref),
            string_field("agent_loop_run", "status", sort=3, choices=["ok", "no_op", "error"]),
            text_field("agent_loop_run", "detail", sort=4),
            m2o_field("agent_loop_run", "generation_id", "canvas_generation", sort=5, **uuid_ref),
            timestamp_field("agent_loop_run", "started_at", sort=6),
            timestamp_field("agent_loop_run", "finished_at", sort=7),
        ],
    }
    for collection, fields in fields_by_collection.items():
        for field in fields:
            ensure_field(dx, collection, field)

    print("Step 5/5: canvas relations")
    relation_specs = [
        ("canvas_config_revision", "report_id", "project_report"),
        ("canvas_generation", "report_id", "project_report"),
        ("canvas_generation", "config_revision_id", "canvas_config_revision"),
        ("agent_loop", "project_id", "project"),
        ("agent_loop", "report_id", "project_report"),
        ("agent_loop_run", "loop_id", "agent_loop"),
        ("agent_loop_run", "generation_id", "canvas_generation"),
    ]
    for collection, field, related_collection in relation_specs:
        ensure_relation(dx, collection, field, relation(collection, field, related_collection))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-u", "--url", required=True)
    parser.add_argument("-e", "--email", required=True)
    parser.add_argument("-p", "--password", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        token = login(args.url, args.email, args.password)
        ensure_schema(Directus(args.url, token, dry_run=args.dry_run))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
