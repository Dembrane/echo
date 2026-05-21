#!/usr/bin/env python
"""Matrix v1.1 conformance smoke test.

Checks that the live code + Directus schema implement the claims in
`docs/workspaces-validate/matrix.md`. Prints pass / fail per section.

What this does NOT do: run the app end-to-end. It reads server
modules + queries Directus. Run the server's v2 smoke test
(`scripts/smoke_test_v2.py`) separately for live-endpoint coverage.

Usage:
    python scripts/matrix_smoke.py
    python scripts/matrix_smoke.py --directus http://directus:8055 --token admin
"""
from __future__ import annotations

import argparse
import importlib
import os
import sys
from dataclasses import dataclass, field
from typing import Any

import requests

DEFAULT_DIRECTUS = os.environ.get("DIRECTUS_URL", "http://directus:8055")
DEFAULT_TOKEN = os.environ.get("DIRECTUS_TOKEN", "admin")

# Add server to sys.path so we can import dembrane.* directly.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))


@dataclass
class Check:
    section: str
    title: str
    passed: bool
    detail: str = ""


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    def add(self, section: str, title: str, passed: bool, detail: str = "") -> None:
        self.checks.append(Check(section, title, passed, detail))

    def summary(self) -> tuple[int, int]:
        ok = sum(1 for c in self.checks if c.passed)
        return ok, len(self.checks)

    def print(self) -> None:
        by_section: dict[str, list[Check]] = {}
        for c in self.checks:
            by_section.setdefault(c.section, []).append(c)
        for section, items in by_section.items():
            print(f"\n§ {section}")
            for c in items:
                mark = "✓" if c.passed else "✗"
                line = f"  {mark} {c.title}"
                if c.detail:
                    line += f" — {c.detail}"
                print(line)
        ok, total = self.summary()
        print(f"\n{ok}/{total} passed")


