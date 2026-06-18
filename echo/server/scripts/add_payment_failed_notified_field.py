"""Idempotent migration: add `payment_failed_notified` boolean to `billing_account`.

A dedup flag for the failed-charge / dead-mandate notification (ISSUE-008). Set
True when we notify the owner + admins that a recurring charge failed, cleared
when the account recovers. This keeps us from re-notifying on every failed retry
in a past_due window (founder decision 2026-06-18: surface non-payment, never
spam, never block).

Run against a Directus instance with the admin token, then pull the schema
snapshot (directus/sync.sh) and commit
directus/sync/snapshot/fields/billing_account/payment_failed_notified.json.

Usage:
    DIRECTUS_URL=http://directus:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/add_payment_failed_notified_field.py
"""

import os
import sys

import requests

URL = os.environ.get("DIRECTUS_URL", "http://directus:8055").rstrip("/")
EMAIL = os.environ.get("DIRECTUS_EMAIL", "admin@dembrane.com")
PASSWORD = os.environ.get("DIRECTUS_PASSWORD", "admin")

COLLECTION = "billing_account"
FIELD = "payment_failed_notified"


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
        "type": "boolean",
        "schema": {"default_value": False, "is_nullable": False},
        "meta": {
            "interface": "boolean",
            "note": "Dedup flag for the failed-charge notification; cleared on recovery.",
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
        print(f"{COLLECTION}.{FIELD} already exists — nothing to do")
        return 0
    create_field(token)
    print(f"created {COLLECTION}.{FIELD}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
