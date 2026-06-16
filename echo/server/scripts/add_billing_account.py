"""Idempotent migration: introduce the `billing_account` collection (Phase 1).

Extracts commercial terms off `workspace` into a standalone billing account that
attaches to an org or a workspace. See docs/plans/billing-account-split.md and
docs/adr/0005-per-seat-tier-overhaul.md.

Phase 1 is behavior-preserving: it creates the collection, adds a NOT NULL
`workspace.billing_account_id`, and backfills one workspace-scoped account per
existing workspace with the current tier/terms copied over. `workspace.tier`
is left in place (dual-written) until a later phase. No pricing change here.

Steps (each idempotent):
  1. create `billing_account` collection (+ uuid pk)
  2. add billing_account fields
  3. wire billing_account relations (org_id, workspace_id, created_by)
  4. add `workspace.billing_account_id` (nullable first) + relation
  5. backfill: one account per workspace, copy tier/terms, point the workspace
  6. flip `workspace.billing_account_id` to NOT NULL once every row is set

Run against a Directus instance with the admin token, then pull the snapshot
(directus/sync.sh) and commit the new JSON under directus/sync/snapshot/.

Usage:
    DIRECTUS_URL=http://directus:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/add_billing_account.py
"""

import os
import sys

import requests

URL = os.environ.get("DIRECTUS_URL", "http://directus:8055").rstrip("/")
EMAIL = os.environ.get("DIRECTUS_EMAIL", "admin@dembrane.com")
PASSWORD = os.environ.get("DIRECTUS_PASSWORD", "admin")

TIER_CHOICES = [
    {"text": "Free", "value": "free"},
    {"text": "Pilot", "value": "pilot"},
    {"text": "Pioneer", "value": "pioneer"},
    {"text": "Innovator", "value": "innovator"},
    {"text": "Changemaker", "value": "changemaker"},
    {"text": "Guardian", "value": "guardian"},
]

# Commercial fields copied 1:1 from workspace into the new account on backfill.
COPIED_FIELDS = [
    "tier",
    "tier_expires_at",
    "downgraded_at",
    "downgraded_from_tier",
    "pre_warning_sent",
    "percent_discount",
    "type_discount",
]


def _sess(token: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}"})
    return s


def login() -> str:
    res = requests.post(
        f"{URL}/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=15,
    )
    res.raise_for_status()
    return res.json()["data"]["access_token"]


def collection_exists(s: requests.Session, collection: str) -> bool:
    res = s.get(f"{URL}/collections/{collection}", timeout=15)
    if res.status_code == 200:
        return True
    if res.status_code in (403, 404):
        return False
    res.raise_for_status()
    return False


def field_exists(s: requests.Session, collection: str, field: str) -> bool:
    res = s.get(f"{URL}/fields/{collection}", timeout=15)
    res.raise_for_status()
    return any(f["field"] == field for f in res.json()["data"])


def relation_exists(s: requests.Session, collection: str, field: str) -> bool:
    res = s.get(f"{URL}/relations/{collection}", timeout=15)
    if res.status_code == 404:
        return False
    res.raise_for_status()
    return any(r["field"] == field for r in res.json()["data"])


def create_collection(s: requests.Session) -> None:
    payload = {
        "collection": "billing_account",
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
                "schema": {"is_primary_key": True, "has_auto_increment": False},
            }
        ],
        "schema": {"name": "billing_account"},
        "meta": {
            "accountability": "all",
            "collection": "billing_account",
            "icon": "credit_card",
            "note": "Commercial terms (tier, discounts, payment) for an org or a single workspace.",
            "display_template": "{{label}}",
            "hidden": False,
            "singleton": False,
        },
    }
    res = s.post(f"{URL}/collections", json=payload, timeout=30)
    res.raise_for_status()


def add_field(s: requests.Session, payload: dict) -> None:
    if field_exists(s, "billing_account", payload["field"]):
        print(f"  field billing_account.{payload['field']} exists")
        return
    res = s.post(f"{URL}/fields/billing_account", json=payload, timeout=30)
    res.raise_for_status()
    print(f"  + billing_account.{payload['field']}")


