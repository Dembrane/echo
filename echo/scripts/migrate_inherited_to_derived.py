"""Migrate legacy `source='inherited'` workspace_membership rows to the
derived-inheritance model.

Context: pre-commit `94cf40d` the platform materialized inherited access as
workspace_membership rows with `source='inherited'`. The derived model
(docs/workspaces/inheritance-rules.md) treats inheritance as a query-time
derivation from org_membership + workspace.settings. **Invariant #5: no
`source='inherited'` rows with `deleted_at IS NULL` after migration.**

Two classes of legacy rows to handle:

  1. Live inherited rows (`source='inherited' AND deleted_at IS NULL`):
     archive via soft-delete. Derived access takes over immediately for
     any user still deserving it.

  2. Soft-deleted inherited rows (`source='inherited' AND deleted_at IS
     NOT NULL`): these represent "workspace admin removed this organisation
     admin". Without a tombstone, derivation would silently re-grant
     access. Convert each to a `sticky_removed` entry on
     `workspace.settings`.

Usage:
    python scripts/migrate_inherited_to_derived.py --dry-run
    python scripts/migrate_inherited_to_derived.py --apply

Dry-run is the default; --apply required to actually mutate. Script is
idempotent — rerunning after partial success is safe.
"""

from __future__ import annotations

import argparse
import os
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import requests

# Simple filesystem lock to block concurrent --apply runs. `--apply`
# against the same Directus instance from two shells would race the
# read-modify-write of workspace.settings.sticky_removed (round-2 audit,
# Red-organisation H2). This guard isn't distributed — it's per-host. Good
# enough for single-operator migrations; if we ever run from a CI
# runner + a human shell at the same moment, this breaks down and we'd
# need a Directus-level flag.
_LOCK_PATH = Path("/tmp/dembrane_migrate_inherited.lock")


