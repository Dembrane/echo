#!/usr/bin/env python3
"""Idempotent migration: managed-billing fields on billing_account (Wave C / ISSUE-021, 005).

Adds the fields managed billing needs onto `billing_account`:

  1. account_manager_id (M2O -> app_user, SET NULL on delete) - the dembrane
     staff member who owns a managed relationship. Mirrors the `created_by`
     pattern (uuid column + a POST /relations). Restricted to @dembrane.com
     app_users at the application layer (the set-managed / assign-manager
     endpoints validate the email), not in Directus.
  2. VAT + billing address capture (ISSUE-005, capture-only - no rate logic):
       billing_legal_name      (string)
       billing_vat_id          (string)
       billing_vat_region      (select: eu / non_eu / international)
       billing_country         (string, ISO country)
       billing_address_line1   (string)
       billing_address_line2   (string)
       billing_postal_code     (string)
       billing_city            (string)

     Deliberately NO `vat_rate` field: VAT rate / reverse-charge logic is blocked
     on Marco (ISSUE-005 Q1). We capture, Mollie computes.

`payment_mode='offline'` already exists in the schema, so it is not touched here.

Run it against a local Directus, verify, then pull + commit the snapshot
(per root AGENTS.md - never hand-write snapshot JSON):

  python3 add_managed_billing_fields.py \
      -u http://directus:8055 -e admin@dembrane.com -p admin
  cd directus && bash sync.sh -u http://directus:8055 \
      -e admin@dembrane.com -p admin pull

Idempotent: re-running skips anything already present.
"""

from __future__ import annotations

import sys
import json
import argparse
import urllib.error
import urllib.request


class Directus:
    def __init__(self, base_url: str, token: str, dry_run: bool = False):
        self.base = base_url.rstrip("/")
        self.token = token
        self.dry_run = dry_run

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode()
            raise RuntimeError(f"{method} {path} -> {e.code}: {detail}") from None

    def get(self, path: str) -> dict:
        return self._request("GET", path)

    def post(self, path: str, body: dict) -> dict:
        if self.dry_run:
            print(f"    [dry-run] POST {path}")
            return {}
        return self._request("POST", path, body)

    def field_exists(self, collection: str, field: str) -> bool:
        try:
            self.get(f"/fields/{collection}/{field}")
            return True
        except RuntimeError:
            return False

    def relation_exists(self, collection: str, field: str) -> bool:
        try:
            res = self.get(f"/relations/{collection}/{field}")
            return bool(res.get("data"))
        except RuntimeError:
            return False


def login(base_url: str, email: str, password: str) -> str:
    url = f"{base_url.rstrip('/')}/auth/login"
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())["data"]["access_token"]


def _string_field(field: str, sort: int, note: str, choices: list[dict] | None = None) -> dict:
    meta: dict = {
        "collection": "billing_account",
        "field": field,
        "hidden": False,
        "interface": "select-dropdown" if choices else "input",
        "note": note,
        "readonly": False,
        "required": False,
        "searchable": True,
        "sort": sort,
        "special": None,
        "width": "full",
    }
    if choices:
        meta["options"] = {"choices": choices}
    return {
        "collection": "billing_account",
        "field": field,
        "type": "string",
        "meta": meta,
        "schema": {
            "name": field,
            "table": "billing_account",
            "data_type": "character varying",
            "default_value": None,
            "max_length": 255,
            "is_nullable": True,
            "is_unique": False,
            "is_indexed": False,
            "is_primary_key": False,
            "is_generated": False,
            "has_auto_increment": False,
            "foreign_key_table": None,
            "foreign_key_column": None,
        },
    }