def billing_account_field_payloads() -> list[dict]:
    string_note = lambda note: {  # noqa: E731
        "interface": "input",
        "note": note,
    }
    return [
        {
            "field": "label",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": string_note("Staff-facing label, e.g. 'Acme org billing'."),
        },
        {
            "field": "org_id",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {
                "interface": "input",
                "note": "Owner org (exactly one of org_id / workspace_id is set).",
            },
        },
        {
            "field": "workspace_id",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {
                "interface": "input",
                "note": "Owner workspace (exactly one of org_id / workspace_id is set).",
            },
        },
        {
            "field": "tier",
            "type": "string",
            "schema": {"is_nullable": False, "default_value": "free"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": TIER_CHOICES},
                "note": "Current tier. Source of truth; workspace.tier mirrors it during Phase 1.",
            },
        },
        {
            "field": "tier_expires_at",
            "type": "timestamp",
            "schema": {"is_nullable": True},
            "meta": {"interface": "datetime", "note": "Optional tier expiry; hourly cron downgrades to free when elapsed."},
        },
        {
            "field": "downgraded_at",
            "type": "timestamp",
            "schema": {"is_nullable": True},
            "meta": {"interface": "datetime", "note": "Timestamp of last downgrade (drives the 7-day banner)."},
        },
        {
            "field": "downgraded_from_tier",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": string_note("Tier before the last downgrade. Cleared on next upgrade."),
        },
        {
            "field": "pre_warning_sent",
            "type": "boolean",
            "schema": {"is_nullable": False, "default_value": False},
            "meta": {"interface": "boolean", "note": "Dedup flag for the 3-day tier-expiry pre-warning email."},
        },
        {
            "field": "percent_discount",
            "type": "integer",
            "schema": {"is_nullable": True},
            "meta": string_note("0-100. Applied at tier subscription price only (descriptive)."),
        },
        {
            "field": "type_discount",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {
                "interface": "select-dropdown",
                "options": {
                    "choices": [
                        {"text": "Scholarship", "value": "scholarship"},
                        {"text": "Staff discount", "value": "staff_discount"},
                    ]
                },
                "note": "Categorical discount label. Descriptive only.",
            },
        },
        {
            "field": "billing_period",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {
                "interface": "select-dropdown",
                "options": {
                    "choices": [
                        {"text": "Annual", "value": "annual"},
                        {"text": "Monthly", "value": "monthly"},
                    ]
                },
                "note": "Billing cadence. Null until set; resolver falls back to workspace_request during Phase 1.",
            },
        },
        {
            "field": "payment_mode",
            "type": "string",
            "schema": {"is_nullable": False, "default_value": "none"},
            "meta": {
                "interface": "select-dropdown",
                "options": {
                    "choices": [
                        {"text": "None", "value": "none"},
                        {"text": "Mollie", "value": "mollie"},
                        {"text": "Offline / invoice", "value": "offline"},
                    ]
                },
                "note": "How the account is paid. Offline is first-class and never depends on Mollie.",
            },
        },
        {
            "field": "provisioned_seats",
            "type": "integer",
            "schema": {"is_nullable": True},
            "meta": string_note("Committed seat count for offline sales. Metered usage is always computed from membership."),
        },
        {
            "field": "created_at",
            "type": "timestamp",
            "schema": {"is_nullable": True, "default_value": "CURRENT_TIMESTAMP"},
            "meta": {"interface": "datetime", "readonly": True, "special": ["date-created"], "width": "half"},
        },
        {
            "field": "updated_at",
            "type": "timestamp",
            "schema": {"is_nullable": True, "default_value": "CURRENT_TIMESTAMP"},
            "meta": {"interface": "datetime", "readonly": True, "special": ["date-updated"], "width": "half"},
        },
        {
            "field": "created_by",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "Creator (app_user)."},
        },
        {
            "field": "deleted_at",
            "type": "timestamp",
            "schema": {"is_nullable": True},
            "meta": {"interface": "datetime", "note": "Soft-delete timestamp."},
        },
    ]


