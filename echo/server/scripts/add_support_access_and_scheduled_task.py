"""Idempotent migration for the staff support-access flow (ECHO-863).

Three independent, re-runnable changes via the Directus REST API:

  1. workspace.allow_support_access (boolean, default false)
       Customer-controlled toggle: "Allow dembrane staff to access my
       workspace for support". Staff can only self-join when this is true.

  2. workspace_membership.expires_at (timestamp, nullable)
       When set, the membership auto-revokes at this time. Used by the staff
       support membership (now + 24h). NULL for every normal membership.
     + extend the `source` enum with `staff_support` so the Directus admin
       dropdown and snapshot stay accurate (the column is a plain varchar, so
       this is a meta-only change — no data migration).

  3. scheduled_task collection
       A generic, durable, future-scheduled one-shot task queue (PG-backed via
       Directus). The unified runner polls status='scheduled' AND
       scheduled_at <= now, claims by transitioning to 'processing', dispatches
       by task_type, then marks 'completed' / 'failed'. Replaces broker-delay /
       in-memory scheduling for definite-future actions (revoke_staff_support,
       generate_report). Admins can inspect / cancel / retry rows in Directus.

Guarded by collection_exists / field_exists so re-running is a no-op. Never
hand-write the snapshot JSON — run this, then pull the schema snapshot.

Usage:
    DIRECTUS_URL=http://directus:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/add_support_access_and_scheduled_task.py
"""

import os
import sys

import requests

URL = os.environ.get("DIRECTUS_URL", "http://directus:8055").rstrip("/")
EMAIL = os.environ.get("DIRECTUS_EMAIL", "admin@dembrane.com")
PASSWORD = os.environ.get("DIRECTUS_PASSWORD", "admin")


