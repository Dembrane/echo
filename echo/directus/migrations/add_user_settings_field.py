#!/usr/bin/env python3
"""Idempotent migration: add settings JSON field to app_user collection.

Usage:
  python3 add_user_settings_field.py \
      -u http://directus:8055 -e admin@dembrane.com -p admin
"""

from __future__ import annotations

import sys
import json
import argparse
import urllib.error
import urllib.request


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

    def field_exists(self, collection: str, field: str) -> bool:
        try:
            self.get(f"/fields/{collection}/{field}")
            return True
        except RuntimeError:
            return False


def login(base_url: str, email: str, password: str) -> str:
    url = f"{base_url.rstrip('/')}/auth/login"
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())["data"]["access_token"]


def settings_field() -> dict:
    return {
        "collection": "app_user",
        "field": "settings",
        "type": "json",
        "meta": {
            "collection": "app_user",
            "field": "settings",
            "hidden": false,
            "interface": "input-code",
            "note": "User-specific settings JSON (e.g. feature flags, UI preferences).",
            "readonly": False,
            "required": False,
            "searchable": True,
            "sort": 10,
            "special": None,
            "width": "full",
            "options": {
                "language": "json"
            }
        },
        "schema": {
            "name": "settings",
            "table": "app_user",
            "data_type": "json",
            "default_value": None,
            "max_length": None,
            "numeric_precision": None,
            "numeric_scale": None,
            "is_nullable": True,
            "is_unique": False,
            "is_indexed": False,
            "is_primary_key": False,
            "is_generated": False,
            "generation_expression": None,
            "has_auto_increment": False,
            "foreign_key_table": None,
            "foreign_key_column": None
        }
    }


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

        print("Checking if settings field exists on app_user...")
        if dx.field_exists("app_user", "settings"):
            print("  field app_user.settings: exists, skipping")
        else:
            print("  field app_user.settings: creating")
            dx.post("/fields/app_user", settings_field())

        print("Migration complete!")
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
