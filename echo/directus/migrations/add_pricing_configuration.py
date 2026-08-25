#!/usr/bin/env python3
"""Idempotent migration for the pricing configurator's durable row.

Creates the `pricing_configuration` collection. One row per attempt at the
pricing configurator, keyed on `config_session_id`, written at the first
answer and updated on every step.

The row is the durable record; the PostHog events are only the shape of it. A
dropped event costs a number, a dropped row costs the answers.

Run against local Directus, then pull the snapshot:

  python3 add_pricing_configuration.py \
      -u http://localhost:8055 -e admin@dembrane.com -p admin
  cd echo/directus && bash sync.sh -u http://localhost:8055 \
      -e admin@dembrane.com -p admin pull

Run it twice. The second run must report every object as "exists, skipping".

Two shape decisions worth stating, both of them deliberate:

  * `config_session_id`, never `session_id`. PostHog already owns
    `$session_id`, and two different ids called "session id" get read wrong
    within a month.
  * No foreign keys on `workspace_id`, `org_id`, `project_id` or `user_id`.
    They arrive from a browser. A stale id must never cost us the answers,
    so they are plain columns and the endpoint validates them.
"""

from __future__ import annotations

import sys
import json
import argparse
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

COLLECTION = "pricing_configuration"


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


def login(base_url: str, email: str, password: str) -> str:
    url = f"{base_url.rstrip('/')}/auth/login"
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))["data"]["access_token"]


# ── field builders (same shapes as add_smart_loop_phase0_schema.py) ──


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
    note: str | None = None,
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
            "note": note,
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
    is_unique: bool = False,
    note: str | None = None,
    width: str = "full",
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
        note=note,
        data_type="character varying",
        default_value=default_value,
        is_nullable=not required,
        is_unique=is_unique,
        max_length=255,
        width=width,
    )


def text_field(
    collection: str, field: str, *, sort: int, note: str | None = None
) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        "text",
        sort=sort,
        interface="input-multiline",
        note=note,
        data_type="text",
    )


def json_field(
    collection: str, field: str, *, sort: int, note: str | None = None
) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        "json",
        sort=sort,
        interface="input-code",
        special=["cast-json"],
        options={"language": "json"},
        note=note,
        data_type="json",
    )


def integer_field(
    collection: str,
    field: str,
    *,
    sort: int,
    default_value: int | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        "integer",
        sort=sort,
        interface="input",
        note=note,
        data_type="integer",
        default_value=default_value,
        width="half",
    )


def boolean_field(
    collection: str,
    field: str,
    *,
    sort: int,
    default_value: bool = False,
    note: str | None = None,
) -> dict[str, Any]:
    return _field_base(
        collection,
        field,
        "boolean",
        sort=sort,
        interface="boolean",
        special=["cast-boolean"],
        note=note,
        data_type="boolean",
        default_value=default_value,
        is_nullable=False,
        width="half",
    )


def timestamp_field(
    collection: str,
    field: str,
    *,
    sort: int,
    special: list[str] | None = None,
    readonly: bool = False,
    note: str | None = None,
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
        note=note,
        data_type="timestamp with time zone",
        width="half",
    )


# ── the collection ──


def collection_payload() -> dict[str, Any]:
    return {
        "collection": COLLECTION,
        "meta": {
            "collection": COLLECTION,
            "accountability": "all",
            "archive_app_filter": True,
            "collapse": "open",
            "display_template": "{{reference}} {{email}}",
            "hidden": False,
            "icon": "request_quote",
            "note": (
                "One row per pricing configurator attempt, finished or not. "
                "Written at the first answer and updated on every step. "
                "The row is the lead; the PostHog events are the shape."
            ),
            "singleton": False,
            "sort": 33,
            "versioning": False,
        },
        "schema": {"name": COLLECTION},
        "fields": [uuid_pk(COLLECTION)],
    }


