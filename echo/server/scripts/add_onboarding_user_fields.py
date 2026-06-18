"""Idempotent migration: add onboarding fields to the `app_user` collection.

Adds two fields:
  - `onboarding_answer_json` (json): the post-register questionnaire answers,
    versioned by a `version` key inside the JSON (see ISSUE-012).
  - `terms_accepted_at` (timestamp): when the user accepted the general terms
    at registration (see ISSUE-013). No version string yet; presence = accepted.

Run against a Directus instance with the admin token, then pull the schema
snapshot (directus/sync.sh) and commit the new field snapshots under
directus/sync/snapshot/fields/app_user/.

Usage:
    DIRECTUS_URL=http://directus:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/add_onboarding_user_fields.py
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


def create_field(token: str, collection: str, payload: dict) -> None:
    res = requests.post(
        f"{URL}/fields/{collection}",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=15,
    )
    res.raise_for_status()


def main() -> int:
    token = login()

    if field_exists(token, "app_user", "onboarding_answer_json"):
        print("app_user.onboarding_answer_json already exists — skipping")
    else:
        create_field(
            token,
            "app_user",
            {
                "field": "onboarding_answer_json",
                "type": "json",
                "schema": {"is_nullable": True},
                "meta": {
                    "interface": "input-code",
                    "options": {"language": "json"},
                    "note": (
                        "Post-register questionnaire answers. "
                        'Shape: {"version": "17-jun-26", "data": [{"q1": "..."}, ...]}.'
                    ),
                    "width": "full",
                },
            },
        )
        print("created app_user.onboarding_answer_json")

    if field_exists(token, "app_user", "terms_accepted_at"):
        print("app_user.terms_accepted_at already exists — skipping")
    else:
        create_field(
            token,
            "app_user",
            {
                "field": "terms_accepted_at",
                "type": "timestamp",
                "schema": {"is_nullable": True},
                "meta": {
                    "interface": "datetime",
                    "note": (
                        "When the user accepted the general terms at registration. "
                        "Presence means accepted; no version string yet."
                    ),
                    "width": "half",
                },
            },
        )
        print("created app_user.terms_accepted_at")

    return 0


if __name__ == "__main__":
    sys.exit(main())
