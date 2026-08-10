#!/usr/bin/env python3
"""Idempotent migration: support_request.forwarded_at (ISSUE-034).

Nullable timestamptz stamped by the outbox forwarder
(`dembrane.tasks:task_forward_support_requests`) when a row has been
delivered to sam's support webhook with a 2xx. NULL means "not yet
forwarded"; the forwarder's filter is `status=new AND forwarded_at IS NULL`,
so at-least-once delivery falls out of the stamp being the last step.

Run against each environment's Directus, then pull the snapshot:

  python3 add_support_request_forwarded_at.py \
      -u http://localhost:8055 -e admin@dembrane.com -p admin
  cd echo/directus && bash sync.sh -u http://localhost:8055 \
      -e admin@dembrane.com -p admin pull
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class Directus:
    def __init__(self, base_url: str, token: str, dry_run: bool = False) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.dry_run = dry_run

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
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

    def post(self, path: str, body: dict[str, Any]) -> dict:
        if self.dry_run:
            print(f"    [dry-run] POST {path}")
            return {}
        return self._request("POST", path, body)

    def field_exists(self, collection: str, field: str) -> bool:
        try:
            self.get(
                f"/fields/{urllib.parse.quote(collection)}/{urllib.parse.quote(field)}"
            )
            return True
        except RuntimeError:
            return False


def login(base_url: str, email: str, password: str) -> str:
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/auth/login", data=body, method="POST"
    )
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload["data"]["access_token"]


# Same shape as `timestamp_field(...)` in add_smart_loop_phase0_schema.py —
# sort=30 lands after the reach-back columns (chat_id/app_user_id/message_id
# sit at 20-22).
FORWARDED_AT_FIELD: dict[str, Any] = {
    "collection": "support_request",
    "field": "forwarded_at",
    "type": "timestamp",
    "meta": {
        "collection": "support_request",
        "field": "forwarded_at",
        "hidden": False,
        "interface": "datetime",
        "readonly": False,
        "required": False,
        "searchable": True,
        "sort": 30,
        "special": None,
        "options": None,
        "display": "datetime",
        "display_options": {"relative": True},
        "width": "half",
    },
    "schema": {
        "name": "forwarded_at",
        "table": "support_request",
        "data_type": "timestamp with time zone",
        "default_value": None,
        "max_length": None,
        "is_nullable": True,
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-u", "--url", required=True)
    parser.add_argument("-e", "--email")
    parser.add_argument("-p", "--password")
    parser.add_argument(
        "-t",
        "--token",
        help="static admin token — alternative to email/password "
        "(deployed envs expose DIRECTUS_ADMIN_TOKEN, not a login)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.token:
        token = args.token
    elif args.email and args.password:
        token = login(args.url, args.email, args.password)
    else:
        parser.error("need either --token or --email + --password")
    dx = Directus(args.url, token, dry_run=args.dry_run)

    if dx.field_exists("support_request", "forwarded_at"):
        print("  field support_request.forwarded_at: exists, skipping")
    else:
        print("  field support_request.forwarded_at: creating")
        dx.post("/fields/support_request", FORWARDED_AT_FIELD)
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
