#!/usr/bin/env python3
"""Remove unused Basic User grants left behind by the BFF migration.

Reads and writes for `verification_topic`, `project_chat_message_conversation`
and `directus_revisions` go through the backend BFF, which uses an admin client,
so the Basic User policy grants on these collections are unused. This removes
them to keep the policy set minimal and matched to how the app reads. The
frontend makes no user-token Directus call to any of the three, so removing the
grants changes no working flow.

This does not touch `conversation_reply`, which is handled separately.

Idempotent: it deletes only the permission rows it finds on the named policy and
collections, and is a no-op on a second run. Dry-run by default.

  python3 remove_leftover_basic_user_grants.py -u https://directus... -t <token>          # plan
  python3 remove_leftover_basic_user_grants.py -u https://directus... -t <token> --apply   # do it
"""

from __future__ import annotations

import sys
import json
import argparse
import urllib.error
import urllib.parse
import urllib.request

POLICY_NAME = "Basic User Policy"
COLLECTIONS = ["verification_topic", "project_chat_message_conversation", "directus_revisions"]


class Directus:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _request(self, method: str, path: str) -> dict:
        request = urllib.request.Request(f"{self.base_url}{path}", method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(request) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"{method} {path} -> {exc.code}: {exc.read().decode('utf-8')[:400]}") from None

    def get(self, path: str) -> dict:
        return self._request("GET", path)

    def delete(self, path: str) -> dict:
        return self._request("DELETE", path)


def login(base_url: str, email: str, password: str) -> str:
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    request = urllib.request.Request(f"{base_url.rstrip('/')}/auth/login", data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))["data"]["access_token"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-u", "--url", required=True)
    ap.add_argument("-t", "--token")
    ap.add_argument("-e", "--email")
    ap.add_argument("-p", "--password")
    ap.add_argument("--apply", action="store_true", help="perform the deletes (default: plan only)")
    args = ap.parse_args()

    token = args.token or (login(args.url, args.email, args.password) if args.email and args.password else None)
    if not token:
        ap.error("provide -t TOKEN or -e EMAIL -p PASSWORD")
    d = Directus(args.url, token)

    collections_filter = urllib.parse.quote(",".join(COLLECTIONS))
    rows = d.get(
        f"/permissions?filter[collection][_in]={collections_filter}"
        f"&fields=id,collection,action,policy.name,permissions&limit=200"
    )["data"]

    targets = [r for r in rows if (r.get("policy") or {}).get("name") == POLICY_NAME]
    if not targets:
        print("Nothing to do: no Basic User Policy grants on", ", ".join(COLLECTIONS))
        return 0

    for r in targets:
        scoped = "SCOPED" if r.get("permissions") not in (None, {}) else "UNSCOPED"
        print(f"  {'delete' if args.apply else 'would delete'} id={r['id']:<5} {r['collection']:35} {r['action']:7} [{scoped}]")

    scoped_rows = [r for r in targets if r.get("permissions") not in (None, {})]
    if scoped_rows:
        print("REFUSING: one or more grants carry a row filter; review before removing.")
        return 1

    if not args.apply:
        print(f"\nPlan only. {len(targets)} rows would be deleted. Re-run with --apply.")
        return 0

    for r in targets:
        d.delete(f"/permissions/{r['id']}")
    print(f"\nDeleted {len(targets)} permission rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
