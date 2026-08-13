#!/usr/bin/env python3
"""Idempotent migration: add legal_basis and privacy_policy_url overrides to the project collection.

Usage:
  python3 add_project_legal_basis_overrides.py \
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


def legal_basis_field() -> dict:
    return {
        "collection": "project",
        "field": "legal_basis",
        "type": "string",
        "meta": {
            "collection": "project",
            "field": "legal_basis",
            "hidden": False,
            "interface": "select-dropdown",
            "note": "Project-level legal basis override. If unset, falls back to the workspace default.",
            "readonly": False,
            "required": False,
            "searchable": True,
            "options": {
                "choices": [
                    {"text": "Consent", "value": "consent"},
                    {"text": "Client-managed", "value": "client-managed"},
                    {"text": "dembrane events", "value": "dembrane-events"}
                ]
            },
            "width": "full",
        },
        "schema": {
            "name": "legal_basis",
            "table": "project",
            "data_type": "character varying",
            "default_value": None,
            "max_length": 255,
            "is_nullable": True,
            "is_unique": False,
            "is_indexed": False,
            "is_primary_key": False,
            "is_generated": False,
        },
    }


def privacy_policy_url_field() -> dict:
    return {
        "collection": "project",
        "field": "privacy_policy_url",
        "type": "string",
        "meta": {
            "collection": "project",
            "field": "privacy_policy_url",
            "hidden": False,
            "interface": "input",
            "note": "Project-level privacy policy URL override. Required if project-level legal basis is consent-based.",
            "readonly": False,
            "required": False,
            "searchable": True,
            "width": "full",
        },
        "schema": {
            "name": "privacy_policy_url",
            "table": "project",
            "data_type": "character varying",
            "default_value": None,
            "max_length": 255,
            "is_nullable": True,
            "is_unique": False,
            "is_indexed": False,
            "is_primary_key": False,
            "is_generated": False,
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

        print("Checking if legal_basis override exists on project...")
        if dx.field_exists("project", "legal_basis"):
            print("  field project.legal_basis: exists, skipping")
        else:
            print("  field project.legal_basis: creating")
            dx.post("/fields/project", legal_basis_field())

        print("Checking if privacy_policy_url override exists on project...")
        if dx.field_exists("project", "privacy_policy_url"):
            print("  field project.privacy_policy_url: exists, skipping")
        else:
            print("  field project.privacy_policy_url: creating")
            dx.post("/fields/project", privacy_policy_url_field())

        print("Migration complete!")
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
