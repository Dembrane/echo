#!/usr/bin/env python3
"""Idempotent backfill for the billing-account split (Phase 1).

The committed snapshot (commit 5a94b454) makes `workspace.billing_account_id`
NOT NULL and moves the commercial fields (tier, discounts, expiry, downgrade
flags) off `workspace` onto a new `billing_account` collection. A plain
`sync.sh push` therefore fails on any environment whose workspaces predate the
split: Postgres refuses to add a NOT NULL column to a populated table.

This script brings such an environment to the pre-push state described in
docs/plans/billing-account-split.md ("Migration and defaults", step 1):

  1. Create the `billing_account` collection, fields, and relations, read
     verbatim from the committed snapshot so they match exactly.
  2. Add `workspace.billing_account_id` as a NULLABLE FK (so it can be added to
     a populated table), plus its relation.
  3. 1:1 backfill: for every workspace without an account, create a
     workspace-scoped `billing_account` (workspace_id set, org_id null), copy
     the workspace's current commercial fields, and point
     `workspace.billing_account_id` at it. Behavior-preserving.

After this runs, `sync.sh push` converges: it flips billing_account_id to NOT
NULL (now satisfiable), drops the migrated workspace columns, and reconciles
any remaining metadata.

Idempotent: re-running skips anything already present and only backfills
workspaces that still lack an account.

Usage:
  python3 backfill_billing_account.py \
      -u https://directus.echo-next.dembrane.com \
      -e admin@dembrane.com -p '<password>'

  # dry run (no writes, just report what would change):
  python3 backfill_billing_account.py -u ... -e ... -p ... --dry-run
"""

from __future__ import annotations

import sys
import json
import uuid
import argparse
import urllib.error
import urllib.request
from pathlib import Path

# Snapshot lives at directus/sync/snapshot relative to this file
# (directus/migrations/). It is the source of truth for the schema.
SNAPSHOT = Path(__file__).resolve().parent.parent / "sync" / "snapshot"

# Commercial fields that move from workspace onto the account. Mirrors
# BILLING_FIELDS in server/dembrane/billing_account.py, minus billing_period
# (not a workspace column; the resolver falls back to workspace_request during
# Phase 1, so it stays null here).
COPY_FIELDS = (
    "tier",
    "tier_expires_at",
    "downgraded_at",
    "downgraded_from_tier",
    "pre_warning_sent",
    "percent_discount",
    "type_discount",
)


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

    def patch(self, path: str, body: dict) -> dict:
        if self.dry_run:
            print(f"    [dry-run] PATCH {path} {json.dumps(body)}")
            return {}
        return self._request("PATCH", path, body)

    # -- existence checks (idempotency) --------------------------------------

    def collection_exists(self, name: str) -> bool:
        try:
            self.get(f"/collections/{name}")
            return True
        except RuntimeError:
            return False

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


def load_snapshot(relpath: str) -> dict:
    return json.loads((SNAPSHOT / relpath).read_text())


def ensure_collection(dx: Directus) -> None:
    if dx.collection_exists("billing_account"):
        print("  collection billing_account: exists, skipping")
        return
    coll = load_snapshot("collections/billing_account.json")
    id_field = load_snapshot("fields/billing_account/id.json")
    print("  collection billing_account: creating")
    dx.post(
        "/collections",
        {
            "collection": "billing_account",
            "meta": coll["meta"],
            "schema": coll["schema"],
            "fields": [id_field],  # PK must be present at creation
        },
    )


def ensure_fields(dx: Directus) -> None:
    field_dir = SNAPSHOT / "fields" / "billing_account"
    for path in sorted(field_dir.glob("*.json")):
        name = path.stem
        if name == "id":  # created with the collection
            continue
        if dx.field_exists("billing_account", name):
            print(f"  field billing_account.{name}: exists, skipping")
            continue
        print(f"  field billing_account.{name}: creating")
        dx.post("/fields/billing_account", json.loads(path.read_text()))


def ensure_relations(dx: Directus) -> None:
    rel_dir = SNAPSHOT / "relations" / "billing_account"
    for path in sorted(rel_dir.glob("*.json")):
        name = path.stem
        if dx.relation_exists("billing_account", name):
            print(f"  relation billing_account.{name}: exists, skipping")
            continue
        print(f"  relation billing_account.{name}: creating")
        dx.post("/relations", json.loads(path.read_text()))