def directus(url: str, token: str, path: str) -> dict | None:
    try:
        res = requests.get(
            f"{url}{path}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        if not res.ok:
            return None
        return res.json()
    except Exception:
        return None


def check_tier_capacity(report: Report) -> None:
    """Section 1: tier capacity matrix."""
    try:
        mod = importlib.import_module("dembrane.tier_capacity")
    except Exception as e:
        report.add("1. Tier capacity", "import tier_capacity", False, str(e))
        return

    get = mod.get_capacity
    expected = {
        # (hours, seats, hour_overage_eur, seat_overage_eur, hard_block)
        "free": (1, 1, None, None, False),
        "pilot": (10, 2, None, None, False),
        "pioneer": (25, 3, 5.0, 25.0, False),
        "innovator": (50, 10, 4.0, 30.0, False),
        "changemaker": (100, 20, 3.0, 60.0, False),
        "guardian": (None, None, None, None, False),
    }
    for tier, (hours, seats, hour_over, seat_over, block) in expected.items():
        cap = get(tier)
        if cap is None:
            report.add(
                "1. Tier capacity", f"{tier}: capacity defined", False, "get_capacity returned None"
            )
            continue
        report.add(
            "1. Tier capacity",
            f"{tier}: included_hours={hours}",
            cap.included_hours == hours,
            f"got {cap.included_hours}" if cap.included_hours != hours else "",
        )
        report.add(
            "1. Tier capacity",
            f"{tier}: included_seats={seats}",
            cap.included_seats == seats,
            f"got {cap.included_seats}" if cap.included_seats != seats else "",
        )
        report.add(
            "1. Tier capacity",
            f"{tier}: hard_block_on_hours={block}",
            cap.hard_block_on_hours == block,
            f"got {cap.hard_block_on_hours}"
            if cap.hard_block_on_hours != block
            else "",
        )


def check_role_policies(report: Report) -> None:
    """Section 4 (workspace) + 5 (organisation) role x capability."""
    try:
        from dembrane.policies import ORG_ROLE_PRESETS, WORKSPACE_ROLE_PRESETS
    except Exception as e:
        report.add("4. Roles", "import policies", False, str(e))
        return

    # Matrix §4 workspace role expectations (spot-checked)
    ws_expect = {
        "member": {
            "has": ["project:create", "project:read", "project:update",
                    "conversation:delete", "chat:use", "report:generate",
                    "workspace:view_usage"],
            "hasnt": ["project:delete", "project:share", "member:invite",
                     "settings:manage", "workspace:view_invoices"],
        },
        "admin": {
            "has": ["project:create", "project:delete", "project:share",
                    "member:invite", "member:manage", "settings:manage",
                    "workspace:view_usage", "workspace:view_invoices",
                    "upgrade:request"],
            "hasnt": [],
        },
        "billing": {
            "has": ["workspace:view_usage", "workspace:view_invoices",
                    "workspace:update_payment", "upgrade:request"],
            "hasnt": ["project:create", "member:invite", "settings:manage"],
        },
    }
    for role, spec in ws_expect.items():
        preset = set(WORKSPACE_ROLE_PRESETS.get(role) or [])
        for p in spec["has"]:
            report.add(
                "4. Workspace roles",
                f"{role} has {p}",
                p in preset,
                "missing" if p not in preset else "",
            )
        for p in spec["hasnt"]:
            report.add(
                "4. Workspace roles",
                f"{role} does NOT have {p}",
                p not in preset,
                "present (should not be)" if p in preset else "",
            )

    # Matrix §5 organisation role expectations
    organisation_expect = {
        "member": {
            "has": ["org:view"],
            "hasnt": ["org:create_workspace", "org:manage_users"],
        },
        "admin": {
            "has": ["org:view", "org:create_workspace", "org:manage_users",
                    "org:view_all_workspaces", "org:view_usage"],
            "hasnt": [],
        },
        "billing": {
            "has": ["org:view", "org:view_all_workspaces", "org:view_usage",
                    "org:view_invoices", "org:update_payment"],
            "hasnt": ["org:create_workspace", "org:manage_users"],
        },
    }
    for role, spec in organisation_expect.items():
        preset = set(ORG_ROLE_PRESETS.get(role) or [])
        for p in spec["has"]:
            report.add(
                "5. Organisation roles",
                f"{role} has {p}",
                p in preset,
                "missing" if p not in preset else "",
            )
        for p in spec["hasnt"]:
            report.add(
                "5. Organisation roles",
                f"{role} does NOT have {p}",
                p not in preset,
                "present (should not be)" if p in preset else "",
            )


def check_tier_gates(report: Report) -> None:
    """Sections 2 + 3: tier-gated capabilities."""
    try:
        from dembrane.policies import TIER_REQUIRED_FOR_POLICY
    except Exception as e:
        report.add("2. Tier gates", "import policies", False, str(e))
        return

    expected = {
        "project:set_private": "innovator",
        "workspace:set_private": "innovator",
        "project:share": "innovator",
        "workspace:export": "innovator",
        "workspace:whitelabel": "changemaker",
        "workspace:api_access": "changemaker",
        "workspace:webhooks": "changemaker",
    }
    for policy, tier in expected.items():
        got = TIER_REQUIRED_FOR_POLICY.get(policy)
        report.add(
            "2. Tier gates",
            f"{policy} gated at {tier}",
            got == tier,
            f"got {got}" if got != tier else "",
        )


def check_visibility_enum(url: str, token: str, report: Report) -> None:
    """Section 6: workspace visibility."""
    f = directus(url, token, "/fields/workspace/visibility")
    if not f:
        report.add("6. Visibility", "workspace.visibility exists", False, "field missing")
        return
    data = f.get("data") or {}
    choices = (
        (data.get("meta") or {}).get("options") or {}
    ).get("choices") or []
    values = [c.get("value") for c in choices if isinstance(c, dict)]
    want = {"open_to_organisation", "private"}
    got = set(values)
    report.add(
        "6. Visibility",
        "enum is {open_to_organisation, private}",
        want == got,
        f"got {sorted(got)}" if want != got else "",
    )


def check_access_request_schema(url: str, token: str, report: Report) -> None:
    """Section 6: Slack-style discovery infra."""
    ar = directus(url, token, "/collections/access_request")
    present = bool(ar and (ar.get("data") or {}).get("collection") == "access_request")
    report.add("6. Discovery", "access_request collection exists", present)
    if not present:
        return
    idf = directus(url, token, "/fields/access_request/id")
    id_type = ((idf or {}).get("data") or {}).get("type")
    report.add(
        "6. Discovery",
        "access_request.id is uuid",
        id_type == "uuid",
        f"got {id_type}" if id_type != "uuid" else "",
    )
    # Required fields
    for fname in ("workspace_id", "user_id", "status"):
        r = directus(url, token, f"/fields/access_request/{fname}")
        report.add(
            "6. Discovery",
            f"access_request.{fname} exists",
            bool(r),
        )


def check_seats_unified(report: Report) -> None:
    """Section 7: seat counting includes guests in the unified pool."""
    try:
        with open(os.path.join(ROOT, "server", "dembrane", "seat_capacity.py")) as f:
            src = f.read()
    except Exception as e:
        report.add("7. Seats", "read seat_capacity.py", False, str(e))
        return
    # Unified model: externals (role='external') share the seat pool.
    ok = ("external" in src and "seats_used" in src)
    report.add(
        "7. Seats",
        "seat_capacity.py unifies externals into seat pool (role='external' + seats_used)",
        ok,
        "no unified seat logic found" if not ok else "",
    )


def check_hours_meter(report: Report) -> None:
    """Section 8: hours derived from conversation duration."""
    path = os.path.join(ROOT, "server", "dembrane", "api", "v2", "workspaces.py")
    try:
        with open(path) as f:
            src = f.read()
    except Exception as e:
        report.add("8. Hours", "read workspaces.py", False, str(e))
        return
    ok = "duration" in src and "audio_hours" in src
    report.add(
        "8. Hours",
        "workspaces.py usage derives audio_hours from conversation duration",
        ok,
    )
    # Calendar-month reset: search for cycle_start derivation
    ok_cycle = ("first day" in src.lower()) or ("replace(day=1" in src) or ("cycle_start" in src)
    report.add(
        "8. Hours",
        "cycle reset aligned to calendar month",
        ok_cycle,
    )


def check_pilot_hard_block(report: Report) -> None:
    """Section 8: pilot hard block enforcement exists in middleware."""
    path = os.path.join(ROOT, "server", "dembrane", "api", "v2", "middleware.py")
    try:
        with open(path) as f:
            src = f.read()
    except Exception as e:
        report.add("8. Pilot block", "read middleware.py", False, str(e))
        return
    ok = "require_no_pilot_block" in src
    report.add(
        "8. Pilot block",
        "require_no_pilot_block middleware exists",
        ok,
    )


def check_upgrade_inbox(report: Report) -> None:
    """Section 11: upgrade requests go through workspace_request collection."""
    ws_requests_path = os.path.join(
        ROOT, "server", "dembrane", "api", "v2", "workspace_requests.py"
    )
    try:
        with open(ws_requests_path) as f:
            src = f.read()
    except Exception as e:
        report.add("11. Upgrade flow", "read workspace_requests.py", False, str(e))
        return
    has_endpoint = "workspace-requests" in src or "workspace_requests" in src
    has_kinds = "new_workspace" in src and "tier_upgrade" in src
    report.add(
        "11. Upgrade flow",
        "workspace_requests.py handles new_workspace + tier_upgrade kinds",
        has_endpoint and has_kinds,
        "" if has_endpoint and has_kinds else "missing request kinds",
    )


def check_partner_model(url: str, token: str, report: Report) -> None:
    """Section 10: partner fields + referral_ledger."""
    for f in ("billed_to_team_id", "effective_client_team_id"):
        r = directus(url, token, f"/fields/workspace/{f}")
        report.add(
            "10. Partner model",
            f"workspace.{f} exists",
            bool(r),
        )
    rl = directus(url, token, "/collections/referral_ledger")
    report.add(
        "10. Partner model",
        "referral_ledger collection exists",
        bool(rl and (rl.get("data") or {}).get("collection") == "referral_ledger"),
    )
    for f in ("workspace_id", "partner_team_id", "partner_kickback_percent",
              "starts_at", "expires_at"):
        r = directus(url, token, f"/fields/referral_ledger/{f}")
        report.add(
            "10. Partner model",
            f"referral_ledger.{f} exists",
            bool(r),
        )


def check_notification_schema(url: str, token: str, report: Report) -> None:
    """Inbox: notification collection present (MEMBERSHIP_REQUESTED target)."""
    n = directus(url, token, "/collections/notification")
    report.add(
        "Inbox",
        "notification collection exists",
        bool(n and (n.get("data") or {}).get("collection") == "notification"),
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--directus", default=DEFAULT_DIRECTUS)
    ap.add_argument("--token", default=DEFAULT_TOKEN)
    args = ap.parse_args()

    report = Report()
    print(f"Checking matrix v1.1 against {args.directus}…")
    check_tier_capacity(report)
    check_tier_gates(report)
    check_role_policies(report)
    check_visibility_enum(args.directus, args.token, report)
    check_access_request_schema(args.directus, args.token, report)
    check_seats_unified(report)
    check_hours_meter(report)
    check_pilot_hard_block(report)
    check_upgrade_inbox(report)
    check_partner_model(args.directus, args.token, report)
    check_notification_schema(args.directus, args.token, report)
    report.print()
    ok, total = report.summary()
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
