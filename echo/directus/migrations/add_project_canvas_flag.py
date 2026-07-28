#!/usr/bin/env python3
"""Idempotent migration: add is_canvas_enabled boolean to the project collection.

Per-project opt-in for the living canvas beta. Default false: canvas stays off
for every project until a host flips the experimental toggle in project
settings. The server enforces this flag on top of the global ENABLE_CANVAS
feature flag.

Usage:
  python3 add_project_canvas_flag.py \
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


def canvas_flag_field() -> dict:
    # Mirrors project.is_verify_enabled so the snapshot pull stays consistent.
    return {
        "collection": "project",
        "field": "is_canvas_enabled",
        "type": "boolean",
        "meta": {
            "collection": "project",
            "field": "is_canvas_enabled",
            "hidden": False,
            "interface": "boolean",
            "note": "Experimental: opt this project into the living canvas beta.",
            "readonly": False,
            "required": False,
            "searchable": True,
            "special": ["cast-boolean"],
            "width": "full",
        },
        "schema": {
            "name": "is_canvas_enabled",
            "table": "project",
            "data_type": "boolean",
            "default_value": False,
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
            "foreign_key_column": None,
        },
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

        print("Checking if is_canvas_enabled field exists on project...")
        if dx.field_exists("project", "is_canvas_enabled"):
            print("  field project.is_canvas_enabled: exists, skipping")
        else:
            print("  field project.is_canvas_enabled: creating")
            dx.post("/fields/project", canvas_flag_field())

        print("Migration complete!")
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
