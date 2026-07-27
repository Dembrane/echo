#!/usr/bin/env python3
"""Idempotent migration: nullable integer conversation.token_count.

Perf phase 2: persists the transcript token count so chat context loads
read a column instead of re-fetching the transcript and re-tokenizing.
Cleared by the app whenever transcript text changes; written back on
compute. NULL means "not computed yet".

Run against a local Directus, verify, then pull + commit the snapshot
(per root AGENTS.md, never hand-write snapshot JSON):

  python3 add_conversation_token_count.py \
      -u http://localhost:8055 -e admin@dembrane.com -p admin
  docker exec -w /workspaces/echo/directus echo_devcontainer-devcontainer-1 \
      bash sync.sh -u http://directus:8055 -e admin@dembrane.com -p admin pull

Idempotent: re-running skips the field if it exists.
"""

from __future__ import annotations

import sys
import json
import argparse
import urllib.error
import urllib.request


def _request(method: str, url: str, token: str | None, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        raise RuntimeError(f"{method} {url} -> {e.code}: {detail}") from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-u", "--url", default="http://localhost:8055")
    parser.add_argument("-e", "--email", default="admin@dembrane.com")
    parser.add_argument("-p", "--password", default="admin")
    args = parser.parse_args()
    base = args.url.rstrip("/")

    login = _request(
        "POST", f"{base}/auth/login", None, {"email": args.email, "password": args.password}
    )
    token = login["data"]["access_token"]

    try:
        _request("GET", f"{base}/fields/conversation/token_count", token)
        print("ok      conversation.token_count (already exists)")
        return 0
    except RuntimeError:
        pass

    _request(
        "POST",
        f"{base}/fields/conversation",
        token,
        {
            "field": "token_count",
            "type": "integer",
            "schema": {"is_nullable": True},
            "meta": {
                "hidden": True,
                "note": "Cached transcript token count. Cleared on new transcript text.",
            },
        },
    )
    print("CREATED conversation.token_count")
    return 0


if __name__ == "__main__":
    sys.exit(main())