def _account_manager_field() -> dict:
    """account_manager_id as a uuid M2O column, mirroring created_by."""
    return {
        "collection": "billing_account",
        "field": "account_manager_id",
        "type": "uuid",
        "meta": {
            "collection": "billing_account",
            "field": "account_manager_id",
            "hidden": False,
            "interface": "select-dropdown-m2o",
            "note": "Assigned dembrane account manager (app_user, @dembrane.com).",
            "readonly": False,
            "required": False,
            "searchable": True,
            "sort": 30,
            "special": ["m2o"],
            "width": "full",
        },
        "schema": {
            "name": "account_manager_id",
            "table": "billing_account",
            "data_type": "uuid",
            "default_value": None,
            "is_nullable": True,
            "is_unique": False,
            "is_indexed": False,
            "is_primary_key": False,
            "is_generated": False,
            "has_auto_increment": False,
            "foreign_key_table": "app_user",
            "foreign_key_column": "id",
        },
    }


def _account_manager_relation() -> dict:
    return {
        "collection": "billing_account",
        "field": "account_manager_id",
        "related_collection": "app_user",
        "meta": {
            "junction_field": None,
            "many_collection": "billing_account",
            "many_field": "account_manager_id",
            "one_collection": "app_user",
            "one_deselect_action": "nullify",
            "one_field": None,
            "sort_field": None,
        },
        "schema": {
            "table": "billing_account",
            "column": "account_manager_id",
            "foreign_key_table": "app_user",
            "foreign_key_column": "id",
            "constraint_name": "billing_account_account_manager_id_foreign",
            "on_update": "NO ACTION",
            "on_delete": "SET NULL",
        },
    }


# (field_name, sort, note, choices) in display order.
VAT_FIELDS = [
    ("billing_legal_name", 31, "Legal entity name on the invoice.", None),
    ("billing_vat_id", 32, "VAT identification number (optional). Validated by Mollie.", None),
    (
        "billing_vat_region",
        33,
        "VAT region for invoicing. Capture only; rate logic lives with Mollie.",
        [
            {"text": "EU", "value": "eu"},
            {"text": "Non-EU", "value": "non_eu"},
            {"text": "International", "value": "international"},
        ],
    ),
    ("billing_country", 34, "Country of residence (ISO code or name).", None),
    ("billing_address_line1", 35, "Billing address line 1.", None),
    ("billing_address_line2", 36, "Billing address line 2 (optional).", None),
    ("billing_postal_code", 37, "Billing postal / ZIP code.", None),
    ("billing_city", 38, "Billing city.", None),
]


def ensure_account_manager(dx: Directus) -> None:
    if dx.field_exists("billing_account", "account_manager_id"):
        print("  field billing_account.account_manager_id: exists, skipping")
    else:
        print("  field billing_account.account_manager_id: creating")
        dx.post("/fields/billing_account", _account_manager_field())
    if dx.relation_exists("billing_account", "account_manager_id"):
        print("  relation billing_account.account_manager_id: exists, skipping")
    else:
        print("  relation billing_account.account_manager_id: creating")
        dx.post("/relations", _account_manager_relation())


def ensure_vat_fields(dx: Directus) -> None:
    for field, sort, note, choices in VAT_FIELDS:
        if dx.field_exists("billing_account", field):
            print(f"  field billing_account.{field}: exists, skipping")
            continue
        print(f"  field billing_account.{field}: creating")
        dx.post("/fields/billing_account", _string_field(field, sort, note, choices))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-u", "--url", required=True)
    ap.add_argument("-e", "--email", required=True)
    ap.add_argument("-p", "--password", required=True)
    ap.add_argument("--dry-run", action="store_true", help="report changes without writing")
    args = ap.parse_args()

    print(f"Authenticating to {args.url} ...")
    token = login(args.url, args.email, args.password)
    dx = Directus(args.url, token, dry_run=args.dry_run)

    print("Step 1/2: account_manager_id (M2O app_user)")
    ensure_account_manager(dx)
    print("Step 2/2: VAT + address capture fields")
    ensure_vat_fields(dx)

    if args.dry_run:
        print("\nDry run complete. No changes written.")
        return 0

    print("\nDone. Now pull the snapshot:")
    print("  cd directus && bash sync.sh -u <url> -e <email> -p <password> pull")
    return 0


if __name__ == "__main__":
    sys.exit(main())