def login() -> str:
    res = requests.post(
        f"{URL}/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=15,
    )
    res.raise_for_status()
    return res.json()["data"]["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def collection_exists(token: str, collection: str) -> bool:
    res = requests.get(
        f"{URL}/collections/{collection}", headers=_headers(token), timeout=15
    )
    if res.status_code == 200:
        return True
    if res.status_code in (403, 404):
        return False
    res.raise_for_status()
    return False


def field_exists(token: str, collection: str, field: str) -> bool:
    res = requests.get(
        f"{URL}/fields/{collection}", headers=_headers(token), timeout=15
    )
    if res.status_code in (403, 404):
        return False
    res.raise_for_status()
    return any(f["field"] == field for f in res.json()["data"])


def create_collection(token: str, collection: str, note: str, icon: str, meta_extra: dict | None = None) -> None:
    """Create a collection with a uuid primary key (Directus default shape)."""
    meta = {
        "note": note,
        "icon": icon,
        "hidden": False,
        "singleton": False,
    }
    if meta_extra:
        meta.update(meta_extra)
    payload = {
        "collection": collection,
        "meta": meta,
        "schema": {"name": collection},
        "fields": [
            {
                "field": "id",
                "type": "uuid",
                "meta": {
                    "hidden": True,
                    "readonly": True,
                    "interface": "input",
                    "special": ["uuid"],
                },
                "schema": {
                    "is_primary_key": True,
                    "is_nullable": False,
                    "is_unique": True,
                },
            }
        ],
    }
    res = requests.post(
        f"{URL}/collections", headers=_headers(token), json=payload, timeout=15
    )
    res.raise_for_status()


def create_field(token: str, collection: str, payload: dict) -> None:
    res = requests.post(
        f"{URL}/fields/{collection}", headers=_headers(token), json=payload, timeout=15
    )
    res.raise_for_status()


def get_field(token: str, collection: str, field: str) -> dict | None:
    res = requests.get(
        f"{URL}/fields/{collection}/{field}", headers=_headers(token), timeout=15
    )
    if res.status_code in (403, 404):
        return None
    res.raise_for_status()
    return res.json()["data"]


def patch_field(token: str, collection: str, field: str, payload: dict) -> None:
    res = requests.patch(
        f"{URL}/fields/{collection}/{field}",
        headers=_headers(token),
        json=payload,
        timeout=15,
    )
    res.raise_for_status()


# ── field definition helpers (mirror add_training_collections.py) ───────────


def _bool_field(field: str, note: str, default: bool) -> dict:
    return {
        "field": field,
        "type": "boolean",
        "meta": {"interface": "boolean", "note": note, "width": "half"},
        "schema": {"default_value": default, "is_nullable": False},
    }


def _datetime_field(field: str, note: str, nullable: bool = True, indexed: bool = False) -> dict:
    return {
        "field": field,
        "type": "timestamp",
        "meta": {"interface": "datetime", "note": note, "width": "half"},
        "schema": {"is_nullable": nullable, "is_indexed": indexed},
    }


def _enum_field(
    field: str, note: str, choices: list[str], default: str, nullable: bool = True, indexed: bool = False
) -> dict:
    return {
        "field": field,
        "type": "string",
        "meta": {
            "interface": "select-dropdown",
            "note": note,
            "options": {
                "choices": [
                    {"text": c.replace("_", " ").title(), "value": c} for c in choices
                ]
            },
            "width": "half",
        },
        "schema": {"default_value": default, "is_nullable": nullable, "is_indexed": indexed},
    }


def _json_field(field: str, note: str) -> dict:
    return {
        "field": field,
        "type": "json",
        "meta": {"interface": "input-code", "note": note, "width": "full"},
        "schema": {"is_nullable": True},
    }


def _text_field(field: str, note: str) -> dict:
    return {
        "field": field,
        "type": "text",
        "meta": {"interface": "input-multiline", "note": note, "width": "full"},
        "schema": {"is_nullable": True},
    }


def _int_field(field: str, note: str, default: int = 0) -> dict:
    return {
        "field": field,
        "type": "integer",
        "meta": {"interface": "input", "note": note, "width": "half"},
        "schema": {"default_value": default, "is_nullable": True},
    }


# ── 1. workspace.allow_support_access ───────────────────────────────────────


def ensure_allow_support_access(token: str) -> None:
    if field_exists(token, "workspace", "allow_support_access"):
        print("  workspace.allow_support_access already exists")
        return
    create_field(
        token,
        "workspace",
        _bool_field(
            "allow_support_access",
            "Customer toggle: allow dembrane staff to self-join this workspace "
            "for support (24h, auto-revoked).",
            default=False,
        ),
    )
    print("  created workspace.allow_support_access")


# ── 2. workspace_membership.expires_at + source enum ────────────────────────


def ensure_membership_expires_at(token: str) -> None:
    if field_exists(token, "workspace_membership", "expires_at"):
        print("  workspace_membership.expires_at already exists")
    else:
        create_field(
            token,
            "workspace_membership",
            _datetime_field(
                "expires_at",
                "If set, this membership auto-revokes at this time (staff support "
                "access = now + 24h). NULL for normal memberships.",
                nullable=True,
                indexed=True,
            ),
        )
        print("  created workspace_membership.expires_at")


def ensure_source_enum_has_staff_support(token: str) -> None:
    field = get_field(token, "workspace_membership", "source")
    if field is None:
        print("  workspace_membership.source not found; skipping enum extension")
        return
    meta = field.get("meta") or {}
    options = meta.get("options") or {}
    choices = list(options.get("choices") or [])
    values = {c.get("value") for c in choices}
    if "staff_support" in values:
        print("  workspace_membership.source already has staff_support")
        return
    choices.append({"text": "Staff Support", "value": "staff_support"})
    patch_field(
        token,
        "workspace_membership",
        "source",
        {
            "meta": {
                "note": (
                    "direct = explicitly invited. inherited = auto-added from org "
                    "role. staff_support = dembrane staff temporary support access."
                ),
                "options": {"choices": choices},
            }
        },
    )
    print("  extended workspace_membership.source enum with staff_support")


# ── 3. scheduled_task collection ────────────────────────────────────────────

SCHEDULED_TASK_FIELDS = [
    _enum_field(
        "task_type",
        "What to run when due.",
        ["revoke_staff_support", "generate_report"],
        default="revoke_staff_support",
        nullable=False,
    ),
    _json_field(
        "payload",
        "Args for the handler, e.g. {\"workspace_id\": \"...\", \"membership_id\": \"...\"}.",
    ),
    _datetime_field(
        "scheduled_at",
        "When this task becomes due (timezone-aware).",
        nullable=False,
        indexed=True,
    ),
    _enum_field(
        "status",
        "Lifecycle. scheduled -> processing -> completed/failed. cancelled = won't run.",
        ["scheduled", "processing", "completed", "failed", "cancelled"],
        default="scheduled",
        nullable=False,
        indexed=True,
    ),
    _datetime_field(
        "claimed_at",
        "Stamped when a runner claims the row (status -> processing). Lets a "
        "reconciler reset rows stuck in processing.",
        nullable=True,
    ),
    _int_field("attempts", "How many times a runner has claimed this task.", default=0),
    _text_field("error", "Failure detail from the last attempt (for admin triage)."),
    _datetime_field("created_at", "Created timestamp.", nullable=True),
    _datetime_field("updated_at", "Last-updated timestamp.", nullable=True),
]


def ensure_scheduled_task_collection(token: str) -> None:
    if collection_exists(token, "scheduled_task"):
        print("  scheduled_task collection already exists")
    else:
        create_collection(
            token,
            "scheduled_task",
            note=(
                "Durable future-scheduled one-shot tasks (revoke staff support, "
                "scheduled report generation). Polled and dispatched by the "
                "unified runner."
            ),
            icon="schedule",
            # Let staff "cancel" a task via the Directus archive affordance.
            meta_extra={
                "archive_field": "status",
                "archive_value": "cancelled",
                "unarchive_value": "scheduled",
            },
        )
        print("  created scheduled_task collection")

    for payload in SCHEDULED_TASK_FIELDS:
        name = payload["field"]
        if field_exists(token, "scheduled_task", name):
            print(f"    scheduled_task.{name} already exists")
        else:
            create_field(token, "scheduled_task", payload)
            print(f"    created scheduled_task.{name}")


def main() -> int:
    token = login()

    print("workspace.allow_support_access:")
    ensure_allow_support_access(token)

    print("workspace_membership expiry + source enum:")
    ensure_membership_expires_at(token)
    ensure_source_enum_has_staff_support(token)

    print("scheduled_task collection:")
    ensure_scheduled_task_collection(token)

    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
