"""
Lock down Directus permissions on project-scoped collections.

Every frontend read/write for these collections now goes through
/v2/bff/* (see server/dembrane/api/v2/bff/_access.py). Directus's own
row-level ACL doesn't know about the v2 inheritance / sharing model,
so keeping non-admin permissions on these tables was at best
redundant and at worst dangerously permissive (a 403 on a BFF route
but open access if someone went to the raw Directus API).

This script deletes every permission on a fixed set of collections
for any policy OTHER than the built-in administrator policy. The
admin token + `async_directus` + the BFF layer continue to work
because they attach to the admin policy.

Usage:
    DIRECTUS_TOKEN=... DIRECTUS_BASE_URL=http://directus:8055 \\
        python scripts/lock_directus_permissions.py [--dry-run]

After running with --dry-run to confirm the target set, run without
--dry-run, then refresh the sync snapshot:

    cd directus && bash sync.sh -u http://directus:8055 \\
        -e admin@dembrane.com -p admin pull

…and commit the resulting snapshot diff so future `sync.sh apply`
runs don't re-grant the removed permissions.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

import requests

TARGET_COLLECTIONS = [
    "project",
    "conversation",
    "conversation_chunk",
    "conversation_segment",
    "conversation_project_tag",
    "project_chat",
    "project_chat_message",
    "project_chat_conversation",
    "project_report",
    "project_report_metric",
    "project_tag",
    "project_analysis_run",
    "project_agentic_run_event",
    "view",
    "aspect",
    "aspect_segment",
]

DIRECTUS_URL = os.environ.get("DIRECTUS_BASE_URL", "http://directus:8055")
DIRECTUS_TOKEN = os.environ.get("DIRECTUS_TOKEN", "")
if not DIRECTUS_TOKEN:
    env_path = os.path.join(
        os.path.dirname(__file__), "..", "directus", ".env"
    )
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DIRECTUS_TOKEN="):
                    DIRECTUS_TOKEN = (
                        line.split("=", 1)[1].strip().strip('"').strip("'")
                    )


HEADERS = {
    "Authorization": f"Bearer {DIRECTUS_TOKEN}",
    "Content-Type": "application/json",
}


def api(method: str, path: str, **kwargs: Any) -> requests.Response:
    return requests.request(
        method, f"{DIRECTUS_URL}{path}", headers=HEADERS, timeout=30, **kwargs
    )


def find_admin_policy_id() -> str | None:
    """Resolve the Administrator policy id.

    The _sync_default_admin_policy sync-id is stable across envs but the
    DB id isn't — we look up by `admin_access = true` which is only
    ever set on the built-in admin policy.
    """
    resp = api(
        "GET",
        "/policies",
        params={
            "filter[admin_access][_eq]": "true",
            "fields": "id,name",
            "limit": -1,
        },
    )
    resp.raise_for_status()
    data = resp.json().get("data") or []
    if not data:
        return None
    # Prefer the built-in name if there are multiple admin-flagged rows.
    for row in data:
        if row.get("name") == "Administrator":
            return row["id"]
    return data[0].get("id")


def list_permissions() -> list[dict]:
    """Return every non-admin permission on our target collections."""
    admin_id = find_admin_policy_id()
    if not admin_id:
        print("  ! couldn't find the Administrator policy id; refusing to run.")
        return []

    out: list[dict] = []
    for col in TARGET_COLLECTIONS:
        resp = api(
            "GET",
            "/permissions",
            params={
                "filter[collection][_eq]": col,
                "fields": "id,action,collection,policy",
                "limit": -1,
            },
        )
        if resp.status_code == 404:
            continue
        resp.raise_for_status()
        for row in resp.json().get("data") or []:
            policy = row.get("policy")
            if policy and policy != admin_id:
                out.append(row)
    return out


def delete_permission(perm_id: int) -> bool:
    resp = api("DELETE", f"/permissions/{perm_id}")
    if resp.status_code not in (200, 204):
        print(f"  ! failed to delete permission {perm_id}: {resp.status_code} {resp.text[:200]}")
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be removed without deleting.",
    )
    args = parser.parse_args()

    if not DIRECTUS_TOKEN:
        print("Set DIRECTUS_TOKEN (or populate directus/.env).")
        return 2

    targets = list_permissions()
    if not targets:
        print("Nothing to remove — target collections already admin-only.")
        return 0

    print(f"{'Dry run — ' if args.dry_run else ''}{len(targets)} non-admin permissions on target collections:")
    by_col: dict[str, list[str]] = {}
    for row in targets:
        by_col.setdefault(row["collection"], []).append(
            f"{row['action']} · policy={row['policy']}"
        )
    for col in sorted(by_col):
        print(f"\n  {col}")
        for line in by_col[col]:
            print(f"    - {line}")

    if args.dry_run:
        print("\n(no changes made)")
        return 0

    print("\nDeleting…")
    ok = 0
    failed = 0
    for row in targets:
        if delete_permission(row["id"]):
            ok += 1
        else:
            failed += 1
    print(f"\nDone. removed={ok} failed={failed}.")
    if ok > 0:
        print(
            "\nNext: refresh the sync snapshot so future `sync.sh apply` doesn't regrant.\n"
            "  cd directus && bash sync.sh pull\n"
            "  git add directus/sync/ && git commit -m 'chore(directus): lock project-scoped collections admin-only'"
        )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
