#!/usr/bin/env python
"""v2 API smoke test.

Hits every authenticated GET endpoint plus safe-ish POST/PATCH paths
against the local stack, logged in as a seeded user. Each call is
classified as pass / 4xx / 5xx / skipped.

Usage:
    python scripts/smoke_test_v2.py
    python scripts/smoke_test_v2.py --user anna@seed.dembrane.dev
    python scripts/smoke_test_v2.py --api http://localhost:8000 --verbose

The server must be running. Seeded data must exist (run
scripts/seed_dev.py --all first if you get zero workspaces/orgs).
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from typing import Any, Optional

import requests

DEFAULT_API = "http://localhost:8000"
DEFAULT_DIRECTUS = "http://directus:8055"
DEFAULT_USER = "anna@seed.dembrane.dev"
DEFAULT_PASSWORD = "demo1234"


@dataclass
class TestResult:
    method: str
    path: str
    status: int
    notes: str = ""
    body_preview: str = ""


@dataclass
class Report:
    passed: list[TestResult] = field(default_factory=list)
    client_err: list[TestResult] = field(default_factory=list)
    server_err: list[TestResult] = field(default_factory=list)
    skipped: list[TestResult] = field(default_factory=list)


def login(
    session: requests.Session,
    directus_url: str,
    email: str,
    password: str,
) -> None:
    """Login via Directus in session mode.

    Our FastAPI trusts the `directus_session_token` cookie that Directus
    sets on mode=session logins. Directus is on the same host:port as
    our FastAPI through the nginx/devcontainer setup; requests.Session
    carries the cookie across the two hostnames iff they resolve to the
    same cookie jar, so we set it explicitly.
    """
    res = session.post(
        f"{directus_url}/auth/login",
        json={"email": email, "password": password, "mode": "session"},
        timeout=10,
    )
    res.raise_for_status()
    # Directus sets the cookie under its host; propagate it so the
    # FastAPI session check sees it on its own host.
    for cookie in session.cookies:
        if cookie.name == "directus_session_token":
            return
    # Fallback — pull token from body and set manually.
    body = res.json().get("data") or {}
    token = body.get("access_token")
    if token:
        session.cookies.set("directus_session_token", token)


def probe(
    session: requests.Session,
    api: str,
    method: str,
    path: str,
    *,
    body: Any = None,
    notes: str = "",
    report: Report,
    verbose: bool = False,
) -> TestResult:
    url = f"{api}/api{path}"
    try:
        res = session.request(method, url, json=body, timeout=20)
    except Exception as e:
        tr = TestResult(method, path, 0, f"exception: {e}", "")
        report.server_err.append(tr)
        if verbose:
            print(f"  EXC {method} {path} → {e}")
        return tr

    status = res.status_code
    preview = ""
    try:
        raw = res.json()
        preview = json.dumps(raw)[:240]
    except Exception:
        preview = res.text[:240]

    tr = TestResult(method, path, status, notes, preview)
    if 200 <= status < 300:
        report.passed.append(tr)
    elif 400 <= status < 500:
        report.client_err.append(tr)
    elif 500 <= status:
        report.server_err.append(tr)
    else:
        report.skipped.append(tr)

    if verbose:
        bucket = (
            "OK" if 200 <= status < 300
            else "4xx" if 400 <= status < 500
            else "5xx" if status >= 500
            else "??"
        )
        print(f"  {bucket} {status} {method} {path}")
        if status >= 500 or (verbose and status >= 400):
            print(f"      {preview[:200]}")

    return tr


def first_of(data: Any, key: str, default: str | None = None) -> str | None:
    if isinstance(data, dict) and data.get(key):
        return data[key]
    if isinstance(data, list) and data and isinstance(data[0], dict) and data[0].get(key):
        return data[0][key]
    if isinstance(data, dict) and isinstance(data.get("workspaces"), list):
        return first_of(data["workspaces"], key, default)
    if isinstance(data, dict) and isinstance(data.get("teams"), list):
        return first_of(data["teams"], key, default)
    return default


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=DEFAULT_API)
    ap.add_argument("--directus", default=DEFAULT_DIRECTUS)
    ap.add_argument("--user", default=DEFAULT_USER)
    ap.add_argument("--password", default=DEFAULT_PASSWORD)
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    session = requests.Session()
    print(f"Logging in as {args.user} via {args.directus}…", end=" ")
    try:
        login(session, args.directus, args.user, args.password)
        print("ok")
    except Exception as e:
        print(f"FAILED: {e}")
        return 1

    report = Report()
    def P(*a, **k):  # noqa: N802
        return probe(session, args.api, *a, report=report, verbose=args.verbose, **k)

    # ── /v2/me ──
    me = P("GET", "/v2/me")
    my_user_id = None
    try:
        body = session.get(f"{args.api}/api/v2/me", timeout=10).json()
        my_user_id = body.get("id")
    except Exception:
        pass

    P("GET", "/v2/me/invites")

    # ── /v2/workspaces ──
    ws_list_tr = P("GET", "/v2/workspaces")
    workspace_id = None
    org_id = None
    try:
        body = session.get(f"{args.api}/api/v2/workspaces", timeout=10).json()
        workspace_id = first_of(body.get("workspaces"), "id")
        org_id = first_of(body.get("workspaces"), "org_id") or first_of(body.get("teams"), "id")
    except Exception:
        pass

    P("GET", "/v2/workspaces/tier-capacities")

    if workspace_id:
        P("GET", f"/v2/workspaces/{workspace_id}/settings")
        P("GET", f"/v2/workspaces/{workspace_id}/usage")
        P("GET", f"/v2/workspaces/{workspace_id}/tier/preview-downgrade?target_tier=pioneer")
        P("GET", f"/v2/workspaces/{workspace_id}/projects")
        # Access requests list (admin-only; may 403 for non-admin)
        P("GET", f"/v2/workspaces/{workspace_id}/access-requests")
        # upgrade request is destructive (sends email) but rate-limited & idempotent-ish;
        # skip in smoke to not spam.
    else:
        report.skipped.append(TestResult("GET", "/v2/workspaces/:id/settings", 0, "no workspace"))

    # ── /v2/orgs ──
    P("GET", "/v2/orgs")
    if org_id:
        P("GET", f"/v2/orgs/{org_id}")
        P("GET", f"/v2/orgs/{org_id}/members")
        P("GET", f"/v2/orgs/{org_id}/workspaces")
        P("GET", f"/v2/orgs/{org_id}/usage")
        P("GET", f"/v2/orgs/{org_id}/projects")
    else:
        report.skipped.append(TestResult("GET", "/v2/orgs/:id", 0, "no org"))

    # ── /v2/notifications ──
    P("GET", "/v2/notifications")
    P("GET", "/v2/notifications/unread-count")

    # ── /v2/projects ──
    project_id = None
    if workspace_id:
        try:
            body = session.get(
                f"{args.api}/api/v2/workspaces/{workspace_id}/projects", timeout=10
            ).json()
            items = body if isinstance(body, list) else body.get("projects") or body.get("items")
            if items:
                project_id = items[0].get("id")
        except Exception:
            pass
    if project_id:
        P("GET", f"/v2/projects/{project_id}")
        P("GET", f"/v2/projects/{project_id}/members")

    # ── /templates (v1 — still in use) ──
    P("GET", "/templates/prompt-templates")
    if workspace_id:
        P("GET", f"/templates/prompt-templates?workspace_id={workspace_id}")
    P("GET", "/templates/quick-access")

    # ── Report ──
    print()
    print(f"  pass: {len(report.passed)}")
    print(f"   4xx: {len(report.client_err)}")
    print(f"   5xx: {len(report.server_err)}")
    print(f"  skip: {len(report.skipped)}")

    if report.server_err:
        print("\n5xx detail:")
        for tr in report.server_err:
            print(f"  {tr.status} {tr.method} {tr.path}")
            print(f"      {tr.body_preview[:200]}")
    if report.client_err and args.verbose:
        print("\n4xx detail:")
        for tr in report.client_err:
            print(f"  {tr.status} {tr.method} {tr.path}")
            print(f"      {tr.body_preview[:200]}")

    return 1 if report.server_err else 0


if __name__ == "__main__":
    sys.exit(main())