def fields() -> list[dict[str, Any]]:
    c = COLLECTION
    return [
        uuid_pk(c),
        string_field(
            c,
            "reference",
            sort=2,
            is_unique=True,
            note="Short code on the booking and the confirmation screen, DEM-XXXX. Stable for the life of the session.",
            width="half",
        ),
        string_field(
            c,
            "config_session_id",
            sort=3,
            required=True,
            is_unique=True,
            note="One per attempt, and the key every write upserts on. Named to match the event property, never 'session_id': PostHog owns $session_id.",
            width="half",
        ),
        string_field(
            c,
            "status",
            sort=4,
            default_value="in_progress",
            choices=["in_progress", "submitted", "abandoned"],
            note="The state of the form, never the state of an account. Nothing reads this to decide entitlement.",
            width="half",
        ),
        string_field(
            c,
            "email",
            sort=5,
            note="Read from the authenticated session on the server, never from the client payload. This is the lead.",
            width="half",
        ),
        string_field(
            c,
            "user_id",
            sort=6,
            note="directus_users.id of the person who filled the form. Plain column, no foreign key: a lead must never be lost to a stale id.",
            width="half",
        ),
        boolean_field(
            c,
            "is_internal",
            sort=7,
            note="R14. Derived on the server from the login email domain, never guessed later. The standard query excludes it.",
        ),
        string_field(
            c, "locale", sort=8, note="The language the person read, for example nl-NL.", width="half"
        ),
        string_field(
            c,
            "mount",
            sort=9,
            default_value="app",
            choices=["app", "site"],
            note="app in v1. site when the website version lands.",
            width="half",
        ),
        string_field(
            c,
            "wall_key",
            sort=10,
            note="Which gate started this session, for example transcription_cap.",
            width="half",
        ),
        string_field(c, "workspace_id", sort=11, width="half"),
        string_field(c, "org_id", sort=12, note="Billing lives on the org, not the workspace.", width="half"),
        string_field(c, "project_id", sort=13, width="half"),
        string_field(
            c,
            "question_set_version",
            sort=14,
            note="Which version of the questions was on screen, for example 20-aug-26.",
            width="half",
        ),
        integer_field(
            c,
            "config_shape_version",
            sort=15,
            note="The shape version of the config object. A query must check this before it trusts a key.",
        ),
        json_field(
            c,
            "answers_raw",
            sort=16,
            note="Exactly what was sent, free text included, so a question set change never breaks an old row. This is what a salesperson reads.",
        ),
        json_field(
            c,
            "config",
            sort=17,
            note="The shaped object that also rides on every event, so the row and the events never disagree about what was on screen.",
        ),
        string_field(
            c,
            "volume_bucket",
            sort=18,
            note="Flat mirror of config.volume, derived on the server so a list view is readable without opening the JSON.",
            width="half",
        ),
        string_field(
            c, "concurrency_bucket", sort=19, note="Flat mirror of config.concurrency.", width="half"
        ),
        integer_field(
            c,
            "concurrency_exact",
            sort=20,
            note="Only for the top band, when the person typed a number.",
        ),
        integer_field(c, "answered_count", sort=21, note="How many of the six questions carry an answer."),
        integer_field(c, "furthest_step", sort=22, note="The furthest step this session reached."),
        text_field(
            c,
            "voice_transcript",
            sort=23,
            note="Reserved. A transcription that succeeds lands inside the answer text in answers_raw; this holds a transcript kept apart from the answers.",
        ),
        json_field(
            c,
            "voice_audio",
            sort=24,
            note="One entry per recording that travelled with the answers: question_key, duration_ms, and the Directus file id when the upload succeeded. A failed upload is recorded here with its reason rather than being hidden.",
        ),
        string_field(
            c,
            "booking_status",
            sort=25,
            default_value="none",
            choices=["none", "opened", "confirmed"],
            note="Owned by the booking step, not by the write that stores the answers.",
            width="half",
        ),
        string_field(c, "booking_uid", sort=26, note="From cal.com. That booking is the record.", width="half"),
        timestamp_field(
            c, "created_at", sort=27, special=["date-created"], readonly=True
        ),
        timestamp_field(
            c,
            "updated_at",
            sort=28,
            special=["date-updated"],
            readonly=True,
            note="Every step write moves this. The abandonment sweep reads it.",
        ),
    ]


def ensure_collection(dx: Directus) -> None:
    if dx.collection_exists(COLLECTION):
        print(f"  collection {COLLECTION}: exists, skipping")
        return
    print(f"  collection {COLLECTION}: creating")
    dx.post("/collections", collection_payload())


def ensure_field(dx: Directus, field: dict[str, Any]) -> None:
    name = field["field"]
    if dx.field_exists(COLLECTION, name):
        print(f"  field {COLLECTION}.{name}: exists, skipping")
        return
    print(f"  field {COLLECTION}.{name}: creating")
    dx.post(f"/fields/{COLLECTION}", field)


def ensure_schema(dx: Directus) -> None:
    print(f"Step 1/2: collection {COLLECTION}")
    ensure_collection(dx)

    print(f"Step 2/2: fields on {COLLECTION}")
    for field in fields():
        ensure_field(dx, field)

    print("Migration complete!")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-u", "--url", required=True)
    parser.add_argument("-e", "--email", required=True)
    parser.add_argument("-p", "--password", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        print(f"Logging in to {args.url} as {args.email}...")
        token = login(args.url, args.email, args.password)
        ensure_schema(Directus(args.url, token, dry_run=args.dry_run))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
