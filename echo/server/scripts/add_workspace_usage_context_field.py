"""Idempotent migration: add `usage_context` to the `workspace` collection.

When a workspace belongs to a partner organisation (org.is_partner), the
workspace self-identifies whether it is for internal use or for an external
client (Founder decision D1, ISSUE-012). This field stores that choice so it
survives across sessions and is editable from workspace settings.

Values: "internal" | "external". Nullable — non-partner orgs leave it null
(implicitly internal).

Run against a Directus instance with the admin token, then pull the schema
snapshot (directus/sync.sh) and commit
directus/sync/snapshot/fields/workspace/usage_context.json.

Usage:
    DIRECTUS_URL=http://directus:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/add_workspace_usage_context_field.py
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


def main() -> int:
    token = login()
    if field_exists(token, "workspace", "usage_context"):
        print("workspace.usage_context already exists — nothing to do")
        return 0
    res = requests.post(
        f"{URL}/fields/workspace",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "field": "usage_context",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {
                "interface": "select-dropdown",
                "options": {
                    "choices": [
                        {"text": "Internal use", "value": "internal"},
                        {"text": "External client", "value": "external"},
                    ]
                },
                "note": (
                    "Partner-org workspaces self-identify internal vs external "
                    "client use. Null on non-partner orgs (implicitly internal)."
                ),
                "width": "half",
            },
        },
        timeout=15,
    )
    res.raise_for_status()
    print("created workspace.usage_context")
    return 0


if __name__ == "__main__":
    sys.exit(main())
