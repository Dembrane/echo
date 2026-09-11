#!/usr/bin/env python3
"""Idempotent migration: share the announcement read grant with every app role.

The announcement, announcement_translations and announcement_activity read
permissions used to live only on the Basic User Policy, and that policy is
attached to the Basic User role alone. Every signed-in user on the Enterprise
User or Read-Only role got a Directus FORBIDDEN response the moment the sidebar
inbox polled for announcements, so those accounts saw no announcements and no
unread count.

This script creates a dedicated read-only "Announcements" policy and attaches
it to the Enterprise User and Read-Only roles. The policy grants read on the
announcement content plus read/create/update on the per-user activity rows, so
the inbox and its unread count work while announcement content stays read-only.
Basic User keeps its own grant and is left untouched.

Run it against a Directus instance, then pull the schema so the sync snapshot
matches:

  python3 add_announcement_read_policy.py \
      -u http://directus:8055 -e admin@dembrane.com -p admin
  cd .. && bash sync.sh -u http://directus:8055 -e admin@dembrane.com -p admin pull

Usage:
  python3 add_announcement_read_policy.py \
      -u http://directus:8055 -e admin@dembrane.com -p admin [--dry-run]
"""

from __future__ import annotations

import sys
import json
import argparse
import urllib.error
import urllib.parse
import urllib.request

POLICY_NAME = "Announcements"

# Roles that load the app but were missing the announcement grant. Basic User
# already has it through its own policy, so it is not listed here.
TARGET_ROLE_NAMES = ["Enterprise User", "Read-Only"]

CURRENT_USER = {"_and": [{"user_id": {"_eq": "$CURRENT_USER"}}]}

ACTIVITY_FIELDS = [
    "id",
    "user_created",
    "created_at",
    "sort",
    "updated_at",
    "user_updated",
    "user_id",
    "read",
    "announcement_activity",
]


def permission_rows(policy_id: str) -> list[dict]:
    """The exact grants the sidebar inbox needs, scoped to the current user."""
    return [
        {
            "policy": policy_id,
            "collection": "announcement",
            "action": "read",
            "permissions": {
                "_or": [
                    {"expires_at": {"_gte": "$NOW"}},
                    {"expires_at": {"_null": True}},
                ]
            },
            "validation": None,
            "presets": None,
            "fields": ["*"],
        },
        {
            "policy": policy_id,
            "collection": "announcement_translations",
            "action": "read",
            "permissions": None,
            "validation": None,
            "presets": None,
            "fields": ["id", "message", "title", "languages_code", "announcement_id"],
        },
        {
            "policy": policy_id,
            "collection": "announcement_activity",
            "action": "read",
            "permissions": CURRENT_USER,
            "validation": None,
            "presets": None,
            "fields": ACTIVITY_FIELDS,
        },
        {
            "policy": policy_id,
            "collection": "announcement_activity",
            "action": "create",
            "permissions": None,
            "validation": CURRENT_USER,
            "presets": None,
            "fields": ACTIVITY_FIELDS,
        },
        {
            "policy": policy_id,
            "collection": "announcement_activity",
            "action": "update",
            "permissions": CURRENT_USER,
            "validation": None,
            "presets": None,
            "fields": ACTIVITY_FIELDS,
        },
    ]


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
            print(f"    [dry-run] POST {path} {json.dumps(body)}")
            return {"data": {"id": "dry-run"}}
        return self._request("POST", path, body)

    def role_id(self, name: str) -> str:
        q = f"/roles?filter[name][_eq]={urllib.parse.quote(name)}&fields=id&limit=1"
        data = self.get(q).get("data", [])
        if not data:
            raise RuntimeError(f"role not found: {name}")
        return data[0]["id"]

    def find_policy(self, name: str) -> str | None:
        q = f"/policies?filter[name][_eq]={urllib.parse.quote(name)}&fields=id&limit=1"
        data = self.get(q).get("data", [])
        return data[0]["id"] if data else None

    def has_access(self, policy_id: str, role_id: str) -> bool:
        q = (
            f"/access?filter[policy][_eq]={policy_id}"
            f"&filter[role][_eq]={role_id}&fields=id&limit=1"
        )
        return bool(self.get(q).get("data", []))

    def has_permission(self, policy_id: str, collection: str, action: str) -> bool:
        q = (
            f"/permissions?filter[policy][_eq]={policy_id}"
            f"&filter[collection][_eq]={collection}"
            f"&filter[action][_eq]={action}&fields=id&limit=1"
        )
        return bool(self.get(q).get("data", []))


def login(base_url: str, email: str, password: str) -> str:
    url = f"{base_url.rstrip('/')}/auth/login"
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())["data"]["access_token"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-u", "--url", required=True)
    ap.add_argument("-e", "--email", required=True)
    ap.add_argument("-p", "--password", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        print(f"Logging in to {args.url} as {args.email}...")
        tok = login(args.url, args.email, args.password)
        dx = Directus(args.url, tok, dry_run=args.dry_run)

        print(f"Resolving roles: {', '.join(TARGET_ROLE_NAMES)}...")
        role_ids = {name: dx.role_id(name) for name in TARGET_ROLE_NAMES}

        policy_id = dx.find_policy(POLICY_NAME)
        if policy_id:
            print(f"  policy {POLICY_NAME!r}: exists ({policy_id}), reusing")
        else:
            print(f"  policy {POLICY_NAME!r}: creating")
            policy_id = dx.post(
                "/policies",
                {
                    "name": POLICY_NAME,
                    "icon": "campaign",
                    "description": "Read dembrane announcements and track read state.",
                    "ip_access": None,
                    "enforce_tfa": False,
                    "admin_access": False,
                    "app_access": False,
                },
            )["data"]["id"]

        for name, rid in role_ids.items():
            if dx.has_access(policy_id, rid):
                print(f"  access {name}: exists, skipping")
            else:
                print(f"  access {name}: attaching policy")
                dx.post("/access", {"policy": policy_id, "role": rid})

        for row in permission_rows(policy_id):
            key = f"{row['collection']}:{row['action']}"
            if dx.has_permission(policy_id, row["collection"], row["action"]):
                print(f"  permission {key}: exists, skipping")
            else:
                print(f"  permission {key}: creating")
                dx.post("/permissions", row)

        print("Migration complete!")
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
