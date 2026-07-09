#!/usr/bin/env python3
"""Idempotent migration for the agent_insight schema.

Run against local Directus, then pull the snapshot:

  python3 add_agent_insight_schema.py \
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

    def patch(self, path: str, body: dict[str, Any]) -> dict:
        if self.dry_run:
            print(f"    [dry-run] PATCH {path}")
            return {}
        return self._request("PATCH", path, body)

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


def text_field(
    collection: str,
    field: str,
    *,
    sort: int,
    required: bool = False,
) -> dict[str, Any]:
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


def timestamp_field(
    collection: str,
    field: str,
    *,
    sort: int,
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
        readonly=readonly,
        special=special,
        data_type="timestamp with time zone",
        width="half",
    )


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
                "icon": "lightbulb",
                "note": (
                    "Quiet product-learning rows written by the assistant when "
                    "hosts expose gaps, friction, wishes, or praise."
                ),
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


def ensure_field_choices(
    dx: Directus, collection: str, field: str, choices: list[str]
) -> None:
    """Idempotently sync a select-dropdown field's choices on installs where the
    field already exists. The column stays a free-text varchar, so this only
    keeps the admin dropdown offering every current value (e.g. a newly added
    "retracted" status); it is never a schema change."""
    if not dx.field_exists(collection, field):
        return
    print(f"  field {collection}.{field}: syncing choices")
    dx.patch(
        f"/fields/{collection}/{field}",
        {
            "meta": {
                "options": {
                    "choices": [{"text": value, "value": value} for value in choices]
                }
            }
        },
    )


def ensure_schema(dx: Directus) -> None:
    collection = "agent_insight"
    ensure_collection(dx, collection, sort=13)
    fields = [
        timestamp_field(collection, "created_at", sort=2, special=["date-created"], readonly=True),
        string_field(
            collection,
            "kind",
            sort=3,
            required=True,
            choices=["capability_gap", "friction", "wish", "praise"],
        ),
        text_field(collection, "content", sort=4, required=True),
        text_field(collection, "suggested_capability", sort=5),
        string_field(collection, "workspace_id", sort=6),
        string_field(collection, "project_id", sort=7),
        string_field(collection, "chat_id", sort=8),
        string_field(collection, "message_id", sort=9),
        string_field(
            collection,
            "status",
            sort=10,
            default_value="new",
            # "retracted" is a host-driven withdrawal: the assistant sets it via
            # retractInsight when a host scraps a note. The row is kept (the
            # dembrane team may already have read it), with the reason below.
            choices=["new", "reviewed", "archived", "retracted"],
        ),
        text_field(collection, "retracted_reason", sort=11),
    ]
    for field in fields:
        ensure_field(dx, collection, field)

    # Existing installs already have the status field, so ensure_field skips it;
    # sync its choices so the admin dropdown also offers the new "retracted"
    # value. The underlying column is free text, so writes work regardless.
    ensure_field_choices(
        dx, collection, "status", ["new", "reviewed", "archived", "retracted"]
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
        ensure_schema(Directus(args.url, token, dry_run=args.dry_run))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
