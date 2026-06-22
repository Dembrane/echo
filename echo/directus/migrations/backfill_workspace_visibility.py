#!/usr/bin/env python3
"""Idempotent backfill for workspace.visibility (retire inherit_organisation_admins).

The `visibility` enum column ('open_to_organisation' | 'private') is the source
of truth for workspace privacy. `inheritance.workspace_follows_organisation_admins`
reads it first and only falls back to the legacy `settings.inherit_organisation_admins`
JSON flag when visibility is NULL (pre-enum rows).

Once every row has a non-NULL visibility, that fallback is dead and the legacy
flag can be removed (a later "contract" step). This script performs the
behavior-preserving 1:1 backfill:

  For every workspace with visibility NULL/empty, set visibility from the legacy
  flag: settings.inherit_organisation_admins is False -> 'private', otherwise
  'open_to_organisation' (the default-open rule, matrix v1.1 §9).

Idempotent: rows that already have a visibility are skipped, so re-running is a
no-op. No schema change — the visibility column already exists in the snapshot.

Usage:
  python3 backfill_workspace_visibility.py \
      -u https://directus.echo-next.dembrane.com \
      -e admin@dembrane.com -p '<password>'

  # dry run (no writes, just report what would change):
  python3 backfill_workspace_visibility.py -u ... -e ... -p ... --dry-run
"""

from __future__ import annotations

import sys
import json
import argparse
import urllib.error
import urllib.request

OPEN = "open_to_organisation"
PRIVATE = "private"


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

    def patch(self, path: str, body: dict) -> dict:
        if self.dry_run:
            print(f"    [dry-run] PATCH {path} {json.dumps(body)}")
            return {}
        return self._request("PATCH", path, body)


def login(base_url: str, email: str, password: str) -> str:
    url = f"{base_url.rstrip('/')}/auth/login"
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())["data"]["access_token"]


def visibility_from_legacy(ws: dict) -> str:
    """Mirror inheritance.workspace_follows_organisation_admins' legacy fallback:
    default open unless the legacy flag is explicitly False."""
    settings = ws.get("settings")
    if not isinstance(settings, dict):
        settings = {}
    follows_admins = settings.get("inherit_organisation_admins", True)
    return OPEN if follows_admins else PRIVATE


def backfill(dx: Directus) -> tuple[int, int]:
    """Set visibility from the legacy flag for every row missing one.
    Returns (updated, already_set)."""
    res = dx.get("/items/workspace?limit=-1&fields=id,visibility,settings")
    workspaces = res["data"]
    updated = 0
    already = 0
    for ws in workspaces:
        if ws.get("visibility"):
            already += 1
            continue
        vis = visibility_from_legacy(ws)
        dx.patch(f"/items/workspace/{ws['id']}", {"visibility": vis})
        updated += 1
        print(f"    workspace {ws['id']} -> visibility={vis}")
    return updated, already


def verify(dx: Directus) -> int:
    """Return the number of workspaces still missing a visibility."""
    res = dx.get("/items/workspace?limit=-1&fields=id,visibility")
    return sum(1 for ws in res["data"] if not ws.get("visibility"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-u", "--url", required=True)
    ap.add_argument("-e", "--email", required=True)
    ap.add_argument("-p", "--password", required=True)
    ap.add_argument("--dry-run", action="store_true", help="report changes without writing")
    args = ap.parse_args()

    print(f"Authenticating to {args.url} ...")
    token = login(args.url, args.email, args.password)
    dx = Directus(args.url, token, dry_run=args.dry_run)

    print("Backfilling workspace.visibility from legacy flag ...")
    updated, already = backfill(dx)
    print(f"  set visibility on {updated} workspace(s); {already} already had one")

    if args.dry_run:
        print("\nDry run complete. No changes written.")
        return 0

    remaining = verify(dx)
    if remaining:
        print(f"\nWARNING: {remaining} workspace(s) still have no visibility.")
        return 1
    print("\nAll workspaces have a visibility. The legacy fallback is now inert.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
