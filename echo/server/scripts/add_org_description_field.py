"""Idempotent migration: add `description` text field to the `org` collection.

Powers the organisation description section on the org overview page.

Run against a Directus instance with the admin token, then pull the schema
snapshot (directus/sync.sh) and commit directus/sync/snapshot/fields/org/description.json.

Usage:
    DIRECTUS_URL=http://directus:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/add_org_description_field.py
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


def field_exists(token: str, collection: str, field: str) -> bool:
    res = requests.get(
        f"{URL}/fields/{collection}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    res.raise_for_status()
    return any(f["field"] == field for f in res.json()["data"])


def create_description_field(token: str) -> None:
    payload = {
        "field": "description",
        "type": "text",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "input-multiline",
            "note": "Short description shown on the organisation overview.",
            "width": "full",
        },
    }
    res = requests.post(
        f"{URL}/fields/org",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=15,
    )
    res.raise_for_status()


def main() -> int:
    token = login()
    if field_exists(token, "org", "description"):
        print("org.description already exists — nothing to do")
        return 0
    create_description_field(token)
    print("created org.description")
    return 0


if __name__ == "__main__":
    sys.exit(main())
