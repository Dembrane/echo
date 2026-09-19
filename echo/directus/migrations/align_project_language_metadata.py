#!/usr/bin/env python3
"""Idempotently align project.language dropdown metadata with application support.

This changes Directus admin metadata only. The varchar stays nullable and the
legacy ``multi`` choice remains available, so existing ``multi`` and null rows
are preserved.

Usage:
  python3 align_project_language_metadata.py \
      -u http://directus:8055 -e admin@dembrane.com -p admin

After applying locally, pull the canonical snapshot with directus/sync.sh as
described in AGENTS.md. Do not hand-edit the snapshot.
"""

from __future__ import annotations

import sys
import json
import argparse
import urllib.error
import urllib.request
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import Any

CHOICES = [
    {"text": "English", "value": "en"},
    {"text": "Dutch", "value": "nl"},
    {"text": "German", "value": "de"},
    {"text": "French", "value": "fr"},
    {"text": "Spanish", "value": "es"},
    {"text": "Italian", "value": "it"},
    {"text": "Ukrainian", "value": "uk"},
    {"text": "Czech", "value": "cs"},
    {"text": "Multilingual (legacy)", "value": "multi"},
]


class Directus:
    def __init__(self, base_url: str, token: str, dry_run: bool = False):
        self.base = base_url.rstrip("/")
        self.token = token
        self.dry_run = dry_run

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(f"{self.base}{path}", data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8")
            raise RuntimeError(f"{method} {path} -> {exc.code}: {detail}") from None

    def get(self, path: str) -> dict:
        return self._request("GET", path)

    def patch(self, path: str, body: dict[str, Any]) -> dict:
        if self.dry_run:
            print(f"  [dry-run] PATCH {path}")
            return {}
        return self._request("PATCH", path, body)


def login(base_url: str, email: str, password: str) -> str:
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/auth/login", data=body, method="POST"
    )
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))["data"]["access_token"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-u", "--url", required=True)
    parser.add_argument("-e", "--email", required=True)
    parser.add_argument("-p", "--password", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        token = login(args.url, args.email, args.password)
        directus = Directus(args.url, token, dry_run=args.dry_run)
        response = directus.get("/fields/project/language")
        field = response.get("data") or response
        options = (field.get("meta") or {}).get("options") or {}
        current = options.get("choices") or []
        if current == CHOICES:
            print("project.language choices already aligned")
            return 0
        directus.patch(
            "/fields/project/language",
            {"meta": {"options": {**options, "choices": CHOICES}}},
        )
        print("project.language choices aligned; existing values were not changed")
        return 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
