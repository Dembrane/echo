#!/usr/bin/env python3
"""Move conversation_reply reads to the backend and tighten its grants.

Once the participant portal reads replies through
`GET /participant/projects/{p}/conversations/{c}/replies` (backend, admin
client, project-scoped), the public read grant on `conversation_reply` is
unused, so this removes it.

The Basic User read and update grants carry `permissions: null`. The delete grant
on the same collection already scopes to the owning host:
`conversation_id.project_id.directus_user_id == $CURRENT_USER`. This applies that
same filter to read, update and create, matching how the collection is read.

RUN ORDER MATTERS. Deploy the backend endpoint and the frontend that calls it
FIRST. Only then run this, or the portal loses replies until the deploy lands.

Idempotent, dry-run by default.

  python3 lock_down_conversation_reply_grants.py -u https://directus... -t <token>          # plan
  python3 lock_down_conversation_reply_grants.py -u https://directus... -t <token> --apply   # do it
"""

from __future__ import annotations

import json
import argparse
import urllib.error
import urllib.request

COLLECTION = "conversation_reply"
PUBLIC_POLICY = "$t:public_label"
BASIC_POLICY = "Basic User Policy"
OWNER_FILTER = {
    "_and": [{"conversation_id": {"project_id": {"directus_user_id": {"_eq": "$CURRENT_USER"}}}}]
}
SCOPE_ACTIONS = {"read", "update", "create"}


class Directus:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"{method} {path} -> {exc.code}: {exc.read().decode('utf-8')[:400]}") from None

    def get(self, path: str) -> dict:
        return self._request("GET", path)

    def patch(self, path: str, body: dict) -> dict:
        return self._request("PATCH", path, body)

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
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    token = args.token or (login(args.url, args.email, args.password) if args.email and args.password else None)
    if not token:
        ap.error("provide -t TOKEN or -e EMAIL -p PASSWORD")
    d = Directus(args.url, token)

    rows = d.get(
        f"/permissions?filter[collection][_eq]={COLLECTION}"
        f"&fields=id,collection,action,policy.name,permissions&limit=200"
    )["data"]

    deletes, scopes = [], []
    for r in rows:
        name = (r.get("policy") or {}).get("name")
        if name == PUBLIC_POLICY and r["action"] == "read":
            deletes.append(r)
        elif name == BASIC_POLICY and r["action"] in SCOPE_ACTIONS and r.get("permissions") in (None, {}):
            scopes.append(r)

    for r in deletes:
        print(f"  {'delete' if args.apply else 'would delete'} public read  id={r['id']}")
    for r in scopes:
        print(f"  {'scope' if args.apply else 'would scope'}  Basic User {r['action']:6} id={r['id']}  -> owner filter")
    if not deletes and not scopes:
        print("Nothing to do: conversation_reply grants already locked down.")
        return 0

    if not args.apply:
        print("\nPlan only. Re-run with --apply once the replies endpoint is deployed.")
        return 0

    for r in deletes:
        d.delete(f"/permissions/{r['id']}")
    for r in scopes:
        d.patch(f"/permissions/{r['id']}", {"permissions": OWNER_FILTER})
    print(f"\nDeleted {len(deletes)} public grant(s), scoped {len(scopes)} Basic User grant(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
