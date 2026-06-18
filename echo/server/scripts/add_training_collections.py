"""Idempotent migration: create the `training` + `training_license` collections.

Powers the Training feature (ISSUE-020):
    - `training`     : an org-scoped session (online / in_person / flex), requested
                       then staff-provisioned. May grant per-user licenses.
    - `training_license` : a per-user, one-year high-risk compliance entitlement.
                       The row IS the verification record (trained vs not trained).

Both collections are created via the Directus REST API (POST /collections, /fields,
/relations) with the admin token, guarded by collection_exists / field_exists /
relation_exists so re-running is a no-op. Never hand-write the snapshot JSON.

Run against a Directus instance with the admin token, then pull the schema
snapshot (directus/sync.sh) and commit only the training* / training_license*
snapshot paths.

Usage:
    DIRECTUS_URL=http://directus:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/add_training_collections.py
"""

import os
import sys

import requests

URL = os.environ.get("DIRECTUS_URL", "http://directus:8055").rstrip("/")
EMAIL = os.environ.get("DIRECTUS_EMAIL", "admin@dembrane.com")
PASSWORD = os.environ.get("DIRECTUS_PASSWORD", "admin")


def login() -> str:
    res = requests.post(
        f"{URL}/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=15,
    )
    res.raise_for_status()
    return res.json()["data"]["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def collection_exists(token: str, collection: str) -> bool:
    res = requests.get(
        f"{URL}/collections/{collection}",
        headers=_headers(token),
        timeout=15,
    )
    if res.status_code == 200:
        return True
    if res.status_code in (403, 404):
        return False
    res.raise_for_status()
    return False


def field_exists(token: str, collection: str, field: str) -> bool:
    res = requests.get(
        f"{URL}/fields/{collection}",
        headers=_headers(token),
        timeout=15,
    )
    if res.status_code in (403, 404):
        return False
    res.raise_for_status()
    return any(f["field"] == field for f in res.json()["data"])


def relation_exists(token: str, collection: str, field: str) -> bool:
    res = requests.get(
        f"{URL}/relations/{collection}",
        headers=_headers(token),
        timeout=15,
    )
    if res.status_code in (403, 404):
        return False
    res.raise_for_status()
    return any(r.get("field") == field for r in res.json()["data"])


def create_collection(token: str, collection: str, note: str, icon: str) -> None:
    """Create a collection with a uuid primary key. Mirrors the Directus
    default `POST /collections` shape (PK declared inline)."""
    payload = {
        "collection": collection,
        "meta": {
            "note": note,
            "icon": icon,
            "hidden": False,
            "singleton": False,
        },
        "schema": {"name": collection},
        "fields": [
            {
                "field": "id",
                "type": "uuid",
                "meta": {
                    "hidden": True,
                    "readonly": True,
                    "interface": "input",
                    "special": ["uuid"],
                },
                "schema": {
                    "is_primary_key": True,
                    "is_nullable": False,
                    "is_unique": True,
                },
            }
        ],
    }
    res = requests.post(
        f"{URL}/collections",
        headers=_headers(token),
        json=payload,
        timeout=15,
    )
    res.raise_for_status()


def create_field(token: str, collection: str, payload: dict) -> None:
    res = requests.post(
        f"{URL}/fields/{collection}",
        headers=_headers(token),
        json=payload,
        timeout=15,
    )
    res.raise_for_status()


def create_relation(
    token: str,
    collection: str,
    field: str,
    related_collection: str,
    on_delete: str = "SET NULL",
) -> None:
    payload = {
        "collection": collection,
        "field": field,
        "related_collection": related_collection,
        "schema": {"on_delete": on_delete},
        "meta": {"one_deselect_action": "nullify"},
    }
    res = requests.post(
        f"{URL}/relations",
        headers=_headers(token),
        json=payload,
        timeout=15,
    )
    res.raise_for_status()


# ── field definitions ──────────────────────────────────────────────────────


def _uuid_fk_field(field: str, note: str, nullable: bool = True) -> dict:
    return {
        "field": field,
        "type": "uuid",
        "meta": {"interface": "input", "note": note, "width": "full"},
        "schema": {"is_nullable": nullable},
    }


def _enum_field(field: str, note: str, choices: list[str], default: str) -> dict:
    return {
        "field": field,
        "type": "string",
        "meta": {
            "interface": "select-dropdown",
            "note": note,
            "options": {
                "choices": [{"text": c.replace("_", " ").title(), "value": c} for c in choices]
            },
            "width": "full",
        },
        "schema": {"default_value": default, "is_nullable": True},
    }


def _int_field(field: str, note: str, default: int = 0) -> dict:
    return {
        "field": field,
        "type": "integer",
        "meta": {"interface": "input", "note": note, "width": "half"},
        "schema": {"default_value": default, "is_nullable": True},
    }


def _numeric_field(field: str, note: str, nullable: bool = True) -> dict:
    return {
        "field": field,
        "type": "float",
        "meta": {"interface": "input", "note": note, "width": "half"},
        "schema": {"is_nullable": nullable},
    }


def _bool_field(field: str, note: str, default: bool) -> dict:
    return {
        "field": field,
        "type": "boolean",
        "meta": {"interface": "boolean", "note": note, "width": "half"},
        "schema": {"default_value": default, "is_nullable": False},
    }


def _datetime_field(field: str, note: str, nullable: bool = True) -> dict:
    return {
        "field": field,
        "type": "timestamp",
        "meta": {"interface": "datetime", "note": note, "width": "half"},
        "schema": {"is_nullable": nullable},
    }


def _text_field(field: str, note: str) -> dict:
    return {
        "field": field,
        "type": "text",
        "meta": {"interface": "input-multiline", "note": note, "width": "full"},
        "schema": {"is_nullable": True},
    }


# (field_payload, fk_target_or_None, on_delete)
TRAINING_FIELDS = [
    (_uuid_fk_field("org_id", "Owner org of this training session."), "org", "CASCADE"),
    (_enum_field("type", "Training product.", ["online", "in_person", "flex"], "online"), None, None),
    (_int_field("included_participants", "Participants included in the base price."), None, None),
    (_int_field("extra_participants", "Participants beyond the included count."), None, None),
    (_numeric_field("base_price_eur", "Base price for the session, EUR."), None, None),
    (_numeric_field("extra_price_eur", "Per-extra-participant price, EUR."), None, None),
    (_bool_field("grants_license", "True for certified trainings (online / in_person).", True), None, None),
    (_datetime_field("scheduled_at", "When the session is scheduled (staff-set)."), None, None),
    (
        _enum_field(
            "status",
            "Lifecycle of the session.",
            ["requested", "scheduled", "completed", "cancelled"],
            "requested",
        ),
        None,
        None,
    ),
    (_text_field("notes", "Staff notes."), None, None),
    (_uuid_fk_field("requested_by", "App user who requested this training."), "app_user", "SET NULL"),
    (_datetime_field("created_at", "Created timestamp."), None, None),
    (_datetime_field("updated_at", "Last-updated timestamp."), None, None),
]

# training_id is nullable so staff can grant a standalone license.
TRAINING_LICENSE_FIELDS = [
    (
        _uuid_fk_field("training_id", "Source training session (null for a standalone grant)."),
        "training",
        "SET NULL",
    ),
    (_uuid_fk_field("org_id", "Org the license belongs to."), "org", "CASCADE"),
    (_uuid_fk_field("app_user_id", "User who holds the license."), "app_user", "CASCADE"),
    (_datetime_field("completed_at", "When the user completed the training."), None, None),
    (_datetime_field("expires_at", "completed_at + 365 days. Trained while > now."), None, None),
    (
        _enum_field(
            "status",
            "Compliance state.",
            ["active", "expired", "revoked"],
            "active",
        ),
        None,
        None,
    ),
    (_uuid_fk_field("granted_by", "Staff app user who marked completion."), "app_user", "SET NULL"),
    (_datetime_field("created_at", "Created timestamp."), None, None),
]


def _ensure_collection(token: str, collection: str, note: str, icon: str, fields: list) -> None:
    if collection_exists(token, collection):
        print(f"{collection} already exists")
    else:
        create_collection(token, collection, note=note, icon=icon)
        print(f"created collection {collection}")

    for field_payload, fk_target, on_delete in fields:
        field_name = field_payload["field"]
        if field_exists(token, collection, field_name):
            print(f"  {collection}.{field_name} already exists")
        else:
            create_field(token, collection, field_payload)
            print(f"  created {collection}.{field_name}")
        if fk_target is not None:
            if relation_exists(token, collection, field_name):
                print(f"  relation {collection}.{field_name} -> {fk_target} already exists")
            else:
                create_relation(token, collection, field_name, fk_target, on_delete or "SET NULL")
                print(f"  created relation {collection}.{field_name} -> {fk_target}")


def main() -> int:
    token = login()

    _ensure_collection(
        token,
        "training",
        note="A requested or scheduled training session (org-scoped).",
        icon="school",
        fields=TRAINING_FIELDS,
    )
    # training_license references training, so training must exist first.
    _ensure_collection(
        token,
        "training_license",
        note="Per-user, one-year high-risk training license (the verification record).",
        icon="verified",
        fields=TRAINING_LICENSE_FIELDS,
    )
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