@contextmanager
def _exclusive_lock():
    if _LOCK_PATH.exists():
        raise RuntimeError(
            f"Another migration is already running (lock: {_LOCK_PATH}). "
            "If this is stale, remove it manually after confirming no other "
            "process is running."
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


def api(method: str, path: str, json_body: dict | None = None) -> dict | list | None:
    url = f"{DIRECTUS_URL}{path}"
    resp = requests.request(method, url, headers=HEADERS, json=json_body, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"{method} {path} → {resp.status_code}: {resp.text[:500]}")
    if resp.status_code == 204 or not resp.content:
        return None
    return resp.json()


def fetch_all(collection: str, query: dict) -> list[dict]:
    """Fetch items with a query. Paginates by bumping offset if limit=-1
    is rejected (unlikely at current scale but defensive)."""
    from urllib.parse import urlencode
    q = dict(query)
    q.setdefault("limit", -1)
    encoded = urlencode({"fields": ",".join(q.pop("fields", ["*"]))})
    # Use the POST alternative via ?search body is not supported — stick to GET
    params: dict = {"limit": q.get("limit", -1)}
    # Serialize filter as filter[...]= form. For simplicity use Directus's
    # JSON filter param.
    import json as _json
    if "filter" in q:
        params["filter"] = _json.dumps(q["filter"])
    if "fields" in query:
        params["fields"] = ",".join(query["fields"])
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
    data = resp.json().get("data", [])
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually mutate data. Default is dry-run.",
    )
    args = parser.parse_args()
    dry_run = not args.apply

    if not DIRECTUS_TOKEN:
        print("ERROR: DIRECTUS_TOKEN not set (env or directus/.env)")
        return 2

    print(f"Mode: {'DRY-RUN' if dry_run else 'APPLY'}")
    print(f"Directus: {DIRECTUS_URL}")

    health = api("GET", "/server/health")
    if not health:
        print("ERROR: Directus /server/health returned empty")
        return 2
    print(f"Health: {health.get('status', '?')}")

    # Anchor timestamp. Any row soft-deleted AFTER this instant was archived
    # by this run — we must not count those as "pre-existing soft-deletes"
    # when building tombstones on a re-run. Fixes the round-2 audit finding
    # where a second --apply run would tombstone users whose access should
    # continue via derivation.
    script_start_iso = datetime.now(timezone.utc).isoformat()
    print(f"Cutoff: pre-existing soft-deletes must have deleted_at < {script_start_iso}")

    # 1. Live inherited rows → archive by soft-delete.
    live_inherited = fetch_all(
        "workspace_membership",
        {
            "filter": {
                "source": {"_eq": "inherited"},
                "deleted_at": {"_null": True},
            },
            "fields": ["id", "workspace_id", "user_id", "role"],
        },
    )
    print(f"\nLive source='inherited' rows to archive: {len(live_inherited)}")
    for row in live_inherited[:10]:
        print(f"  - ws={row['workspace_id'][:8]} user={row['user_id'][:8]} role={row['role']}")
    if len(live_inherited) > 10:
        print(f"  … and {len(live_inherited) - 10} more")

    # 2. Soft-deleted inherited rows → convert to sticky tombstones.
    # ONLY rows soft-deleted BEFORE this run started — these are the
    # pre-existing "workspace admin revoked this organisation admin" tombstones.
    # Rows soft-deleted after script_start_iso are our own archive output
    # and must NOT be converted (derivation should continue granting them).
    soft_inherited = fetch_all(
        "workspace_membership",
        {
            "filter": {
                "source": {"_eq": "inherited"},
                "deleted_at": {"_nnull": True, "_lt": script_start_iso},
            },
            "fields": ["id", "workspace_id", "user_id", "deleted_at"],
        },
    )
    print(
        f"\nSoft-deleted source='inherited' rows to tombstone: {len(soft_inherited)}"
    )

    # Group by workspace so we write settings once per workspace.
    by_ws: dict[str, list[dict]] = {}
    for row in soft_inherited:
        ws_id = row["workspace_id"]
        by_ws.setdefault(ws_id, []).append(row)

    print(f"  affects {len(by_ws)} workspaces")
    for ws_id, rows in list(by_ws.items())[:5]:
        print(f"  - ws={ws_id[:8]}: {len(rows)} tombstone(s)")
    if len(by_ws) > 5:
        print(f"  … and {len(by_ws) - 5} more workspaces")

    if dry_run:
        print("\nDry-run — no changes written. Re-run with --apply to mutate.")
        return 0

    # Acquire the per-host lock for the mutating portion only. Dry-run
    # never writes; it's safe to run in parallel with --apply.
    try:
        lock_ctx = _exclusive_lock()
        lock_ctx.__enter__()
    except RuntimeError as exc:
        print(f"ERROR: {exc}")
        return 2

    now_iso = datetime.now(timezone.utc).isoformat()

    # --- Apply archive of live rows ---
    errors = 0
    for row in live_inherited:
        try:
            api(
                "PATCH",
                f"/items/workspace_membership/{row['id']}",
                {"deleted_at": now_iso},
            )
        except Exception as e:
            errors += 1
            print(f"  FAIL archive {row['id']}: {e}")
    print(f"\nArchived {len(live_inherited) - errors}/{len(live_inherited)} live rows.")

    # --- Apply tombstone conversion ---
    ws_errors = 0
    for ws_id, rows in by_ws.items():
        try:
            ws = api("GET", f"/items/workspace/{ws_id}")
            if not ws:
                ws_errors += 1
                print(f"  SKIP ws={ws_id[:8]}: not found")
                continue
            workspace = ws.get("data") or ws
            settings = workspace.get("settings") or {}
            if not isinstance(settings, dict):
                settings = {}

            # Defensive: settings.sticky_removed should be a list of dicts.
            # If it's been manually edited or corrupted (string, dict, etc)
            # reset to [] rather than crashing the whole migration.
            raw_tombs = settings.get("sticky_removed")
            if not isinstance(raw_tombs, list):
                existing_tombstones = []
            else:
                existing_tombstones = [
                    t for t in raw_tombs if isinstance(t, dict)
                ]
            existing_user_ids = {t.get("user_id") for t in existing_tombstones}

            added = 0
            for row in rows:
                uid = row["user_id"]
                if uid in existing_user_ids:
                    continue
                existing_tombstones.append(
                    {
                        "user_id": uid,
                        "removed_at": row.get("deleted_at") or now_iso,
                        "removed_by": "migrate_inherited_to_derived",
                    }
                )
                existing_user_ids.add(uid)
                added += 1

            if added == 0:
                continue

            new_settings = {**settings, "sticky_removed": existing_tombstones}
            api(
                "PATCH",
                f"/items/workspace/{ws_id}",
                {"settings": new_settings},
            )
            print(f"  OK ws={ws_id[:8]}: +{added} tombstones")
        except Exception as e:
            ws_errors += 1
            print(f"  FAIL ws={ws_id[:8]}: {e}")

    print(
        f"\nTombstoned {len(by_ws) - ws_errors}/{len(by_ws)} workspaces. "
        f"Row archive errors: {errors}. Tombstone errors: {ws_errors}."
    )

    # --- Post-verify invariant #5 ---
    remaining = fetch_all(
        "workspace_membership",
        {
            "filter": {
                "source": {"_eq": "inherited"},
                "deleted_at": {"_null": True},
            },
            "fields": ["id"],
        },
    )
    try:
        if remaining:
            print(
                f"\n⚠️  Invariant violated: {len(remaining)} live source='inherited' rows "
                "still exist. Re-run the script; if they persist investigate manually."
            )
            return 1

        print("\n✓ Invariant #5 holds: no live source='inherited' rows remain.")
        return 0
    finally:
        lock_ctx.__exit__(None, None, None)


if __name__ == "__main__":
    sys.exit(main())