def add_relation(
    s: requests.Session,
    collection: str,
    field: str,
    related_collection: str,
    on_delete: str,
) -> None:
    if relation_exists(s, collection, field):
        print(f"  relation {collection}.{field} -> {related_collection} exists")
        return
    payload = {
        "collection": collection,
        "field": field,
        "related_collection": related_collection,
        "meta": {
            "many_collection": collection,
            "many_field": field,
            "one_collection": related_collection,
            "one_deselect_action": "nullify",
        },
        "schema": {"on_delete": on_delete, "on_update": "NO ACTION"},
    }
    res = s.post(f"{URL}/relations", json=payload, timeout=30)
    res.raise_for_status()
    print(f"  + relation {collection}.{field} -> {related_collection} (on_delete={on_delete})")


def add_workspace_fk(s: requests.Session) -> None:
    if not field_exists(s, "workspace", "billing_account_id"):
        payload = {
            "field": "billing_account_id",
            "type": "uuid",
            "schema": {"is_nullable": True},  # nullable first; flipped after backfill
            "meta": {
                "interface": "input",
                "note": "The billing account funding this workspace. Exactly one, always (NOT NULL after backfill).",
            },
        }
        res = s.post(f"{URL}/fields/workspace", json=payload, timeout=30)
        res.raise_for_status()
        print("  + workspace.billing_account_id (nullable)")
    else:
        print("  field workspace.billing_account_id exists")
    add_relation(s, "workspace", "billing_account_id", "billing_account", on_delete="NO ACTION")


def get_all_workspaces(s: requests.Session) -> list[dict]:
    fields = ",".join(["id", "name", "billing_account_id", *COPIED_FIELDS])
    res = s.get(
        f"{URL}/items/workspace",
        params={"limit": -1, "fields": fields},
        timeout=60,
    )
    res.raise_for_status()
    return res.json()["data"]


def backfill(s: requests.Session) -> int:
    workspaces = get_all_workspaces(s)
    todo = [w for w in workspaces if not w.get("billing_account_id")]
    print(f"  {len(workspaces)} workspaces, {len(todo)} need a billing account")
    created = 0
    for w in todo:
        account = {k: w.get(k) for k in COPIED_FIELDS}
        account["workspace_id"] = w["id"]
        account["org_id"] = None
        account["payment_mode"] = "none"
        account["label"] = (w.get("name") or "Workspace") + " billing"
        res = s.post(f"{URL}/items/billing_account", json=account, timeout=30)
        res.raise_for_status()
        account_id = res.json()["data"]["id"]
        patch = s.patch(
            f"{URL}/items/workspace/{w['id']}",
            json={"billing_account_id": account_id},
            timeout=30,
        )
        patch.raise_for_status()
        created += 1
    print(f"  backfilled {created} accounts")
    return len([w for w in get_all_workspaces(s) if not w.get("billing_account_id")])


def flip_workspace_fk_not_null(s: requests.Session, remaining_null: int) -> None:
    if remaining_null > 0:
        print(f"  SKIP NOT NULL flip: {remaining_null} workspaces still have no billing_account_id")
        return
    res = s.patch(
        f"{URL}/fields/workspace/billing_account_id",
        json={"schema": {"is_nullable": False}},
        timeout=30,
    )
    res.raise_for_status()
    print("  workspace.billing_account_id is now NOT NULL")


def main() -> int:
    token = login()
    s = _sess(token)

    print("1. collection")
    if collection_exists(s, "billing_account"):
        print("  billing_account exists")
    else:
        create_collection(s)
        print("  + billing_account collection")

    print("2. fields")
    for payload in billing_account_field_payloads():
        add_field(s, payload)

    print("3. relations")
    add_relation(s, "billing_account", "org_id", "org", on_delete="CASCADE")
    add_relation(s, "billing_account", "workspace_id", "workspace", on_delete="CASCADE")
    add_relation(s, "billing_account", "created_by", "app_user", on_delete="SET NULL")

    print("4. workspace.billing_account_id")
    add_workspace_fk(s)

    print("5. backfill")
    remaining_null = backfill(s)

    print("6. NOT NULL flip")
    flip_workspace_fk_not_null(s, remaining_null)

    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