def ensure_workspace_pointer(dx: Directus) -> None:
    """Add workspace.billing_account_id as NULLABLE (so it can be added to a
    populated table) plus its relation. The subsequent `sync.sh push` flips it
    to NOT NULL once every workspace is backfilled."""
    if dx.field_exists("workspace", "billing_account_id"):
        print("  field workspace.billing_account_id: exists, skipping")
    else:
        field = load_snapshot("fields/workspace/billing_account_id.json")
        # Override the snapshot's NOT NULL so the column can be added now.
        field["schema"]["is_nullable"] = True
        print("  field workspace.billing_account_id: creating (nullable)")
        dx.post("/fields/workspace", field)

    if dx.relation_exists("workspace", "billing_account_id"):
        print("  relation workspace.billing_account_id: exists, skipping")
    else:
        rel = load_snapshot("relations/workspace/billing_account_id.json")
        print("  relation workspace.billing_account_id: creating")
        dx.post("/relations", rel)


def backfill(dx: Directus) -> tuple[int, int]:
    """Create a workspace-scoped account for every workspace missing one.
    Returns (created, already_had)."""
    # In a dry run the pointer field may not exist yet (its POST was skipped);
    # query it only when present so the dry run can still report the count.
    has_pointer = dx.field_exists("workspace", "billing_account_id")
    cols = ["id", *COPY_FIELDS] + (["billing_account_id"] if has_pointer else [])
    res = dx.get(f"/items/workspace?limit=-1&fields={','.join(cols)}")
    workspaces = res["data"]
    created = 0
    already = 0
    for ws in workspaces:
        if ws.get("billing_account_id"):
            already += 1
            continue
        account_id = str(uuid.uuid4())
        payload: dict = {
            "id": account_id,
            "workspace_id": ws["id"],
            "payment_mode": "none",
            # NOT NULL on the account; default to free when the workspace had no
            # tier so the column is never null.
            "tier": ws.get("tier") or "free",
            # NOT NULL with snapshot default false; mirror the workspace flag.
            "pre_warning_sent": bool(ws.get("pre_warning_sent")),
        }
        # Nullable commercial fields: copy only when present.
        for f in ("tier_expires_at", "downgraded_at", "downgraded_from_tier",
                  "percent_discount", "type_discount"):
            if ws.get(f) is not None:
                payload[f] = ws[f]
        dx.post("/items/billing_account", payload)
        dx.patch(f"/items/workspace/{ws['id']}", {"billing_account_id": account_id})
        created += 1
        print(f"    workspace {ws['id']} -> account {account_id} (tier={payload['tier']})")
    return created, already


def verify(dx: Directus) -> int:
    """Return the number of workspaces still missing an account."""
    res = dx.get("/items/workspace?limit=-1&fields=id,billing_account_id")
    return sum(1 for ws in res["data"] if not ws.get("billing_account_id"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-u", "--url", required=True)
    ap.add_argument("-e", "--email", required=True)
    ap.add_argument("-p", "--password", required=True)
    ap.add_argument("--dry-run", action="store_true",
                    help="report changes without writing")
    args = ap.parse_args()

    print(f"Authenticating to {args.url} ...")
    token = login(args.url, args.email, args.password)
    dx = Directus(args.url, token, dry_run=args.dry_run)

    print("Step 1/4: billing_account collection")
    ensure_collection(dx)
    print("Step 2/4: billing_account fields")
    ensure_fields(dx)
    print("        : billing_account relations")
    ensure_relations(dx)
    print("Step 3/4: workspace.billing_account_id pointer")
    ensure_workspace_pointer(dx)
    print("Step 4/4: 1:1 backfill")
    created, already = backfill(dx)
    print(f"  backfilled {created} workspace(s); {already} already had an account")

    if args.dry_run:
        print("\nDry run complete. No changes written.")
        return 0

    remaining = verify(dx)
    if remaining:
        print(f"\nWARNING: {remaining} workspace(s) still have no billing_account_id.")
        return 1
    print("\nAll workspaces have a billing account. Safe to run `sync.sh push`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
