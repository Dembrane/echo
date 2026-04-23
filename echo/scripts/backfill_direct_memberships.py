"""Backfill explicit `source='direct'` workspace_membership rows for every
user who currently reaches a workspace only through derivation.

Context: matrix v1.1 §5 + §6 retires the derivation model. After this script
runs + the resolver simplifies, access is stored-direct-only. This script
materialises every currently-derived user into a direct row so no one loses
access at cutover.

Two passes after the inserts land:
  1. Simplify `inheritance.user_can_access` to a direct-row lookup.
  2. Purge `workspace.settings.{inherit_team_admins, inherit_team_members,
     sticky_removed}` — the resolver no longer reads them.

Both follow in a separate commit. This script only writes rows.

STOP CONDITION per brief: dry-run default prints the proposed row count.
Do NOT run with --apply until Sameer has signed off on the count.

Usage:
    python scripts/backfill_direct_memberships.py              # dry-run
    python scripts/backfill_direct_memberships.py --dry-run    # explicit
    python scripts/backfill_direct_memberships.py --apply      # mutate
    python scripts/backfill_direct_memberships.py --csv out.csv

Environment: DIRECTUS_BASE_URL, DIRECTUS_TOKEN (falls back to
directus/.env DIRECTUS_TOKEN line).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

import requests

# Separate lockfile from migrate_inherited_to_derived — the two scripts
# target different concerns and could theoretically run sequentially
# in a cutover script; don't let one lock out the other.
_LOCK_PATH = Path("/tmp/dembrane_backfill_direct_memberships.lock")


@contextmanager
def _exclusive_lock():
    if _LOCK_PATH.exists():
        raise RuntimeError(
            f"Another backfill is already running (lock: {_LOCK_PATH}). "
            "If this is stale, remove it manually after confirming no "
            "other process is running."
        )
    _LOCK_PATH.write_text(
        f"pid={os.getpid()} started={datetime.now(timezone.utc).isoformat()}"
    )
    try:
        yield
    finally:
        try:
            _LOCK_PATH.unlink()
        except FileNotFoundError:
            pass


DIRECTUS_URL = os.environ.get("DIRECTUS_BASE_URL", "http://directus:8055")
DIRECTUS_TOKEN = os.environ.get("DIRECTUS_TOKEN", "")

if not DIRECTUS_TOKEN:
    env_path = Path(__file__).parent.parent / "directus" / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("DIRECTUS_TOKEN="):
                DIRECTUS_TOKEN = line.split("=", 1)[1].strip().strip('"').strip("'")

HEADERS = {
    "Authorization": f"Bearer {DIRECTUS_TOKEN}",
    "Content-Type": "application/json",
}


def _req(method: str, path: str, json_body: dict | None = None) -> dict | list | None:
    url = f"{DIRECTUS_URL}{path}"
    resp = requests.request(method, url, headers=HEADERS, json=json_body, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"{method} {path} → {resp.status_code}: {resp.text[:500]}")
    if resp.status_code == 204 or not resp.content:
        return None
    return resp.json()


def fetch_all(collection: str, filter_: dict, fields: list[str]) -> list[dict]:
    params = {
        "limit": -1,
        "filter": json.dumps(filter_),
        "fields": ",".join(fields),
    }
    resp = requests.get(
        f"{DIRECTUS_URL}/items/{collection}",
        headers=HEADERS,
        params=params,
        timeout=60,
    )
    if resp.status_code >= 400:
        raise RuntimeError(
            f"fetch_all {collection} failed {resp.status_code}: {resp.text[:500]}"
        )
    return resp.json().get("data", []) or []


def _settings_of(ws: dict) -> dict:
    raw = ws.get("settings")
    return raw if isinstance(raw, dict) else {}


def _follows_admins(ws: dict) -> bool:
    return _settings_of(ws).get("inherit_team_admins", True)


def _follows_members(ws: dict) -> bool:
    return _settings_of(ws).get("inherit_team_members", False)


def _sticky_user_ids(ws: dict) -> set[str]:
    raw = _settings_of(ws).get("sticky_removed") or []
    if not isinstance(raw, list):
        return set()
    return {t.get("user_id") for t in raw if isinstance(t, dict) and t.get("user_id")}


def derive_access_for_org(
    workspaces: list[dict],
    org_memberships: list[dict],
) -> list[dict]:
    """Given all workspaces in one org + that org's memberships, return a
    list of (workspace_id, user_id, role) triples that the current
    derivation model grants. Mirrors inheritance.user_can_access /
    get_effective_members for org+workspace pairs, without a direct row.

    Does not itself check for existing direct rows — caller does that.
    """
    out: list[dict] = []

    for ws in workspaces:
        if ws.get("deleted_at"):
            continue
        ws_id = ws["id"]
        sticky = _sticky_user_ids(ws)
        follows_admins = _follows_admins(ws)
        follows_members = _follows_members(ws)

        for om in org_memberships:
            if om.get("deleted_at"):
                continue
            uid = om.get("user_id")
            if not uid:
                continue
            if uid in sticky:
                continue

            role = om.get("role")

            # Team owners always derive admin (team-owner carve-out in
            # inheritance.user_can_access).
            if role == "owner":
                out.append({"workspace_id": ws_id, "user_id": uid, "role": "admin"})
                continue

            # Team admins derive admin on open workspaces only.
            if role == "admin" and follows_admins:
                out.append({"workspace_id": ws_id, "user_id": uid, "role": "admin"})
                continue

            # Team members derive member only when the workspace opts in.
            if role == "member" and follows_admins and follows_members:
                out.append({"workspace_id": ws_id, "user_id": uid, "role": "member"})

    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="Actually insert direct rows. Default is dry-run.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Explicit dry-run flag (default).")
    parser.add_argument("--csv", type=str, default=None,
                        help="Write proposed rows to CSV at this path.")
    args = parser.parse_args()
    if args.apply and args.dry_run:
        print("ERROR: --apply and --dry-run are mutually exclusive")
        return 2
    dry_run = not args.apply

    if not DIRECTUS_TOKEN:
        print("ERROR: DIRECTUS_TOKEN not set (env or directus/.env)")
        return 2

    print(f"Mode: {'DRY-RUN' if dry_run else 'APPLY'}")
    print(f"Directus: {DIRECTUS_URL}")

    health = _req("GET", "/server/health")
    if not health:
        print("ERROR: Directus /server/health returned empty")
        return 2
    print(f"Health: {health.get('status', '?')}")

    script_start_iso = datetime.now(timezone.utc).isoformat()
    print(f"Started: {script_start_iso}")
    # Idempotency: re-runs dedupe via existing direct rows; no time cutoff
    # needed since a row created mid-run will be picked up on the next run
    # (which is still a no-op if it's already direct).

    # 1. Fetch all active workspaces.
    workspaces = fetch_all(
        "workspace",
        {"deleted_at": {"_null": True}},
        ["id", "name", "org_id", "settings", "deleted_at"],
    )
    print(f"\nActive workspaces in scope: {len(workspaces)}")

    by_org: dict[str, list[dict]] = {}
    for ws in workspaces:
        oid = ws.get("org_id")
        if not oid:
            continue
        by_org.setdefault(oid, []).append(ws)

    # 2. Fetch all active org_memberships (chunk by org for clarity).
    all_om = fetch_all(
        "org_membership",
        {"deleted_at": {"_null": True}},
        ["id", "org_id", "user_id", "role", "deleted_at"],
    )
    om_by_org: dict[str, list[dict]] = {}
    for om in all_om:
        om_by_org.setdefault(om.get("org_id") or "", []).append(om)
    print(f"Active org_memberships: {len(all_om)} across {len(om_by_org)} orgs")

    # 3. Fetch all current direct rows — so we can dedupe proposals.
    direct_rows = fetch_all(
        "workspace_membership",
        {
            "source": {"_eq": "direct"},
            "deleted_at": {"_null": True},
        },
        ["workspace_id", "user_id", "role"],
    )
    direct_key = {(r["workspace_id"], r["user_id"]) for r in direct_rows}
    print(f"Existing direct rows: {len(direct_rows)}")

    # 4. Compute derivations per org + propose rows that have no direct.
    proposals: list[dict] = []
    per_org_summary: list[tuple[str, int, int]] = []  # (org_id, ws_count, propose_count)
    per_ws_summary: list[tuple[str, str, int]] = []   # (ws_id, ws_name, propose_count)

    for org_id, org_workspaces in by_org.items():
        om_list = om_by_org.get(org_id, [])
        derived = derive_access_for_org(org_workspaces, om_list)

        org_propose = 0
        per_ws_counts: dict[str, int] = {}
        for d in derived:
            key = (d["workspace_id"], d["user_id"])
            if key in direct_key:
                continue  # direct wins, no-op
            proposals.append({
                "workspace_id": d["workspace_id"],
                "user_id": d["user_id"],
                "role": d["role"],
                "org_id": org_id,
            })
            org_propose += 1
            per_ws_counts[d["workspace_id"]] = per_ws_counts.get(d["workspace_id"], 0) + 1

        per_org_summary.append((org_id, len(org_workspaces), org_propose))
        for ws in org_workspaces:
            if ws["id"] in per_ws_counts:
                per_ws_summary.append((ws["id"], ws.get("name") or "(no name)",
                                       per_ws_counts[ws["id"]]))

    # 5. Summary.
    print(f"\n=== Proposal summary ===")
    print(f"Proposed INSERT rows: {len(proposals)}")
    print(f"Affected orgs: {sum(1 for _, _, n in per_org_summary if n > 0)}")
    print(f"Affected workspaces: {len(per_ws_summary)}")

    if per_org_summary:
        print("\nPer-org:")
        for oid, ws_count, n in sorted(per_org_summary, key=lambda x: -x[2])[:20]:
            print(f"  org={oid[:8]}  workspaces={ws_count:3d}  proposed={n}")

    if per_ws_summary:
        print("\nTop workspaces by proposed rows:")
        for ws_id, ws_name, n in sorted(per_ws_summary, key=lambda x: -x[2])[:15]:
            print(f"  ws={ws_id[:8]}  name={ws_name[:40]:40s}  proposed={n}")

    if args.csv:
        with open(args.csv, "w", newline="") as f:
            w = csv.DictWriter(
                f, fieldnames=["org_id", "workspace_id", "user_id", "role"]
            )
            w.writeheader()
            w.writerows(proposals)
        print(f"\nCSV written: {args.csv}  ({len(proposals)} rows)")

    if dry_run:
        print("\nDry-run — no changes written.")
        print("Paste the proposal summary into 04-QUESTIONS-FOR-SAMEER.md")
        print("and wait for Sameer's sign-off before running with --apply.")
        return 0

    if not proposals:
        print("\nNothing to apply.")
        return 0

    # Lock only for the mutating portion.
    try:
        lock_ctx = _exclusive_lock()
        lock_ctx.__enter__()
    except RuntimeError as exc:
        print(f"ERROR: {exc}")
        return 2

    errors = 0
    written = 0
    try:
        for p in proposals:
            try:
                _req(
                    "POST",
                    "/items/workspace_membership",
                    {
                        "id": str(uuid.uuid4()),
                        "workspace_id": p["workspace_id"],
                        "user_id": p["user_id"],
                        "role": p["role"],
                        "source": "direct",
                        "is_external": False,
                    },
                )
                written += 1
            except Exception as e:
                errors += 1
                print(
                    f"  FAIL ws={p['workspace_id'][:8]} "
                    f"user={p['user_id'][:8]}: {e}"
                )
        print(f"\nWrote {written}/{len(proposals)} direct rows. Errors: {errors}")
    finally:
        lock_ctx.__exit__(None, None, None)

    if errors:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
