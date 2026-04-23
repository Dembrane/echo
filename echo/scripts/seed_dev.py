"""Reset + seed dev Directus with a wide range of toy examples.

Covers the scenarios the workspaces release needs to demo:
- Multiple teams at different tiers
- Workspaces across pilot → changemaker, including at-cap + approaching
- Role diversity (admin / billing / member + external guest)
- Pending access requests + workspace invites
- A downgraded workspace (7-day banner state)
- Partner handoff in flight + a completed referral ledger entry
- Conversations with durations to make hour meters realistic

**Preserves** admin@dembrane.com + their existing org. Everything else
in the test collections is soft-deleted before seeding.

Usage:
    python scripts/seed_dev.py                 # dry-run by default
    python scripts/seed_dev.py --reset         # reset only
    python scripts/seed_dev.py --seed          # seed only
    python scripts/seed_dev.py --all           # reset then seed  [DESTRUCTIVE]

The --all flag is the intended "give me a fresh demo environment"
entry point. All seeded accounts use the same dev password (below).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import requests

DIRECTUS_URL = os.environ.get("DIRECTUS_BASE_URL", "http://directus:8055")
ADMIN_EMAIL = os.environ.get("SEED_ADMIN_EMAIL", "admin@dembrane.com")
ADMIN_PASSWORD = os.environ.get("SEED_ADMIN_PASSWORD", "admin")
SEED_USER_PASSWORD = os.environ.get("SEED_USER_PASSWORD", "demo1234")

BASIC_USER_ROLE_ID = "bcdd7430-2456-4feb-930c-0c9eee30a7e1"
ADMIN_POLICY_ID = "c1071295-984a-4985-95db-a1c8064a28e6"

# Directus 11: admin_access=true on a policy bypasses most collection
# permissions, BUT newly-created collections still need explicit
# permission rows before item writes land. Grant them up-front on collections
# the seed writes to.
COLLECTIONS_NEEDING_ADMIN_PERMS = [
    "referral_ledger",
    "access_request",
    "workspace_invite",
    "notification",
]

# Collections we wipe (soft-delete where deleted_at exists, hard-delete
# otherwise). Order matters for FK cascades — deepest first.
RESET_SOFT = [
    "workspace_invite",
    "access_request",
    "referral_ledger",
    "project_membership",
    "workspace_membership",
    "project",
    "workspace",
    "org_membership",
    "org",
]

# Hard-delete app_user rows created by seeds (detected via email pattern).
SEED_USER_EMAIL_PATTERNS = (
    "@seed.dembrane.dev",
)


# ── HTTP helpers ──────────────────────────────────────────────────────


def login() -> str:
    resp = requests.post(
        f"{DIRECTUS_URL}/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["data"]["access_token"]


def api(
    session: requests.Session,
    method: str,
    path: str,
    json_body: Optional[dict | list] = None,
    params: Optional[dict] = None,
) -> Any:
    url = f"{DIRECTUS_URL}{path}"
    resp = session.request(method, url, json=json_body, params=params, timeout=30)
    if resp.status_code >= 400:
        raise RuntimeError(f"{method} {path} → {resp.status_code}: {resp.text[:500]}")
    if resp.status_code == 204 or not resp.content:
        return None
    return resp.json()


def fetch_all(
    session: requests.Session,
    collection: str,
    filter_: Optional[dict] = None,
    fields: Optional[list[str]] = None,
) -> list[dict]:
    params = {"limit": -1}
    if filter_:
        params["filter"] = json.dumps(filter_)
    if fields:
        params["fields"] = ",".join(fields)
    r = session.get(
        f"{DIRECTUS_URL}/items/{collection}", params=params, timeout=30
    )
    if r.status_code >= 400:
        raise RuntimeError(f"fetch_all {collection} {r.status_code}: {r.text[:300]}")
    return r.json().get("data", []) or []


# ── Reset ─────────────────────────────────────────────────────────────


def reset_seed_data(session: requests.Session, dry_run: bool) -> None:
    """Soft-delete everything in RESET_SOFT. Skip any rows owned by the
    admin user so we don't nuke the operator's own team."""
    print("=== RESET ===")

    # Resolve admin's app_user + home org so we preserve them.
    admin_app = fetch_all(
        session, "app_user", {"email": {"_eq": ADMIN_EMAIL}}, ["id"]
    )
    admin_app_user_id = admin_app[0]["id"] if admin_app else None

    preserve_org_ids: set[str] = set()
    if admin_app_user_id:
        admin_orgs = fetch_all(
            session,
            "org_membership",
            {"user_id": {"_eq": admin_app_user_id}, "role": {"_eq": "owner"}},
            ["org_id"],
        )
        preserve_org_ids = {m["org_id"] for m in admin_orgs if m.get("org_id")}
    print(f"Preserving admin orgs: {[o[:8] for o in preserve_org_ids] or 'NONE'}")

    now_iso = datetime.now(timezone.utc).isoformat()

    # Workspaces in preserved orgs are kept. Everything else soft-deleted.
    # We soft-delete children first to keep referential sanity.

    # Workspaces to delete — not in preserved orgs.
    all_workspaces = fetch_all(
        session, "workspace", {"deleted_at": {"_null": True}},
        ["id", "org_id", "name"],
    )
    ws_to_delete = [
        w for w in all_workspaces
        if (w.get("org_id") or "") not in preserve_org_ids
    ]
    print(f"Workspaces to soft-delete: {len(ws_to_delete)}")

    ws_ids_to_delete = {w["id"] for w in ws_to_delete}

    def soft_delete_where(collection: str, filter_: dict) -> int:
        try:
            rows = fetch_all(session, collection, filter_, ["id"])
        except RuntimeError:
            return 0
        if not rows:
            return 0
        if dry_run:
            return len(rows)
        for r in rows:
            try:
                api(session, "PATCH", f"/items/{collection}/{r['id']}",
                    {"deleted_at": now_iso})
            except Exception as e:
                print(f"  FAIL soft-delete {collection}/{r['id']}: {e}")
        return len(rows)

    def hard_delete_where(collection: str, filter_: dict) -> int:
        try:
            rows = fetch_all(session, collection, filter_, ["id"])
        except RuntimeError:
            return 0
        if not rows:
            return 0
        if dry_run:
            return len(rows)
        for r in rows:
            try:
                api(session, "DELETE", f"/items/{collection}/{r['id']}")
            except Exception as e:
                print(f"  FAIL hard-delete {collection}/{r['id']}: {e}")
        return len(rows)

    # Children first. Some collections lack deleted_at — hard-delete
    # those. workspace_invite + access_request + project_membership are
    # seed-scope; no history to preserve.
    if ws_ids_to_delete:
        wid_list = list(ws_ids_to_delete)
        for coll in ("workspace_invite", "access_request", "project_membership"):
            n = hard_delete_where(coll, {"workspace_id": {"_in": wid_list}})
            print(f"  {coll}: {n} rows (hard)")
        n = soft_delete_where("workspace_membership", {
            "workspace_id": {"_in": wid_list},
            "deleted_at": {"_null": True},
        })
        print(f"  workspace_membership: {n} rows (soft)")

    # Referral ledger — reset everything (small, no cross-org preservation needed).
    n = soft_delete_where("referral_ledger", {"deleted_at": {"_null": True}})
    print(f"  referral_ledger: {n} rows")
    # Also hard-delete in case the soft column isn't read-permitted.
    n_hard = hard_delete_where("referral_ledger", {})
    if n_hard:
        print(f"  referral_ledger: {n_hard} rows (hard fallback)")

    # Conversations in doomed workspaces — find via project_id join.
    if ws_ids_to_delete:
        doomed_projects = fetch_all(
            session, "project",
            {"workspace_id": {"_in": list(ws_ids_to_delete)}, "deleted_at": {"_null": True}},
            ["id"],
        )
        if doomed_projects:
            pids = [p["id"] for p in doomed_projects]
            n = soft_delete_where(
                "conversation",
                {"project_id": {"_in": pids}, "deleted_at": {"_null": True}},
            )
            print(f"  conversation: {n} rows")
            n = soft_delete_where(
                "project",
                {"id": {"_in": pids}, "deleted_at": {"_null": True}},
            )
            print(f"  project: {n} rows")

    # Workspaces.
    if ws_ids_to_delete:
        for wid in ws_ids_to_delete:
            if dry_run:
                continue
            try:
                api(session, "PATCH", f"/items/workspace/{wid}",
                    {"deleted_at": now_iso})
            except Exception as e:
                print(f"  FAIL soft-delete workspace/{wid}: {e}")
        print(f"  workspace: {len(ws_ids_to_delete)} rows")

    # Orgs (not preserved) — soft-delete + their org_memberships.
    all_orgs = fetch_all(session, "org", {"deleted_at": {"_null": True}}, ["id"])
    orgs_to_delete = [o for o in all_orgs if o["id"] not in preserve_org_ids]
    if orgs_to_delete:
        oids = [o["id"] for o in orgs_to_delete]
        n = soft_delete_where(
            "org_membership",
            {"org_id": {"_in": oids}, "deleted_at": {"_null": True}},
        )
        print(f"  org_membership: {n} rows")
        if not dry_run:
            for oid in oids:
                try:
                    api(session, "PATCH", f"/items/org/{oid}",
                        {"deleted_at": now_iso})
                except Exception as e:
                    print(f"  FAIL soft-delete org/{oid}: {e}")
        print(f"  org: {len(oids)} rows")

    # Seed users — hard-delete by email suffix.
    for pattern in SEED_USER_EMAIL_PATTERNS:
        seeded = fetch_all(
            session, "app_user",
            {"email": {"_ends_with": pattern}},
            ["id", "email", "directus_user_id"],
        )
        if not seeded:
            continue
        print(f"  app_user ({pattern}): {len(seeded)} rows")
        if dry_run:
            continue
        for u in seeded:
            try:
                api(session, "DELETE", f"/items/app_user/{u['id']}")
            except Exception as e:
                print(f"  FAIL delete app_user/{u['id']}: {e}")
            du = u.get("directus_user_id")
            if du:
                try:
                    api(session, "DELETE", f"/users/{du}")
                except Exception as e:
                    print(f"  FAIL delete directus user/{du}: {e}")


# ── Create helpers ────────────────────────────────────────────────────


def new_uuid() -> str:
    return str(uuid.uuid4())


def ensure_admin_permissions(session: requests.Session) -> None:
    """Grant Administrator policy full CRUD on seed-touched collections.

    Idempotent — skips when a permission row already exists for the
    (collection, action, policy) triple. Directus 11 doesn't auto-grant
    admin access on newly created collections; without this, our seed
    POSTs 403 even with admin_access=true.
    """
    for collection in COLLECTIONS_NEEDING_ADMIN_PERMS:
        # Check if the collection exists first — skip silently if it doesn't
        # (shared helper used by tests + future collections).
        try:
            api(session, "GET", f"/collections/{collection}")
        except RuntimeError:
            continue
        for action in ("create", "read", "update", "delete"):
            existing = session.get(
                f"{DIRECTUS_URL}/permissions",
                params={
                    "filter": json.dumps({
                        "collection": {"_eq": collection},
                        "action": {"_eq": action},
                        "policy": {"_eq": ADMIN_POLICY_ID},
                    }),
                    "limit": 1,
                },
                timeout=15,
            )
            rows = existing.json().get("data", []) if existing.ok else []
            if rows:
                continue
            try:
                api(session, "POST", "/permissions", {
                    "collection": collection,
                    "action": action,
                    "policy": ADMIN_POLICY_ID,
                    "fields": ["*"],
                    "permissions": {},
                    "validation": {},
                    "presets": None,
                })
            except RuntimeError as e:
                print(f"  WARN grant {collection}/{action}: {e}")


def create_directus_user(
    session: requests.Session, email: str, display_name: str
) -> tuple[str, str]:
    """Returns (directus_user_id, app_user_id). Password is SEED_USER_PASSWORD."""
    parts = display_name.split(" ", 1)
    first = parts[0]
    last = parts[1] if len(parts) > 1 else ""

    # directus_users is served via /users, not /items/directus_users.
    r = session.get(
        f"{DIRECTUS_URL}/users",
        params={"filter": json.dumps({"email": {"_eq": email}}), "limit": 1},
        timeout=15,
    )
    existing = r.json().get("data", []) if r.ok else []

    if existing:
        du_id = existing[0]["id"]
    else:
        res = api(session, "POST", "/users", {
            "email": email,
            "password": SEED_USER_PASSWORD,
            "first_name": first,
            "last_name": last,
            "role": BASIC_USER_ROLE_ID,
            "status": "active",
        })
        du_id = res["data"]["id"]

    app_existing = fetch_all(
        session, "app_user",
        {"directus_user_id": {"_eq": du_id}},
        ["id"],
    )
    if app_existing:
        return du_id, app_existing[0]["id"]

    app_id = new_uuid()
    api(session, "POST", "/items/app_user", {
        "id": app_id,
        "directus_user_id": du_id,
        "email": email,
        "display_name": display_name,
    })
    return du_id, app_id


def create_org(session: requests.Session, name: str) -> str:
    oid = new_uuid()
    api(session, "POST", "/items/org", {
        "id": oid,
        "name": name,
    })
    return oid


def add_org_member(
    session: requests.Session, org_id: str, user_id: str, role: str
) -> None:
    api(session, "POST", "/items/org_membership", {
        "id": new_uuid(),
        "org_id": org_id,
        "user_id": user_id,
        "role": role,
    })


def create_workspace(
    session: requests.Session,
    org_id: str,
    name: str,
    tier: str = "pioneer",
    visibility: str = "open_to_team",
    downgraded_at: Optional[str] = None,
    downgraded_from_tier: Optional[str] = None,
) -> str:
    wid = new_uuid()
    body = {
        "id": wid,
        "org_id": org_id,
        "name": name,
        "tier": tier,
        "visibility": visibility,
        "is_default": False,
        "billed_to_team_id": org_id,
    }
    if downgraded_at:
        body["downgraded_at"] = downgraded_at
    if downgraded_from_tier:
        body["downgraded_from_tier"] = downgraded_from_tier
    api(session, "POST", "/items/workspace", body)
    return wid


def add_workspace_member(
    session: requests.Session,
    workspace_id: str,
    user_id: str,
    role: str,
    is_external: bool = False,
) -> None:
    api(session, "POST", "/items/workspace_membership", {
        "id": new_uuid(),
        "workspace_id": workspace_id,
        "user_id": user_id,
        "role": role,
        "source": "direct",
        "is_external": is_external,
    })


def create_project(
    session: requests.Session,
    workspace_id: str,
    name: str,
    directus_user_id: str,
    visibility: str = "workspace",
    language: str = "en",
) -> str:
    pid = new_uuid()
    api(session, "POST", "/items/project", {
        "id": pid,
        "workspace_id": workspace_id,
        "name": name,
        "language": language,
        "visibility": visibility,
        "directus_user_id": directus_user_id,
        "is_conversation_allowed": True,
    })
    return pid


def create_conversations(
    session: requests.Session,
    project_id: str,
    durations_seconds: list[int],
    created_recent: bool = True,
) -> None:
    """Create conversation rows with given durations. created_at defaults
    to 'recent' (this calendar month) so the hour meter picks them up."""
    now = datetime.now(timezone.utc)
    # Spread across the current month for realism.
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    for i, dur in enumerate(durations_seconds):
        ts = (
            month_start + timedelta(
                days=random.randint(0, max(1, (now - month_start).days)),
                hours=random.randint(0, 23),
            )
        ) if created_recent else (now - timedelta(days=120))
        api(session, "POST", "/items/conversation", {
            "id": new_uuid(),
            "project_id": project_id,
            "participant_name": f"Participant {i+1}",
            "duration": dur,
            "created_at": ts.isoformat(),
        })


def create_access_request(
    session: requests.Session, workspace_id: str, user_id: str
) -> None:
    # access_request.id is auto-int (Directus auto-created before our
    # add_field specified UUID; the add_field was a no-op).
    api(session, "POST", "/items/access_request", {
        "workspace_id": workspace_id,
        "user_id": user_id,
        "status": "pending",
    })


def create_workspace_invite(
    session: requests.Session,
    workspace_id: str,
    email: str,
    invited_by_user_id: str,
    role: str = "member",
) -> None:
    expires = (datetime.now(timezone.utc) + timedelta(days=14)).isoformat()
    api(session, "POST", "/items/workspace_invite", {
        "id": new_uuid(),
        "workspace_id": workspace_id,
        "email": email,
        "role": role,
        "invited_by_user_id": invited_by_user_id,
        "include_org_membership": True,
        "expires_at": expires,
        # HMAC token_hash would normally be set — skip for seed (invite
        # is surface-tested; not accepted via seed).
        "token_hash": f"seed-{new_uuid()[:16]}",
    })


def create_referral_ledger_entry(
    session: requests.Session,
    workspace_id: str,
    partner_team_id: str,
    staff_id: Optional[str],
    percent: int = 20,
    notes: Optional[str] = None,
) -> None:
    # referral_ledger.id is auto-int (same story as access_request).
    api(session, "POST", "/items/referral_ledger", {
        "workspace_id": workspace_id,
        "partner_team_id": partner_team_id,
        "partner_kickback_percent": percent,
        "notes": notes,
        "created_by_staff_id": staff_id,
    })


# ── Seed ──────────────────────────────────────────────────────────────


def seed(session: requests.Session, dry_run: bool) -> None:
    print("\n=== SEED ===")
    if dry_run:
        print("(dry-run — no writes)")
        return

    ensure_admin_permissions(session)

    # Users
    users: dict[str, tuple[str, str]] = {}  # email → (du_id, app_id)
    def mk(email: str, name: str) -> None:
        du, au = create_directus_user(session, email, name)
        users[email] = (du, au)
        print(f"  user {email} → app={au[:8]}")

    mk("anna@seed.dembrane.dev",   "Anna Bakker")
    mk("ben@seed.dembrane.dev",    "Ben Cortez")
    mk("cara@seed.dembrane.dev",   "Cara Dubois")
    mk("dan@seed.dembrane.dev",    "Dan Eriksen")
    mk("emma@seed.dembrane.dev","Emma Friedman")
    mk("finn@seed.dembrane.dev", "Finn Garcia")
    mk("grace@seed.dembrane.dev","Grace Hughes")
    mk("hank@seed.dembrane.dev","Hank Irving")

    def au(email: str) -> str: return users[email][1]
    def du(email: str) -> str: return users[email][0]

    # Admin app_user id (preserved from reset).
    admin_rows = fetch_all(
        session, "app_user", {"email": {"_eq": ADMIN_EMAIL}}, ["id"]
    )
    admin_app_id = admin_rows[0]["id"] if admin_rows else None

    # Teams
    acme = create_org(session, "Acme Research")
    add_org_member(session, acme, au("anna@seed.dembrane.dev"),   "owner")
    add_org_member(session, acme, au("ben@seed.dembrane.dev"),    "admin")
    add_org_member(session, acme, au("cara@seed.dembrane.dev"),   "member")
    add_org_member(session, acme, au("dan@seed.dembrane.dev"),    "billing")
    print(f"  team Acme Research → {acme[:8]}")

    partner = create_org(session, "Partner Consulting")
    add_org_member(session, partner, au("emma@seed.dembrane.dev"), "owner")
    print(f"  team Partner Consulting → {partner[:8]}")

    alpha = create_org(session, "Alpha Inc")
    add_org_member(session, alpha, au("hank@seed.dembrane.dev"), "owner")
    print(f"  team Alpha Inc → {alpha[:8]}")

    studio = create_org(session, "Solo Studio")
    add_org_member(session, studio, au("finn@seed.dembrane.dev"), "owner")
    print(f"  team Solo Studio → {studio[:8]}")

    # ─ Workspaces ─

    # Acme default — pioneer, healthy
    acme_default = create_workspace(session, acme, "Default", tier="pioneer")
    add_workspace_member(session, acme_default, au("anna@seed.dembrane.dev"), "owner")
    add_workspace_member(session, acme_default, au("ben@seed.dembrane.dev"),  "admin")
    add_workspace_member(session, acme_default, au("cara@seed.dembrane.dev"), "member")
    add_workspace_member(session, acme_default, au("dan@seed.dembrane.dev"),  "billing")
    p1 = create_project(session, acme_default, "Kickoff Interviews",
                        du("anna@seed.dembrane.dev"))
    create_conversations(session, p1, [1200, 1500, 2100, 1800])  # ~1.8h
    print(f"  workspace Acme / Default → healthy pioneer")

    # Acme Q1 Discovery — pioneer approaching cap (25h included, we put ~22h)
    acme_q1 = create_workspace(session, acme, "Q1 Discovery", tier="pioneer")
    add_workspace_member(session, acme_q1, au("anna@seed.dembrane.dev"), "owner")
    add_workspace_member(session, acme_q1, au("ben@seed.dembrane.dev"),  "admin")
    p2 = create_project(session, acme_q1, "Customer Panel",
                        du("anna@seed.dembrane.dev"))
    create_conversations(session, p2, [3600] * 22 + [600])  # ~22.2h → >80%
    print(f"  workspace Acme / Q1 Discovery → approaching pioneer limit")

    # Acme Privacy Research — innovator, private
    acme_private = create_workspace(session, acme, "Privacy Research",
                                     tier="innovator", visibility="private")
    add_workspace_member(session, acme_private, au("anna@seed.dembrane.dev"), "owner")
    p3 = create_project(session, acme_private, "Legal Framework",
                        du("anna@seed.dembrane.dev"), visibility="private")
    create_conversations(session, p3, [2400, 3000])
    print(f"  workspace Acme / Privacy Research → private innovator")

    # Acme Whitelabel — changemaker, downgraded 3 days ago (banner live)
    three_days_ago = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    acme_whitelabel = create_workspace(
        session, acme, "Whitelabel Project",
        tier="innovator", downgraded_at=three_days_ago,
        downgraded_from_tier="changemaker",
    )
    add_workspace_member(session, acme_whitelabel, au("anna@seed.dembrane.dev"), "owner")
    add_workspace_member(session, acme_whitelabel, au("ben@seed.dembrane.dev"),  "admin")
    create_project(session, acme_whitelabel, "Brand Rollout",
                   du("anna@seed.dembrane.dev"))
    print(f"  workspace Acme / Whitelabel → just-downgraded innovator")

    # Partner Client Alpha — handoff in flight, pioneer
    partner_alpha = create_workspace(session, partner, "Client Alpha",
                                      tier="pioneer")
    add_workspace_member(session, partner_alpha, au("emma@seed.dembrane.dev"), "owner")
    # Set handoff pending to Alpha Inc.
    api(session, "PATCH", f"/items/workspace/{partner_alpha}", {
        "handoff_status": "pending",
        "handoff_target_team_id": alpha,
    })
    pa = create_project(session, partner_alpha, "Discovery Q4",
                        du("emma@seed.dembrane.dev"))
    create_conversations(session, pa, [1800, 2400, 3000, 2100])
    print(f"  workspace Partner / Client Alpha → handoff pending → Alpha Inc")

    # Partner Client Beta — already handed off (completed)
    partner_beta = create_workspace(session, partner, "Client Beta",
                                     tier="innovator")
    add_workspace_member(session, partner_beta, au("emma@seed.dembrane.dev"), "owner")
    add_workspace_member(session, partner_beta, au("hank@seed.dembrane.dev"),
                         "admin")
    # Mark as already handed off.
    api(session, "PATCH", f"/items/workspace/{partner_beta}", {
        "handoff_status": "completed",
        "effective_client_team_id": alpha,
        # billed_to stays with partner for this demo (like they kept billing).
    })
    create_project(session, partner_beta, "Analytics Rebuild",
                   du("emma@seed.dembrane.dev"))
    print(f"  workspace Partner / Client Beta → handoff completed")

    # Referral ledger — partner earns kickback on Client Alpha
    create_referral_ledger_entry(
        session, partner_alpha, partner, admin_app_id,
        percent=20, notes="Standard partner agreement",
    )
    create_referral_ledger_entry(
        session, partner_beta, partner, admin_app_id,
        percent=20, notes="Handed off Q4 — kickback continues",
    )
    print(f"  referral_ledger: 2 entries under Partner Consulting")

    # Solo Studio — pilot AT cap
    solo_trial = create_workspace(session, studio, "Trial Run", tier="pilot")
    add_workspace_member(session, solo_trial, au("finn@seed.dembrane.dev"), "owner")
    p_solo = create_project(session, solo_trial, "First Engagement",
                            du("finn@seed.dembrane.dev"))
    # Pilot cap = 10 hours = 36000s. Fill to just over.
    create_conversations(session, p_solo, [3600] * 10 + [1200])
    print(f"  workspace Solo / Trial Run → pilot AT cap (hard block active)")

    # Guest on Acme Default
    add_workspace_member(
        session, acme_default, au("grace@seed.dembrane.dev"),
        "member", is_external=True,
    )
    print(f"  guest grace@external on Acme/Default")

    # Pending access request — cara requesting access to Acme Q1 Discovery
    # (she's team member; workspace is open).
    # Q1 Discovery doesn't have cara as member yet — perfect scenario.
    # Actually she was added to Default earlier; for Q1 she's not a member.
    create_access_request(session, acme_q1, au("cara@seed.dembrane.dev"))
    print(f"  access_request: cara → Acme/Q1 Discovery (pending)")

    # Pending workspace invite — new email, not yet a user.
    create_workspace_invite(
        session, acme_default,
        email="frank@seed.dembrane.dev",
        invited_by_user_id=au("anna@seed.dembrane.dev"),
    )
    print(f"  workspace_invite: frank@seed.dembrane.dev → Acme/Default (pending)")

    print("\nSeed complete.")
    print("Login as any demo user with password:", SEED_USER_PASSWORD)


def finn_suffix(oid: str) -> str:
    return oid[:8]


# ── main ──────────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--reset", action="store_true", help="Reset seed data.")
    p.add_argument("--seed", action="store_true", help="Write seed data.")
    p.add_argument("--all", action="store_true", help="Reset then seed.")
    p.add_argument("--apply", action="store_true",
                   help="Actually mutate. Default dry-run.")
    args = p.parse_args()

    if not (args.reset or args.seed or args.all):
        p.print_help()
        return 2

    do_reset = args.reset or args.all
    do_seed = args.seed or args.all
    dry_run = not args.apply

    print(f"Directus: {DIRECTUS_URL}")
    print(f"Mode: {'DRY-RUN' if dry_run else 'APPLY'}")
    print(f"Reset={do_reset}  Seed={do_seed}")

    token = login()
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})

    if do_reset:
        reset_seed_data(session, dry_run)
    if do_seed:
        if dry_run:
            print("\n(dry-run: would seed but skipping writes)")
        else:
            seed(session, dry_run=False)

    return 0


if __name__ == "__main__":
    sys.exit(main())
