"""Idempotent migration: drop the vestigial commercial columns off `workspace`.

These moved to `billing_account` (see scripts/add_billing_account.py and
docs/plans/billing-account-split.md). After the SoT switch nothing reads or
writes them on the workspace; the data already lives on each workspace's
billing account via the backfill. Safe to drop because this surface is not in
production yet.

Run AFTER add_billing_account.py (which backfills the accounts), then pull the
snapshot (directus/sync.sh) and commit the removed field JSON.

Usage:
    DIRECTUS_URL=http://directus:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/drop_workspace_billing_columns.py
"""

import os
import sys

import requests

URL = os.environ.get("DIRECTUS_URL", "http://directus:8055").rstrip("/")
EMAIL = os.environ.get("DIRECTUS_EMAIL", "admin@dembrane.com")
PASSWORD = os.environ.get("DIRECTUS_PASSWORD", "admin")

# Commercial columns now owned by billing_account.
DROP_FIELDS = [
    "tier",
    "tier_expires_at",
    "downgraded_at",
    "downgraded_from_tier",
    "pre_warning_sent",
    "percent_discount",
    "type_discount",
]


def login() -> str:
    res = requests.post(
        f"{URL}/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=15,
    )
    res.raise_for_status()
    return res.json()["data"]["access_token"]


def existing_fields(token: str) -> set[str]:
    res = requests.get(
        f"{URL}/fields/workspace",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    res.raise_for_status()
    return {f["field"] for f in res.json()["data"]}


def drop_field(token: str, field: str) -> None:
    res = requests.delete(
        f"{URL}/fields/workspace/{field}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    res.raise_for_status()


def main() -> int:
    token = login()
    present = existing_fields(token)
    for field in DROP_FIELDS:
        if field not in present:
            print(f"  workspace.{field} already gone")
            continue
        drop_field(token, field)
        print(f"  - dropped workspace.{field}")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
