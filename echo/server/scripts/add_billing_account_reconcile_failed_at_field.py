"""Idempotent migration: add `reconcile_failed_at` timestamp to `billing_account`.

Observable flag for seat reconciliation health (Wave A / ISSUE-001). Set to now
when a synchronous seat re-price fails against Mollie (a re-price error or a
dead/invalid mandate); cleared back to null on the next clean reconcile. The
billing dashboard reads it to surface the "fix your payment" prompt.

Run against a Directus instance with the admin token, then pull the schema
snapshot (directus/sync.sh) and commit
directus/sync/snapshot/fields/billing_account/reconcile_failed_at.json.

Usage:
    DIRECTUS_URL=http://directus:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/add_billing_account_reconcile_failed_at_field.py
"""

import os
import sys

import requests

URL = os.environ.get("DIRECTUS_URL", "http://directus:8055").rstrip("/")
EMAIL = os.environ.get("DIRECTUS_EMAIL", "admin@dembrane.com")
PASSWORD = os.environ.get("DIRECTUS_PASSWORD", "admin")

COLLECTION = "billing_account"
FIELD = "reconcile_failed_at"


def login() -> str:
    res = requests.post(
        f"{URL}/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=15,
    )
    res.raise_for_status()
    return res.json()["data"]["access_token"]


def field_exists(token: str, collection: str, field: str) -> bool:
    res = requests.get(
        f"{URL}/fields/{collection}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    res.raise_for_status()
    return any(f["field"] == field for f in res.json()["data"])


def create_field(token: str) -> None:
    payload = {
        "field": FIELD,
        "type": "timestamp",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "datetime",
            "note": (
                "Set when a seat re-price against Mollie last failed "
                "(re-price error or dead mandate); null when reconcile is clean."
            ),
            "width": "full",
        },
    }
    res = requests.post(
        f"{URL}/fields/{COLLECTION}",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=15,
    )
    res.raise_for_status()


def main() -> int:
    token = login()
    if field_exists(token, COLLECTION, FIELD):
        print(f"{COLLECTION}.{FIELD} already exists -- nothing to do")
        return 0
    create_field(token)
    print(f"created {COLLECTION}.{FIELD}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
