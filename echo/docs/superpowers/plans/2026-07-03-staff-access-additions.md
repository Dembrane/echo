# Staff Support Access Additions Implementation Plan (corrected)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Corrected against live code (2026-07-09).** Five changes vs the original draft: (1) `_dispatch_scheduled_task` edits are additive and preserve the live `TASK_CANVAS_TICK` branch; (2) the toggle side-effect block is wrapped in try/except; (3) the staff request modal uses an inline `Modal` + `Textarea` (optional note) instead of `InputModal`; (4) the join-support test patches land in both `_patched` and `_patched_race`; (5) a line-number-drift caveat. Search on function names, not the line numbers in this doc.

**Goal:** Add consent, visibility, and cleanup to the staff support access feature: a hybrid request-and-approve flow, client notifications and emails for every access event, auto-off of the toggle when the last staff session ends, a recurring "turn it off" reminder, and a client-facing audit log.

**Architecture:** One new domain module `server/dembrane/support_access.py` is the choke point: every lifecycle change calls `record_support_access_event()`, which appends a row to a new `support_access_event` Directus collection and fans out the in-app notification (existing `notifications.py`) and email (existing `email.py`). A second collection `support_access_request` holds the request state machine. Timers reuse the existing `scheduled_task` queue. Spec: `docs/superpowers/specs/2026-07-03-staff-access-additions-design.md`.

**Tech Stack:** FastAPI (async, `async_directus`), Directus REST, Dramatiq (sync actors + `run_async_in_new_loop`), SendGrid via `dembrane/email.py` Jinja templates, React + Mantine + TanStack Query + Lingui.

## Global Constraints

- User-facing copy: never "successfully", never "AI", never em dashes, "dembrane" always lowercase, no bold for emphasis (`brand/STYLE_GUIDE.md`)
- All frontend copy through Lingui macros: `t` from `@lingui/core/macro`, `Trans` from `@lingui/react/macro`
- Buttons: never `variant="default"`, never `color="blue"`; omit props for the primary filled style; `color="red"` for destructive
- Text sizes: only ramp tokens (`size="xs"`..`"xl"` / `text-xs`..), never hardcoded px
- Python: config via `get_settings()`, never direct env reads; no `asyncio` in Dramatiq actors, use `run_async_in_new_loop`; sync `DirectusClient.create_item`/`update_item` return `{"data": ...}` and MUST be unwrapped, `async_directus` calls in this plan pre-generate ids and ignore returns
- Never hand-write Directus snapshot JSON; migration script then `sync.sh pull`
- **Do NOT `git commit`.** The user commits themselves. Each task ends at a verified working tree state instead of a commit
- **Line numbers in this doc are stale by 5 to 40 lines** (canvas commits shifted `tasks.py`, `scheduled_tasks.py`, `admin.py`, `api/v2/__init__.py`, `workspace_settings.py`, `WorkspaceSettingsRoute.tsx`). Match on function names and surrounding code, never on quoted line numbers. Verified current anchors: `tasks.py::_dispatch_scheduled_task`=1886, `_revoke_staff_support_async`=1915; `admin.py::join_workspace_support`=1559 (TTL 1503, model 1506), `leave_workspace_support`=1784, GET status=1756; `api/v2/__init__.py` workspace-scoped include block=77-86 (prefix `/workspaces`); `workspace_settings.py::update_workspace_settings`=353-406 (logger at 21); `AdminSettingsRoute.tsx::JoinSupportControl`=904-1053; `WorkspaceSettingsRoute.tsx` support Switch=1916, `supportAccessMutation`=1448
- **`_dispatch_scheduled_task` edits are ADDITIVE.** The live function has a third branch, `TASK_CANVAS_TICK` -> `_run_canvas_tick(payload)`. Never rewrite the whole `if/elif` block; insert new `elif`s above the `else` or you delete canvas dispatch and throw `ValueError` on every tick
- Backend test invocation on this host (root-owned `server/.venv` workaround). One-time setup: `cd server && uv python install 3.11 && UV_PROJECT_ENVIRONMENT=.venv-local uv sync`. Then every pytest run uses this prefix (dummy values are fine, tests mock Directus):

```bash
cd server && UV_PROJECT_ENVIRONMENT=.venv-local \
  DIRECTUS_SECRET=test-secret DIRECTUS_TOKEN=test-token \
  DATABASE_URL=postgresql://test:test@localhost:5432/test \
  REDIS_URL=redis://localhost:6379/0 \
  STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 \
  STORAGE_S3_KEY=test STORAGE_S3_SECRET=test \
  uv run pytest <TEST_PATH> -v
```

Referred to below as `<PYTEST> <TEST_PATH>`.

- Frontend verification: `cd frontend && pnpm exec tsc && pnpm lint`. `pnpm messages:extract` may fail on this host (root-owned `.po` files); attempt it, and if it fails with a permission error, note it for the user and move on
- Audit event codes (lower snake, stored in `support_access_event.event_code`): `toggle_enabled`, `toggle_disabled`, `toggle_auto_disabled`, `request_created`, `request_approved`, `request_denied`, `request_expired`, `request_cancelled`, `staff_joined`, `staff_extended`, `staff_left`, `staff_auto_revoked`, `reminder_sent`
- Notification event codes (UPPER snake, stored in `notification.event_code`): `SUPPORT_ACCESS_REQUESTED`, `SUPPORT_REQUEST_APPROVED`, `SUPPORT_REQUEST_DENIED`, `SUPPORT_REQUEST_EXPIRED`, `SUPPORT_REQUEST_SUPERSEDED`, `SUPPORT_STAFF_JOINED`, `SUPPORT_STAFF_EXTENDED`, `SUPPORT_STAFF_LEFT`, `SUPPORT_ACCESS_ENDED`, `SUPPORT_ACCESS_REMINDER`

---

### Task 1: Directus migration (two collections + scheduled_task enum extension)

**Files:**
- Create: `server/scripts/add_support_access_audit_and_requests.py`
- Modify (generated): `directus/sync/snapshot/**` via `sync.sh pull`

**Interfaces:**
- Produces: Directus collections `support_access_event` (fields: `workspace_id`, `event_code`, `actor_user_id`, `staff_user_id`, `params`, `created_at`) and `support_access_request` (fields: `workspace_id`, `requested_by`, `status`, `message`, `created_at`, `expires_at`, `resolved_at`, `resolved_by`, `membership_id`). All later backend tasks write/read these via the backend admin token; no app-role Directus permissions are granted (frontend access is v2-endpoint-only).

- [ ] **Step 1: Write the migration script**

Create `server/scripts/add_support_access_audit_and_requests.py`. It mirrors the helper style of `server/scripts/add_support_access_and_scheduled_task.py` (login, `collection_exists`, `field_exists`, `create_collection`, `create_field`, field-shape helpers) and `add_training_collections.py` (`relation_exists`, `create_relation`). Full content:

```python
"""Idempotent migration for staff support-access additions (audit log + requests).

Creates two collections via the Directus REST API:

  1. support_access_event: append-only audit log of the support-access
     lifecycle per workspace (toggle changes, requests, joins, revokes,
     reminders). Written only by the backend (dembrane/support_access.py).

  2. support_access_request: state machine for staff access requests when
     the customer toggle is off (pending/approved/denied/expired/cancelled).

Also extends scheduled_task.task_type dropdown choices with the two new task
types (support_toggle_reminder, expire_support_access_request). The column is
a plain varchar, so this is meta-only.

No Directus role permissions are added: both collections are backend-token
only; the frontend reads them through /v2 endpoints.

Guarded by collection_exists / field_exists / relation_exists so re-running is
a no-op. Never hand-write the snapshot JSON; run this, then pull the snapshot.

Usage:
    DIRECTUS_URL=http://localhost:8055 \
    DIRECTUS_EMAIL=admin@dembrane.com \
    DIRECTUS_PASSWORD=admin \
    uv run python scripts/add_support_access_audit_and_requests.py
"""

import os
import sys

import requests

URL = os.environ.get("DIRECTUS_URL", "http://localhost:8055").rstrip("/")
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


def relation_exists(token: str, collection: str, field: str) -> bool:
    res = requests.get(
        f"{URL}/relations/{collection}", headers=_headers(token), timeout=15
    )
    if res.status_code in (403, 404):
        return False
    res.raise_for_status()
    return any(r.get("field") == field for r in res.json()["data"])


def create_collection(token: str, collection: str, note: str, icon: str) -> None:
    payload = {
        "collection": collection,
        "meta": {"note": note, "icon": icon, "hidden": False, "singleton": False},
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


def create_relation(
    token: str,
    collection: str,
    field: str,
    related_collection: str,
    on_delete: str = "SET NULL",
) -> None:
    payload = {
        "collection": collection,
        "field": field,
        "related_collection": related_collection,
        "schema": {"on_delete": on_delete},
        "meta": {"one_deselect_action": "nullify"},
    }
    res = requests.post(
        f"{URL}/relations", headers=_headers(token), json=payload, timeout=15
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


# ── field shape helpers ──────────────────────────────────────────────────────


def _uuid_fk_field(field: str, note: str, nullable: bool = True) -> dict:
    return {
        "field": field,
        "type": "uuid",
        "meta": {"interface": "input", "note": note, "width": "half"},
        "schema": {"is_nullable": nullable},
    }


def _string_field(field: str, note: str, nullable: bool = False, indexed: bool = False) -> dict:
    return {
        "field": field,
        "type": "string",
        "meta": {"interface": "input", "note": note, "width": "half"},
        "schema": {"is_nullable": nullable, "is_indexed": indexed},
    }


def _enum_field(
    field: str, note: str, choices: list[str], default: str, indexed: bool = False
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
        "schema": {"default_value": default, "is_nullable": False, "is_indexed": indexed},
    }


def _datetime_field(field: str, note: str, nullable: bool = True, indexed: bool = False) -> dict:
    return {
        "field": field,
        "type": "timestamp",
        "meta": {"interface": "datetime", "note": note, "width": "half"},
        "schema": {"is_nullable": nullable, "is_indexed": indexed},
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


# ── 1. support_access_event ─────────────────────────────────────────────────

EVENT_FIELDS = [
    _uuid_fk_field("workspace_id", "Workspace this event belongs to.", nullable=False),
    _string_field(
        "event_code",
        "Lifecycle event: toggle_enabled/disabled/auto_disabled, request_*, "
        "staff_joined/extended/left/auto_revoked, reminder_sent.",
        indexed=True,
    ),
    _uuid_fk_field(
        "actor_user_id",
        "app_user who performed the action. NULL for system events "
        "(auto-revoke, reminder, auto-off).",
    ),
    _uuid_fk_field(
        "staff_user_id", "Staff app_user this event concerns, when applicable."
    ),
    _json_field(
        "params",
        'Event detail, e.g. {"request_id": "...", "membership_id": "...", '
        '"expires_at": "...", "reason": "..."}.',
    ),
    _datetime_field("created_at", "When the event happened.", nullable=False, indexed=True),
]

EVENT_RELATIONS = [
    ("workspace_id", "workspace"),
    ("actor_user_id", "app_user"),
    ("staff_user_id", "app_user"),
]


def ensure_event_collection(token: str) -> None:
    if collection_exists(token, "support_access_event"):
        print("  support_access_event already exists")
    else:
        create_collection(
            token,
            "support_access_event",
            note=(
                "Append-only audit log of the staff support-access lifecycle "
                "per workspace. Written only by the backend."
            ),
            icon="policy",
        )
        print("  created support_access_event")
    for payload in EVENT_FIELDS:
        name = payload["field"]
        if field_exists(token, "support_access_event", name):
            print(f"    support_access_event.{name} already exists")
        else:
            create_field(token, "support_access_event", payload)
            print(f"    created support_access_event.{name}")
    for field, related in EVENT_RELATIONS:
        if relation_exists(token, "support_access_event", field):
            print(f"    relation support_access_event.{field} already exists")
        else:
            create_relation(token, "support_access_event", field, related)
            print(f"    created relation support_access_event.{field} -> {related}")


# ── 2. support_access_request ───────────────────────────────────────────────

REQUEST_FIELDS = [
    _uuid_fk_field("workspace_id", "Workspace the staff member wants to join.", nullable=False),
    _uuid_fk_field("requested_by", "Staff app_user who asked for access.", nullable=False),
    _enum_field(
        "status",
        "pending -> approved | denied | expired | cancelled.",
        ["pending", "approved", "denied", "expired", "cancelled"],
        default="pending",
        indexed=True,
    ),
    _text_field("message", "Optional note from staff, shown to the customer."),
    _datetime_field("created_at", "When the request was made.", nullable=False),
    _datetime_field(
        "expires_at", "Pending requests expire at this time (created + 7d).", nullable=True
    ),
    _datetime_field("resolved_at", "When the request left pending.", nullable=True),
    _uuid_fk_field("resolved_by", "app_user who approved/denied/cancelled."),
    _uuid_fk_field(
        "membership_id",
        "workspace_membership created on approval (links grant to consent).",
    ),
]

REQUEST_RELATIONS = [
    ("workspace_id", "workspace"),
    ("requested_by", "app_user"),
    ("resolved_by", "app_user"),
    ("membership_id", "workspace_membership"),
]


def ensure_request_collection(token: str) -> None:
    if collection_exists(token, "support_access_request"):
        print("  support_access_request already exists")
    else:
        create_collection(
            token,
            "support_access_request",
            note=(
                "Staff requests to access a workspace while the customer's "
                "support-access toggle is off. Approval grants a one-time 24h "
                "membership without turning the toggle on."
            ),
            icon="how_to_reg",
        )
        print("  created support_access_request")
    for payload in REQUEST_FIELDS:
        name = payload["field"]
        if field_exists(token, "support_access_request", name):
            print(f"    support_access_request.{name} already exists")
        else:
            create_field(token, "support_access_request", payload)
            print(f"    created support_access_request.{name}")
    for field, related in REQUEST_RELATIONS:
        if relation_exists(token, "support_access_request", field):
            print(f"    relation support_access_request.{field} already exists")
        else:
            create_relation(token, "support_access_request", field, related)
            print(f"    created relation support_access_request.{field} -> {related}")


# ── 3. scheduled_task.task_type choices ─────────────────────────────────────

NEW_TASK_TYPES = [
    ("Support Toggle Reminder", "support_toggle_reminder"),
    ("Expire Support Access Request", "expire_support_access_request"),
]


def ensure_task_type_choices(token: str) -> None:
    field = get_field(token, "scheduled_task", "task_type")
    if field is None:
        print("  scheduled_task.task_type not found; skipping choices extension")
        return
    meta = field.get("meta") or {}
    options = meta.get("options") or {}
    choices = list(options.get("choices") or [])
    values = {c.get("value") for c in choices}
    added = False
    for text, value in NEW_TASK_TYPES:
        if value not in values:
            choices.append({"text": text, "value": value})
            added = True
    if not added:
        print("  scheduled_task.task_type already has the new choices")
        return
    patch_field(token, "scheduled_task", "task_type", {"meta": {"options": {"choices": choices}}})
    print("  extended scheduled_task.task_type choices")


def main() -> int:
    token = login()
    print("support_access_event:")
    ensure_event_collection(token)
    print("support_access_request:")
    ensure_request_collection(token)
    print("scheduled_task.task_type choices:")
    ensure_task_type_choices(token)
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run it against local Directus**

Run: `cd server && UV_PROJECT_ENVIRONMENT=.venv-local DIRECTUS_URL=http://localhost:8055 DIRECTUS_EMAIL=admin@dembrane.com DIRECTUS_PASSWORD=admin uv run python scripts/add_support_access_audit_and_requests.py`

(If local Directus runs inside docker compose without a localhost port map, use the compose network URL `http://directus:8055` from inside the container, matching how `sync.sh` is normally run.)

Expected output ends with `done`; every line says `created ...`.

- [ ] **Step 3: Re-run to prove idempotence**

Same command. Expected: every line says `already exists`, ends with `done`.

- [ ] **Step 4: Pull the schema snapshot**

Run: `cd directus && bash sync.sh -u http://localhost:8055 -e admin@dembrane.com -p admin pull` (same URL adjustment as Step 2; AGENTS.md documents the in-network form `http://directus:8055`).

Expected: new files under `directus/sync/snapshot/collections/` and `directus/sync/snapshot/fields/` for both collections. Verify with:

Run: `git status --short directus/sync/snapshot | head -30`
Expected: new `support_access_event.json`, `support_access_request.json` collection files plus one JSON per field, and a modified `fields/scheduled_task/task_type.json`.

- [ ] **Step 5: Leave changes staged for the user (no commit)**

Run: `git add -N server/scripts/add_support_access_audit_and_requests.py directus/sync/snapshot`
State the working tree is ready; the user commits.

---

### Task 2: Core module `dembrane/support_access.py` (events, notifications, emails, templates)

**Files:**
- Create: `server/dembrane/support_access.py`
- Create: `server/email_templates/support_access_request.html`
- Create: `server/email_templates/support_access_joined.html`
- Create: `server/email_templates/support_access_ended.html`
- Create: `server/email_templates/support_access_reminder.html`
- Create: `server/email_templates/support_access_request_resolved.html`
- Modify: `server/dembrane/notifications.py` (severity map, near line 100)
- Test: `server/tests/test_support_access_events.py`

**Interfaces:**
- Consumes: `notifications.emit`, `notifications.emit_to_audience`, `notifications.audience_workspace_admins`, `email.send_email`, `async_directus`, `get_settings().urls.admin_base_url`
- Produces (used by every later backend task):
  - `EVENT_COLLECTION = "support_access_event"`, `REQUEST_COLLECTION = "support_access_request"`
  - `REQUEST_TTL: timedelta` (7 days), `REMINDER_INTERVAL: timedelta` (7 days)
  - `EVENT_TOGGLE_ENABLED/..._DISABLED/..._AUTO_DISABLED`, `EVENT_REQUEST_CREATED/APPROVED/DENIED/EXPIRED/CANCELLED`, `EVENT_STAFF_JOINED/EXTENDED/LEFT/AUTO_REVOKED`, `EVENT_REMINDER_SENT` (string constants matching the Global Constraints vocabulary)
  - `async def record_support_access_event(*, workspace_id: str, event_code: str, actor_user_id: str | None = None, staff_user_id: str | None = None, params: dict | None = None, notify: bool = True) -> str | None`
  - `async def send_support_access_notice(*, workspace_id: str, event_code: str, actor_user_id: str | None = None, staff_user_id: str | None = None, params: dict | None = None) -> None`

> Verified against live code: `emit`, `emit_to_audience`, `audience_workspace_admins`, `send_email` are all async (await them); `emit` args are keyword-only; `audience_workspace_admins` returns app_user ids; `send_email(to=..., subject=..., template=<name-no-ext>, template_data=...)`; `"NAVIGATE_WORKSPACE_SETTINGS"` is a valid action; `severity_for` is sync and returns `"info"` for unmapped codes. `_SEVERITY_BY_EVENT` and `severity_for` live in `notifications.py`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_support_access_events.py`:

```python
"""Tests for dembrane/support_access.py: the audit + notification choke point.

record_support_access_event() must (a) append the audit row, (b) fan out the
right in-app notification and email per event code, and (c) never raise: a
broken audit write or notification must not fail the parent action.
"""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest

from dembrane import support_access as sa

_WS_ID = "ws-1"
_WS = {"id": _WS_ID, "name": "Client Alpha", "org_id": "org-1"}


@contextmanager
def _patched(ws: dict | None = _WS, admins: list[str] | None = None):
    directus = AsyncMock()
    directus.get_item = AsyncMock(return_value=ws)
    directus.get_items = AsyncMock(
        return_value=[{"email": "admin@client.test"}]  # _emails_for_app_users
    )
    directus.create_item = AsyncMock(return_value={"data": {}})
    mocks = {
        "directus": directus,
        "emit": AsyncMock(return_value="n-1"),
        "emit_to_audience": AsyncMock(return_value=["n-1"]),
        "audience": AsyncMock(return_value=admins if admins is not None else ["au-admin"]),
        "send_email": AsyncMock(return_value=True),
    }
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.support_access.async_directus", directus))
        stack.enter_context(patch("dembrane.notifications.emit", mocks["emit"]))
        stack.enter_context(
            patch("dembrane.notifications.emit_to_audience", mocks["emit_to_audience"])
        )
        stack.enter_context(
            patch(
                "dembrane.notifications.audience_workspace_admins", mocks["audience"]
            )
        )
        stack.enter_context(patch("dembrane.email.send_email", mocks["send_email"]))
        yield mocks


@pytest.mark.asyncio
async def test_writes_audit_row():
    with _patched() as m:
        event_id = await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_STAFF_JOINED,
            staff_user_id="au-staff",
        )
    assert event_id is not None
    collection, payload = m["directus"].create_item.call_args.args
    assert collection == sa.EVENT_COLLECTION
    assert payload["workspace_id"] == _WS_ID
    assert payload["event_code"] == sa.EVENT_STAFF_JOINED
    assert payload["staff_user_id"] == "au-staff"
    assert payload["created_at"]


@pytest.mark.asyncio
async def test_audit_write_failure_never_raises_and_still_notifies():
    with _patched() as m:
        m["directus"].create_item.side_effect = RuntimeError("directus down")
        event_id = await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_STAFF_JOINED,
            staff_user_id="au-staff",
        )
    assert event_id is None
    assert m["emit_to_audience"].await_count == 1


@pytest.mark.asyncio
async def test_request_created_notifies_admins_in_app_and_email():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_REQUEST_CREATED,
            actor_user_id="au-staff",
            staff_user_id="au-staff",
            params={"request_id": "req-1", "message": "billing bug"},
        )
    kwargs = m["emit_to_audience"].call_args.kwargs
    assert kwargs["event_code"] == "SUPPORT_ACCESS_REQUESTED"
    assert kwargs["action"] == "NAVIGATE_WORKSPACE_SETTINGS"
    assert "Client Alpha" in kwargs["title"]
    email_kwargs = m["send_email"].call_args.kwargs
    assert email_kwargs["template"] == "support_access_request"
    assert email_kwargs["to"] == ["admin@client.test"]


@pytest.mark.asyncio
async def test_staff_extended_is_in_app_only():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_STAFF_EXTENDED,
            staff_user_id="au-staff",
        )
    assert m["emit_to_audience"].await_count == 1
    assert m["send_email"].await_count == 0


@pytest.mark.asyncio
async def test_toggle_auto_disabled_sends_combined_ended_notice():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID, event_code=sa.EVENT_TOGGLE_AUTO_DISABLED
        )
    kwargs = m["emit_to_audience"].call_args.kwargs
    assert kwargs["event_code"] == "SUPPORT_ACCESS_ENDED"
    assert m["send_email"].call_args.kwargs["template"] == "support_access_ended"


@pytest.mark.asyncio
async def test_request_approved_notifies_the_staff_member():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_REQUEST_APPROVED,
            actor_user_id="au-admin",
            staff_user_id="au-staff",
            params={"request_id": "req-1"},
        )
    kwargs = m["emit"].call_args.kwargs
    assert kwargs["audience_user_id"] == "au-staff"
    assert kwargs["event_code"] == "SUPPORT_REQUEST_APPROVED"
    assert m["send_email"].call_args.kwargs["template"] == "support_access_request_resolved"


@pytest.mark.asyncio
async def test_toggle_enabled_records_but_does_not_notify():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_TOGGLE_ENABLED,
            actor_user_id="au-admin",
        )
    assert m["directus"].create_item.await_count == 1
    assert m["emit"].await_count == 0
    assert m["emit_to_audience"].await_count == 0
    assert m["send_email"].await_count == 0


@pytest.mark.asyncio
async def test_notify_false_skips_fan_out():
    with _patched() as m:
        await sa.record_support_access_event(
            workspace_id=_WS_ID,
            event_code=sa.EVENT_STAFF_LEFT,
            staff_user_id="au-staff",
            notify=False,
        )
    assert m["directus"].create_item.await_count == 1
    assert m["emit_to_audience"].await_count == 0


@pytest.mark.asyncio
async def test_reminder_severity_is_action_required():
    from dembrane.notifications import severity_for

    assert severity_for("SUPPORT_ACCESS_REQUESTED") == "action_required"
    assert severity_for("SUPPORT_ACCESS_REMINDER") == "action_required"
    assert severity_for("SUPPORT_STAFF_JOINED") == "info"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `<PYTEST> tests/test_support_access_events.py`
Expected: FAIL with `ModuleNotFoundError`/`ImportError` on `dembrane.support_access`.

- [ ] **Step 3: Implement the module**

Create `server/dembrane/support_access.py`:

```python
"""Staff support access: audit events, request state machine, notifications.

Companion to the join/extend/leave endpoints in api/v2/admin.py (ECHO-863).
Every state change in the support-access lifecycle is recorded as one row in
`support_access_event` via record_support_access_event(), which also fans out
the in-app notification and email for that event. One choke point, one
vocabulary, one audit log. The frontend never reads these collections from
Directus directly; api/v2/support_access.py exposes them.
"""

from __future__ import annotations

from typing import Any, Optional
from logging import getLogger
from datetime import datetime, timezone, timedelta

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus

logger = getLogger("dembrane.support_access")

EVENT_COLLECTION = "support_access_event"
REQUEST_COLLECTION = "support_access_request"

# Pending requests expire after this; the reminder re-fires on this cadence.
REQUEST_TTL = timedelta(days=7)
REMINDER_INTERVAL = timedelta(days=7)

EVENT_TOGGLE_ENABLED = "toggle_enabled"
EVENT_TOGGLE_DISABLED = "toggle_disabled"
EVENT_TOGGLE_AUTO_DISABLED = "toggle_auto_disabled"
EVENT_REQUEST_CREATED = "request_created"
EVENT_REQUEST_APPROVED = "request_approved"
EVENT_REQUEST_DENIED = "request_denied"
EVENT_REQUEST_EXPIRED = "request_expired"
EVENT_REQUEST_CANCELLED = "request_cancelled"
EVENT_STAFF_JOINED = "staff_joined"
EVENT_STAFF_EXTENDED = "staff_extended"
EVENT_STAFF_LEFT = "staff_left"
EVENT_STAFF_AUTO_REVOKED = "staff_auto_revoked"
EVENT_REMINDER_SENT = "reminder_sent"


async def record_support_access_event(
    *,
    workspace_id: str,
    event_code: str,
    actor_user_id: Optional[str] = None,
    staff_user_id: Optional[str] = None,
    params: Optional[dict[str, Any]] = None,
    notify: bool = True,
) -> Optional[str]:
    """Append one audit row and (optionally) fan out its notification + email.

    Best-effort by design: never raises. The audit trail and its notifications
    are side effects of an already-committed primary action (a join, a toggle
    flip) and must not fail or roll it back. Returns the event id, or None
    when the write failed.
    """
    event_id: Optional[str] = None
    try:
        event_id = generate_uuid()
        await async_directus.create_item(
            EVENT_COLLECTION,
            {
                "id": event_id,
                "workspace_id": workspace_id,
                "event_code": event_code,
                "actor_user_id": actor_user_id,
                "staff_user_id": staff_user_id,
                "params": params or {},
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    except Exception as exc:  # noqa: BLE001 — audit is best-effort
        logger.warning(
            "support_access_event write failed (event=%s ws=%s): %s",
            event_code,
            workspace_id,
            exc,
        )
        event_id = None
    if notify:
        try:
            await send_support_access_notice(
                workspace_id=workspace_id,
                event_code=event_code,
                actor_user_id=actor_user_id,
                staff_user_id=staff_user_id,
                params=params,
            )
        except Exception as exc:  # noqa: BLE001 — notifications are best-effort
            logger.warning(
                "support_access notice failed (event=%s ws=%s): %s",
                event_code,
                workspace_id,
                exc,
            )
    return event_id


async def send_support_access_notice(
    *,
    workspace_id: str,
    event_code: str,
    actor_user_id: Optional[str] = None,
    staff_user_id: Optional[str] = None,
    params: Optional[dict[str, Any]] = None,
) -> None:
    """Fan out the notification + email for one lifecycle event.

    Public (separate from record_support_access_event) so the revoke paths can
    send the plain "staff member left" notice when auto-off did NOT fire,
    without writing a second audit row.
    """
    from dembrane.email import send_email
    from dembrane.notifications import (
        emit,
        emit_to_audience,
        audience_workspace_admins,
    )

    # Toggle flips by the customer are audit-only: the actor already knows.
    if event_code in (EVENT_TOGGLE_ENABLED, EVENT_TOGGLE_DISABLED):
        return

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws:
        return
    ws_name = ws.get("name") or "your workspace"
    org_id = ws.get("org_id")
    url = _settings_url(workspace_id)
    p = params or {}

    if event_code == EVENT_REQUEST_CREATED:
        staff_name = await _display_name(staff_user_id) or "dembrane staff"
        note = (p.get("message") or "").strip()
        admins = await audience_workspace_admins(workspace_id)
        title = f"dembrane staff requested access to {ws_name}"
        message = f"{staff_name} asked to join this workspace for support."
        if note:
            message = f"{message} Note: {note}"
        await emit_to_audience(
            admins,
            event_code="SUPPORT_ACCESS_REQUESTED",
            title=title,
            message=f"{message} Approve or deny in workspace settings.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            actor_user_id=staff_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
            params={"request_id": p.get("request_id")},
        )
        emails = await _emails_for_app_users(admins)
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_request",
                template_data={
                    "workspace_name": ws_name,
                    "staff_name": staff_name,
                    "note": note,
                    "settings_url": url,
                },
            )
        return

    if event_code == EVENT_STAFF_JOINED:
        staff_name = await _display_name(staff_user_id) or "dembrane staff"
        admins = await audience_workspace_admins(workspace_id)
        title = f"dembrane staff joined {ws_name} for support"
        await emit_to_audience(
            admins,
            event_code="SUPPORT_STAFF_JOINED",
            title=title,
            message="Access ends automatically after 24 hours.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            actor_user_id=staff_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        emails = await _emails_for_app_users(admins)
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_joined",
                template_data={
                    "workspace_name": ws_name,
                    "staff_name": staff_name,
                    "settings_url": url,
                },
            )
        return

    if event_code == EVENT_STAFF_EXTENDED:
        admins = await audience_workspace_admins(workspace_id)
        await emit_to_audience(
            admins,
            event_code="SUPPORT_STAFF_EXTENDED",
            title=f"dembrane staff extended their support session in {ws_name}",
            message="The session ends 24 hours from now.",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            actor_user_id=staff_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        return

    if event_code in (EVENT_STAFF_LEFT, EVENT_STAFF_AUTO_REVOKED):
        # Only reached when auto-off did NOT fire (another session active, or
        # the toggle was already off, e.g. an approval-granted session ended).
        admins = await audience_workspace_admins(workspace_id)
        await emit_to_audience(
            admins,
            event_code="SUPPORT_STAFF_LEFT",
            title=f"A dembrane staff member left {ws_name}",
            action="NAVIGATE_WORKSPACE_SETTINGS",
            actor_user_id=staff_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        return

    if event_code == EVENT_TOGGLE_AUTO_DISABLED:
        admins = await audience_workspace_admins(workspace_id)
        title = f"Support access to {ws_name} turned off"
        message = (
            "The support session ended and staff access was turned off. "
            "Turn it back on in workspace settings if you need more help."
        )
        await emit_to_audience(
            admins,
            event_code="SUPPORT_ACCESS_ENDED",
            title=title,
            message=message,
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        emails = await _emails_for_app_users(admins)
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_ended",
                template_data={"workspace_name": ws_name, "settings_url": url},
            )
        return

    if event_code == EVENT_REMINDER_SENT:
        admins = await audience_workspace_admins(workspace_id)
        title = f"Support access to {ws_name} is still on"
        message = (
            "No staff joined in the last 7 days. Turn it off in workspace "
            "settings if you no longer need help."
        )
        await emit_to_audience(
            admins,
            event_code="SUPPORT_ACCESS_REMINDER",
            title=title,
            message=message,
            action="NAVIGATE_WORKSPACE_SETTINGS",
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
        )
        emails = await _emails_for_app_users(admins)
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_reminder",
                template_data={"workspace_name": ws_name, "settings_url": url},
            )
        return

    if event_code in (EVENT_REQUEST_APPROVED, EVENT_REQUEST_DENIED):
        if not staff_user_id:
            return
        decision = "approved" if event_code == EVENT_REQUEST_APPROVED else "denied"
        title = f"Access request for {ws_name} {decision}"
        await emit(
            audience_user_id=staff_user_id,
            event_code=(
                "SUPPORT_REQUEST_APPROVED"
                if decision == "approved"
                else "SUPPORT_REQUEST_DENIED"
            ),
            title=title,
            message=(
                "You have admin access for 24 hours." if decision == "approved" else None
            ),
            actor_user_id=actor_user_id,
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
            params={"request_id": p.get("request_id")},
        )
        emails = await _emails_for_app_users([staff_user_id])
        if emails:
            await send_email(
                to=emails,
                subject=title,
                template="support_access_request_resolved",
                template_data={
                    "workspace_name": ws_name,
                    "decision": decision,
                    "workspace_url": _workspace_url(workspace_id),
                },
            )
        return

    if event_code == EVENT_REQUEST_EXPIRED:
        if not staff_user_id:
            return
        await emit(
            audience_user_id=staff_user_id,
            event_code="SUPPORT_REQUEST_EXPIRED",
            title=f"Access request for {ws_name} expired",
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
            params={"request_id": p.get("request_id")},
        )
        return

    if event_code == EVENT_REQUEST_CANCELLED:
        # Only the toggle-on supersede tells the requester; a self-cancel is
        # silent (callers pass notify=False for those anyway).
        if p.get("reason") != "toggle_enabled" or not staff_user_id:
            return
        await emit(
            audience_user_id=staff_user_id,
            event_code="SUPPORT_REQUEST_SUPERSEDED",
            title=f"Support access for {ws_name} is now on",
            message="You can join directly from the admin console.",
            ref_org_id=org_id,
            ref_workspace_id=workspace_id,
            params={"request_id": p.get("request_id")},
        )
        return

    logger.debug("no notice mapping for support access event %s", event_code)


# ── helpers ──────────────────────────────────────────────────────────────────


async def _emails_for_app_users(user_ids: list[str]) -> list[str]:
    if not user_ids:
        return []
    rows = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"id": {"_in": user_ids}},
                "fields": ["email"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []
    return sorted({(r.get("email") or "").strip() for r in rows if r.get("email")})


async def _display_name(app_user_id: Optional[str]) -> str:
    if not app_user_id:
        return ""
    try:
        row = await async_directus.get_item("app_user", app_user_id)
    except Exception:  # noqa: BLE001 — cosmetic lookup
        return ""
    return (row or {}).get("display_name") or ""


def _settings_url(workspace_id: str) -> str:
    from dembrane.settings import get_settings

    base = (get_settings().urls.admin_base_url or "").rstrip("/")
    path = f"/w/{workspace_id}/settings/general"
    return f"{base}{path}" if base else path


def _workspace_url(workspace_id: str) -> str:
    from dembrane.settings import get_settings

    base = (get_settings().urls.admin_base_url or "").rstrip("/")
    path = f"/w/{workspace_id}/home"
    return f"{base}{path}" if base else path
```

- [ ] **Step 4: Add severity map entries**

In `server/dembrane/notifications.py`, inside `_SEVERITY_BY_EVENT` (after the `"PAYMENT_FAILED"` entry, before the closing brace), add:

```python
    # Staff support access additions. The client must act on a pending
    # request and on a stale toggle; every other support event is info.
    "SUPPORT_ACCESS_REQUESTED": "action_required",
    "SUPPORT_ACCESS_REMINDER": "action_required",
```

- [ ] **Step 5: Create the five email templates**

All extend `_layout.html` like `server/email_templates/workspace_added.html`.

`server/email_templates/support_access_request.html`:

```html
{% extends "_layout.html" %}
{% from "_layout.html" import cta_button %}
{% block title %}dembrane staff requested access to {{ workspace_name }}{% endblock %}
{% block preview %}{{ staff_name }} asked to join {{ workspace_name }} for support.{% endblock %}
{% block heading %}Staff access request{% endblock %}
{% block body %}
<p style="font-size:17px; line-height:1.65; margin:0 0 28px; color:#2D2D2C; font-weight:400;">
  {{ staff_name }} from dembrane asked to join <em style="color:#4169E1; font-style:normal;">{{ workspace_name }}</em> to help with support.
  {% if note %}Their note: {{ note }}.{% endif %}
  If you approve, their access ends automatically after 24 hours.
</p>
{% endblock %}
{% block cta %}{{ cta_button("Review request", settings_url) }}{% endblock %}
```

`server/email_templates/support_access_joined.html`:

```html
{% extends "_layout.html" %}
{% from "_layout.html" import cta_button %}
{% block title %}dembrane staff joined {{ workspace_name }} for support{% endblock %}
{% block preview %}{{ staff_name }} joined {{ workspace_name }} to help with support.{% endblock %}
{% block heading %}Staff joined for support{% endblock %}
{% block body %}
<p style="font-size:17px; line-height:1.65; margin:0 0 28px; color:#2D2D2C; font-weight:400;">
  {{ staff_name }} from dembrane joined <em style="color:#4169E1; font-style:normal;">{{ workspace_name }}</em> to help with support.
  Their access ends automatically after 24 hours. You can follow what happens in the access history in your workspace settings.
</p>
{% endblock %}
{% block cta %}{{ cta_button("View access history", settings_url) }}{% endblock %}
```

`server/email_templates/support_access_ended.html`:

```html
{% extends "_layout.html" %}
{% from "_layout.html" import cta_button %}
{% block title %}Support access to {{ workspace_name }} turned off{% endblock %}
{% block preview %}The support session in {{ workspace_name }} ended and staff access was turned off.{% endblock %}
{% block heading %}Support session ended{% endblock %}
{% block body %}
<p style="font-size:17px; line-height:1.65; margin:0 0 28px; color:#2D2D2C; font-weight:400;">
  The support session in <em style="color:#4169E1; font-style:normal;">{{ workspace_name }}</em> ended and staff access was turned off.
  Turn it back on in workspace settings if you need more help.
</p>
{% endblock %}
{% block cta %}{{ cta_button("Open workspace settings", settings_url) }}{% endblock %}
```

`server/email_templates/support_access_reminder.html`:

```html
{% extends "_layout.html" %}
{% from "_layout.html" import cta_button %}
{% block title %}Support access to {{ workspace_name }} is still on{% endblock %}
{% block preview %}No staff joined {{ workspace_name }} in the last 7 days.{% endblock %}
{% block heading %}Support access is still on{% endblock %}
{% block body %}
<p style="font-size:17px; line-height:1.65; margin:0 0 28px; color:#2D2D2C; font-weight:400;">
  Support access for <em style="color:#4169E1; font-style:normal;">{{ workspace_name }}</em> is still on and no staff joined in the last 7 days.
  Turn it off in workspace settings if you no longer need help. You can turn it back on at any time.
</p>
{% endblock %}
{% block cta %}{{ cta_button("Open workspace settings", settings_url) }}{% endblock %}
```

`server/email_templates/support_access_request_resolved.html`:

```html
{% extends "_layout.html" %}
{% from "_layout.html" import cta_button %}
{% block title %}Access request for {{ workspace_name }} {{ decision }}{% endblock %}
{% block preview %}Your access request for {{ workspace_name }} was {{ decision }}.{% endblock %}
{% block heading %}Request {{ decision }}{% endblock %}
{% block body %}
<p style="font-size:17px; line-height:1.65; margin:0 0 28px; color:#2D2D2C; font-weight:400;">
  Your access request for <em style="color:#4169E1; font-style:normal;">{{ workspace_name }}</em> was {{ decision }}.
  {% if decision == "approved" %}You have admin access for 24 hours.{% endif %}
</p>
{% endblock %}
{% block cta %}{% if decision == "approved" %}{{ cta_button("Open workspace", workspace_url) }}{% endif %}{% endblock %}
```

Before finishing, open `server/email_templates/_layout.html` and confirm the block names used above (`title`, `preview`, `heading`, `body`, `cta`) and the `cta_button` macro signature match; adjust the five templates to the layout's actual blocks if they differ.

- [ ] **Step 6: Run tests to verify they pass**

Run: `<PYTEST> tests/test_support_access_events.py`
Expected: all 9 tests PASS.

---

### Task 3: Extract `grant_support_membership` and record join/extend events

**Files:**
- Modify: `server/dembrane/support_access.py` (add the grant helper)
- Modify: `server/dembrane/api/v2/admin.py` (`join_workspace_support` delegates to the helper, records events)
- Test: `server/tests/test_join_support.py` (update patches in BOTH scaffolds, add event assertions)

**Interfaces:**
- Consumes: `dembrane.api.v2._invite_helpers.create_membership_row/reactivate_membership_row` (both take the directus client as the first positional arg, return bool), `scheduled_tasks.schedule_task/cancel_pending_tasks/TASK_REVOKE_STAFF_SUPPORT`, `cache_utils.invalidate_workspace_and_org_usage`
- Produces: `async def grant_support_membership(*, workspace_id: str, app_user_id: str, org_id: str | None) -> tuple[str, str, str | None]` in `dembrane/support_access.py`, returning `(status, membership_id, expires_iso)` where `status` is `"joined" | "extended" | "already_member"` and `expires_iso` is `None` only for `already_member`. Task 5's approve endpoint calls this exact function.

- [ ] **Step 1: Move the membership logic into the helper**

In `server/dembrane/support_access.py`, add (below the event constants, above `record_support_access_event`). This is the body of the current `join_workspace_support` after its gates, plus `_reresolve_membership_after_join_race`, made endpoint-agnostic (returns tuples, raises `HTTPException(409)` only for the unrecoverable race):

```python
SUPPORT_ACCESS_TTL = timedelta(hours=24)


async def _reresolve_membership_after_join_race(
    workspace_id: str, app_user_id: str, expires_iso: str
) -> tuple[Optional[str], Optional[tuple[str, str, Optional[str]]]]:
    """A concurrent join won the race: re-read the row that actually persisted
    so we never schedule a revoke against an id we failed to insert. Returns
    (membership_id, None) to continue, or (None, result_tuple) when the winner
    is a genuine member."""
    from fastapi import HTTPException

    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "role", "source"],
                "limit": 1,
            }
        },
    )
    row = rows[0] if isinstance(rows, list) and rows else None
    if row is None:
        raise HTTPException(
            status_code=409, detail="Membership changed concurrently, please retry."
        )
    if row.get("source") != "staff_support":
        return None, ("already_member", str(row["id"]), None)
    membership_id = str(row["id"])
    await async_directus.update_item(
        "workspace_membership", membership_id, {"expires_at": expires_iso}
    )
    return membership_id, None


async def grant_support_membership(
    *, workspace_id: str, app_user_id: str, org_id: Optional[str]
) -> tuple[str, str, Optional[str]]:
    """Create / reactivate / extend a 24h staff_support membership and (re)arm
    its durable revoke task. Shared by the staff self-join endpoint and the
    customer approve endpoint. Returns (status, membership_id, expires_iso).
    """
    from dembrane.cache_utils import invalidate_workspace_and_org_usage
    from dembrane.scheduled_tasks import (
        TASK_REVOKE_STAFF_SUPPORT,
        schedule_task,
        cancel_pending_tasks,
    )
    from dembrane.api.v2._invite_helpers import (
        create_membership_row,
        reactivate_membership_row,
    )

    now = datetime.now(timezone.utc)
    expires_at = now + SUPPORT_ACCESS_TTL
    expires_iso = expires_at.isoformat()

    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": app_user_id},
                },
                "fields": ["id", "role", "source", "deleted_at"],
                "limit": -1,
            }
        },
    )
    active_row = None
    deleted_row = None
    if isinstance(rows, list):
        for row in rows:
            if row.get("deleted_at") is None and active_row is None:
                active_row = row
            elif row.get("deleted_at") is not None and deleted_row is None:
                deleted_row = row

    if active_row is not None and active_row.get("source") != "staff_support":
        return ("already_member", str(active_row["id"]), None)

    if active_row is not None:
        membership_id = str(active_row["id"])
        await async_directus.update_item(
            "workspace_membership", membership_id, {"expires_at": expires_iso}
        )
        status = "extended"
    elif deleted_row is not None:
        membership_id = str(deleted_row["id"])
        reactivated = await reactivate_membership_row(
            async_directus,
            "workspace_membership",
            membership_id,
            {
                "deleted_at": None,
                "role": "admin",
                "source": "staff_support",
                "expires_at": expires_iso,
            },
        )
        if not reactivated:
            resolved_id, raced = await _reresolve_membership_after_join_race(
                workspace_id, app_user_id, expires_iso
            )
            if raced is not None:
                return raced
            assert resolved_id is not None
            membership_id = resolved_id
        status = "joined"
    else:
        membership_id = generate_uuid()
        created = await create_membership_row(
            async_directus,
            "workspace_membership",
            {
                "id": membership_id,
                "workspace_id": workspace_id,
                "user_id": app_user_id,
                "role": "admin",
                "source": "staff_support",
                "expires_at": expires_iso,
            },
        )
        if not created:
            resolved_id, raced = await _reresolve_membership_after_join_race(
                workspace_id, app_user_id, expires_iso
            )
            if raced is not None:
                return raced
            assert resolved_id is not None
            membership_id = resolved_id
        status = "joined"

    await cancel_pending_tasks(
        task_type=TASK_REVOKE_STAFF_SUPPORT,
        payload_match={"membership_id": membership_id},
    )
    await schedule_task(
        task_type=TASK_REVOKE_STAFF_SUPPORT,
        scheduled_at=expires_at,
        payload={
            "workspace_id": workspace_id,
            "membership_id": membership_id,
            "org_id": org_id,
        },
    )
    await invalidate_workspace_and_org_usage(workspace_id, org_id)
    return (status, membership_id, expires_iso)
```

- [ ] **Step 2: Slim the join endpoint and record events**

In `server/dembrane/api/v2/admin.py`, delete the local `_reresolve_membership_after_join_race` and the `SUPPORT_ACCESS_TTL` constant (both now live in `support_access.py`; grep for other references to `SUPPORT_ACCESS_TTL` in the file first, keep a re-export `from dembrane.support_access import SUPPORT_ACCESS_TTL` only if something else uses it). Replace the body of `join_workspace_support` after the toggle gate with:

```python
    from dembrane.app_user import get_app_user_or_raise
    from dembrane.support_access import (
        EVENT_STAFF_JOINED,
        EVENT_STAFF_EXTENDED,
        grant_support_membership,
        record_support_access_event,
    )

    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    org_id = ws.get("org_id")

    status, membership_id, expires_iso = await grant_support_membership(
        workspace_id=workspace_id, app_user_id=app_user_id, org_id=org_id
    )

    if status in ("joined", "extended"):
        await record_support_access_event(
            workspace_id=workspace_id,
            event_code=EVENT_STAFF_JOINED if status == "joined" else EVENT_STAFF_EXTENDED,
            actor_user_id=app_user_id,
            staff_user_id=app_user_id,
            params={"membership_id": membership_id, "expires_at": expires_iso},
        )

    role = "admin"
    if status == "already_member":
        row = await async_directus.get_item("workspace_membership", membership_id)
        role = (row or {}).get("role") or ""

    logger.info(
        "staff %s %s support access on workspace %s (membership=%s, expires=%s)",
        auth.user_id,
        status,
        workspace_id,
        membership_id,
        expires_iso,
    )
    return JoinSupportResponse(
        status=status,  # type: ignore[arg-type]
        workspace_id=workspace_id,
        membership_id=membership_id,
        role=role,
        expires_at=expires_iso,
    )
```

- [ ] **Step 3: Update the existing test patches (BOTH scaffolds)**

`test_join_support.py` has two parallel context managers, `_patched` and `_patched_race`. The race tests (`test_create_lost_race_*`) run under `_patched_race`, so the new patches MUST be added to both or they fail on an unpatched `dembrane.support_access.async_directus`. To each `ExitStack`, add:

```python
        stack.enter_context(
            patch("dembrane.support_access.async_directus", mocks.directus)
        )
        stack.enter_context(
            patch(
                "dembrane.support_access.record_support_access_event",
                mocks.record_event,
            )
        )
```

and add `record_event=AsyncMock(return_value="ev-1")` to both `SimpleNamespace`s.

- [ ] **Step 4: Add event assertions**

Append to `server/tests/test_join_support.py`:

```python
@pytest.mark.asyncio
async def test_join_records_staff_joined_event():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    with _patched(ws=ws, memberships=[]) as mocks:
        res = await _post(_build_app(is_admin=True))
    assert res.status_code == 200
    assert res.json()["status"] == "joined"
    kwargs = mocks.record_event.call_args.kwargs
    assert kwargs["event_code"] == "staff_joined"
    assert kwargs["staff_user_id"] == "au-staff"


@pytest.mark.asyncio
async def test_extend_records_staff_extended_event():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    existing = [
        {"id": "m-1", "role": "admin", "source": "staff_support", "deleted_at": None}
    ]
    with _patched(ws=ws, memberships=existing) as mocks:
        res = await _post(_build_app(is_admin=True))
    assert res.status_code == 200
    assert res.json()["status"] == "extended"
    assert mocks.record_event.call_args.kwargs["event_code"] == "staff_extended"
```

- [ ] **Step 5: Run the full join-support suite**

Run: `<PYTEST> tests/test_join_support.py tests/test_support_access_events.py`
Expected: all PASS (pre-existing tests prove the refactor kept behavior; the two new tests prove the events).

---

### Task 4: Staff request endpoints + request-expiry scheduled task

**Files:**
- Modify: `server/dembrane/scheduled_tasks.py` (add task type constants, near the existing registry block)
- Modify: `server/dembrane/api/v2/admin.py` (three endpoints, after `leave_workspace_support`)
- Modify: `server/dembrane/tasks.py` (`_dispatch_scheduled_task` additive branch + expiry handler)
- Test: `server/tests/test_support_access_requests.py`

**Interfaces:**
- Consumes: `record_support_access_event`, `REQUEST_COLLECTION`, `REQUEST_TTL`, `EVENT_REQUEST_CREATED/CANCELLED/EXPIRED` from Task 2; `schedule_task`/`cancel_pending_tasks`
- Produces:
  - `TASK_SUPPORT_TOGGLE_REMINDER = "support_toggle_reminder"` and `TASK_EXPIRE_SUPPORT_REQUEST = "expire_support_access_request"` in `scheduled_tasks.py` (both constants land here; Task 6 and Task 8 import them)
  - `POST /v2/admin/workspaces/{id}/support-access/request` returns `SupportAccessRequestOut {id, workspace_id, status, message, created_at, expires_at}`
  - `GET  /v2/admin/workspaces/{id}/support-access/request` returns `StaffSupportRequestStatus {support_access_enabled: bool, request: SupportAccessRequestOut | None}` (Task 9's UI keys off both fields)
  - `DELETE /v2/admin/workspaces/{id}/support-access/request` returns `StaffSupportRequestStatus`
  - `_run_expire_support_request(payload: dict) -> None` in `tasks.py`, dispatched for `TASK_EXPIRE_SUPPORT_REQUEST`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_support_access_requests.py` (same app/patch scaffolding style as `test_join_support.py`):

```python
"""Tests for the staff-side support access request endpoints (hybrid flow).

Toggle OFF: staff may create one pending request per workspace; the customer
is notified. Toggle ON: 409, staff should join directly. Cancel is idempotent.
"""

from __future__ import annotations

from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.admin import router as admin_router
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_WS_ID = "ws-1"
_ORG_ID = "org-1"


def _build_app(is_admin: bool = True) -> FastAPI:
    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id="du-staff", is_admin=is_admin)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(admin_router, prefix="/v2/admin")
    return app


@contextmanager
def _patched(ws: dict | None, requests_rows: list[dict]):
    directus = AsyncMock()

    async def get_item(collection: str, item_id: str):
        return ws if collection == "workspace" else None

    async def get_items(collection: str, params: dict | None = None):
        if collection == "support_access_request":
            return list(requests_rows)
        return []

    directus.get_item = AsyncMock(side_effect=get_item)
    directus.get_items = AsyncMock(side_effect=get_items)
    directus.create_item = AsyncMock(return_value={"data": {}})
    directus.update_item = AsyncMock(return_value={"data": {}})
    mocks = SimpleNamespace(
        directus=directus,
        record_event=AsyncMock(return_value="ev-1"),
        schedule=AsyncMock(return_value="task-1"),
        cancel=AsyncMock(return_value=1),
    )
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.api.v2.admin.async_directus", directus))
        stack.enter_context(patch("dembrane.support_access.async_directus", directus))
        stack.enter_context(
            patch(
                "dembrane.app_user.get_app_user_or_raise",
                AsyncMock(return_value={"id": "au-staff"}),
            )
        )
        stack.enter_context(
            patch(
                "dembrane.support_access.record_support_access_event",
                mocks.record_event,
            )
        )
        stack.enter_context(patch("dembrane.scheduled_tasks.schedule_task", mocks.schedule))
        stack.enter_context(
            patch("dembrane.scheduled_tasks.cancel_pending_tasks", mocks.cancel)
        )
        yield mocks


async def _call(app: FastAPI, method: str, json: dict | None = None):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.request(
            method,
            f"/v2/admin/workspaces/{_WS_ID}/support-access/request",
            json=json,
        )


_WS_OFF = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": False}
_WS_ON = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}


@pytest.mark.asyncio
async def test_non_staff_forbidden():
    with _patched(ws=_WS_OFF, requests_rows=[]):
        res = await _call(_build_app(is_admin=False), "POST", json={})
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_toggle_on_conflicts():
    with _patched(ws=_WS_ON, requests_rows=[]):
        res = await _call(_build_app(), "POST", json={})
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_create_request_schedules_expiry_and_records_event():
    with _patched(ws=_WS_OFF, requests_rows=[]) as mocks:
        res = await _call(_build_app(), "POST", json={"message": "billing bug"})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "pending"
    assert body["message"] == "billing bug"
    collection, payload = mocks.directus.create_item.call_args.args
    assert collection == "support_access_request"
    assert payload["requested_by"] == "au-staff"
    assert mocks.schedule.call_args.kwargs["task_type"] == "expire_support_access_request"
    assert mocks.record_event.call_args.kwargs["event_code"] == "request_created"
    assert mocks.record_event.call_args.kwargs["params"]["message"] == "billing bug"


@pytest.mark.asyncio
async def test_repeat_post_returns_existing_pending():
    pending = {
        "id": "req-1",
        "workspace_id": _WS_ID,
        "requested_by": "au-staff",
        "status": "pending",
        "message": None,
        "created_at": "2026-07-01T00:00:00+00:00",
        "expires_at": "2026-07-08T00:00:00+00:00",
    }
    with _patched(ws=_WS_OFF, requests_rows=[pending]) as mocks:
        res = await _call(_build_app(), "POST", json={})
    assert res.status_code == 200
    assert res.json()["id"] == "req-1"
    assert mocks.directus.create_item.await_count == 0
    assert mocks.record_event.await_count == 0


@pytest.mark.asyncio
async def test_get_reports_toggle_state_and_latest_request():
    with _patched(ws=_WS_ON, requests_rows=[]):
        res = await _call(_build_app(), "GET")
    assert res.status_code == 200
    body = res.json()
    assert body["support_access_enabled"] is True
    assert body["request"] is None


@pytest.mark.asyncio
async def test_delete_cancels_pending():
    pending = {
        "id": "req-1",
        "workspace_id": _WS_ID,
        "requested_by": "au-staff",
        "status": "pending",
        "message": None,
        "created_at": "2026-07-01T00:00:00+00:00",
        "expires_at": "2026-07-08T00:00:00+00:00",
    }
    with _patched(ws=_WS_OFF, requests_rows=[pending]) as mocks:
        res = await _call(_build_app(), "DELETE")
    assert res.status_code == 200
    args = mocks.directus.update_item.call_args.args
    assert args[0] == "support_access_request"
    assert args[1] == "req-1"
    assert args[2]["status"] == "cancelled"
    assert mocks.cancel.call_args.kwargs["payload_match"] == {"request_id": "req-1"}
    kwargs = mocks.record_event.call_args.kwargs
    assert kwargs["event_code"] == "request_cancelled"
    assert kwargs["notify"] is False


@pytest.mark.asyncio
async def test_delete_without_pending_is_idempotent():
    with _patched(ws=_WS_OFF, requests_rows=[]) as mocks:
        res = await _call(_build_app(), "DELETE")
    assert res.status_code == 200
    assert mocks.directus.update_item.await_count == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `<PYTEST> tests/test_support_access_requests.py`
Expected: FAIL with 404s (routes don't exist yet).

- [ ] **Step 3: Add the task-type constants**

In `server/dembrane/scheduled_tasks.py`, extend the existing task_type registry block (do not remove the existing constants, including `TASK_CANVAS_TICK`):

```python
TASK_SUPPORT_TOGGLE_REMINDER = "support_toggle_reminder"
TASK_EXPIRE_SUPPORT_REQUEST = "expire_support_access_request"
```

- [ ] **Step 4: Implement the three endpoints**

In `server/dembrane/api/v2/admin.py`, after `leave_workspace_support`, add:

```python
# ── Staff support access requests (hybrid flow) ──
#
# When the customer's toggle is OFF, staff can't self-join; they file a
# request instead. Workspace admins approve/deny it from workspace settings
# (api/v2/support_access.py). One pending request per (workspace, staff).


class SupportAccessRequestBody(BaseModel):
    message: Optional[str] = None


class SupportAccessRequestOut(BaseModel):
    id: str
    workspace_id: str
    status: str
    message: Optional[str] = None
    created_at: Optional[str] = None
    expires_at: Optional[str] = None


class StaffSupportRequestStatus(BaseModel):
    support_access_enabled: bool
    request: Optional[SupportAccessRequestOut] = None


def _request_out(row: dict) -> SupportAccessRequestOut:
    return SupportAccessRequestOut(
        id=str(row["id"]),
        workspace_id=str(row.get("workspace_id") or ""),
        status=row.get("status") or "",
        message=row.get("message"),
        created_at=row.get("created_at"),
        expires_at=row.get("expires_at"),
    )


async def _own_requests(workspace_id: str, app_user_id: str, status: Optional[str] = None) -> list[dict]:
    from dembrane.support_access import REQUEST_COLLECTION

    filter_: dict = {
        "workspace_id": {"_eq": workspace_id},
        "requested_by": {"_eq": app_user_id},
    }
    if status:
        filter_["status"] = {"_eq": status}
    rows = await async_directus.get_items(
        REQUEST_COLLECTION,
        {
            "query": {
                "filter": filter_,
                "fields": [
                    "id",
                    "workspace_id",
                    "requested_by",
                    "status",
                    "message",
                    "created_at",
                    "expires_at",
                ],
                "sort": ["-created_at"],
                "limit": 1,
            }
        },
    )
    return rows if isinstance(rows, list) else []


@router.post(
    "/workspaces/{workspace_id}/support-access/request",
    response_model=SupportAccessRequestOut,
)
async def request_workspace_support_access(
    workspace_id: str,
    body: SupportAccessRequestBody,
    auth: DependencyDirectusSession,
) -> SupportAccessRequestOut:
    """Staff-only: ask the workspace admins for support access while their
    toggle is off. Idempotent: an existing pending request is returned as-is.
    409 when the toggle is already on (join directly instead)."""
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")
    if ws.get("allow_support_access"):
        raise HTTPException(
            status_code=409,
            detail="Support access is already on for this workspace; join directly.",
        )

    from dembrane.app_user import get_app_user_or_raise
    from dembrane.support_access import (
        REQUEST_COLLECTION,
        REQUEST_TTL,
        EVENT_REQUEST_CREATED,
        record_support_access_event,
    )
    from dembrane.scheduled_tasks import TASK_EXPIRE_SUPPORT_REQUEST, schedule_task

    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    existing = await _own_requests(workspace_id, app_user_id, status="pending")
    if existing:
        return _request_out(existing[0])

    now = datetime.now(timezone.utc)
    expires_at = now + REQUEST_TTL
    message = (body.message or "").strip()[:2000] or None
    request_id = generate_uuid()
    row = {
        "id": request_id,
        "workspace_id": workspace_id,
        "requested_by": app_user_id,
        "status": "pending",
        "message": message,
        "created_at": now.isoformat(),
        "expires_at": expires_at.isoformat(),
    }
    await async_directus.create_item(REQUEST_COLLECTION, row)
    await schedule_task(
        task_type=TASK_EXPIRE_SUPPORT_REQUEST,
        scheduled_at=expires_at,
        payload={"request_id": request_id, "workspace_id": workspace_id},
    )
    await record_support_access_event(
        workspace_id=workspace_id,
        event_code=EVENT_REQUEST_CREATED,
        actor_user_id=app_user_id,
        staff_user_id=app_user_id,
        params={"request_id": request_id, "message": message},
    )
    logger.info(
        "staff %s requested support access on workspace %s (request=%s)",
        auth.user_id,
        workspace_id,
        request_id,
    )
    return _request_out(row)


@router.get(
    "/workspaces/{workspace_id}/support-access/request",
    response_model=StaffSupportRequestStatus,
)
async def get_workspace_support_request(
    workspace_id: str,
    auth: DependencyDirectusSession,
) -> StaffSupportRequestStatus:
    """Staff-only: the caller's latest request plus the toggle state, so the
    admin UI can choose between Join, Request, and Pending affordances."""
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    from dembrane.app_user import get_app_user_or_raise

    app_user = await get_app_user_or_raise(auth.user_id)
    rows = await _own_requests(workspace_id, app_user["id"])
    return StaffSupportRequestStatus(
        support_access_enabled=bool(ws.get("allow_support_access")),
        request=_request_out(rows[0]) if rows else None,
    )


@router.delete(
    "/workspaces/{workspace_id}/support-access/request",
    response_model=StaffSupportRequestStatus,
)
async def cancel_workspace_support_request(
    workspace_id: str,
    auth: DependencyDirectusSession,
) -> StaffSupportRequestStatus:
    """Staff-only: withdraw the caller's own pending request (idempotent)."""
    if not auth.is_admin:
        raise HTTPException(status_code=403, detail="Staff-only")

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    from dembrane.app_user import get_app_user_or_raise
    from dembrane.support_access import (
        REQUEST_COLLECTION,
        EVENT_REQUEST_CANCELLED,
        record_support_access_event,
    )
    from dembrane.scheduled_tasks import TASK_EXPIRE_SUPPORT_REQUEST, cancel_pending_tasks

    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    pending = await _own_requests(workspace_id, app_user_id, status="pending")
    if pending:
        request_id = str(pending[0]["id"])
        await async_directus.update_item(
            REQUEST_COLLECTION,
            request_id,
            {
                "status": "cancelled",
                "resolved_at": datetime.now(timezone.utc).isoformat(),
                "resolved_by": app_user_id,
            },
        )
        await cancel_pending_tasks(
            task_type=TASK_EXPIRE_SUPPORT_REQUEST,
            payload_match={"request_id": request_id},
        )
        await record_support_access_event(
            workspace_id=workspace_id,
            event_code=EVENT_REQUEST_CANCELLED,
            actor_user_id=app_user_id,
            staff_user_id=app_user_id,
            params={"request_id": request_id, "reason": "withdrawn"},
            notify=False,
        )
    rows = await _own_requests(workspace_id, app_user_id)
    return StaffSupportRequestStatus(
        support_access_enabled=bool(ws.get("allow_support_access")),
        request=_request_out(rows[0]) if rows else None,
    )
```

- [ ] **Step 5: Add the expiry handler and dispatch entry (ADDITIVE)**

In `server/dembrane/tasks.py`, `_dispatch_scheduled_task` currently has three branches (`TASK_REVOKE_STAFF_SUPPORT`, `TASK_GENERATE_REPORT`, `TASK_CANVAS_TICK`). Add the new task type to the import tuple and insert one `elif` above the `else`. DO NOT remove `TASK_CANVAS_TICK`. Target state (Task 8 will add the reminder branch too):

```python
def _dispatch_scheduled_task(row: dict) -> None:
    from dembrane.scheduled_tasks import (
        TASK_CANVAS_TICK,
        TASK_GENERATE_REPORT,
        TASK_REVOKE_STAFF_SUPPORT,
        TASK_EXPIRE_SUPPORT_REQUEST,
    )

    task_type = row.get("task_type")
    payload = row.get("payload") or {}
    if task_type == TASK_REVOKE_STAFF_SUPPORT:
        _run_revoke_staff_support(payload)
    elif task_type == TASK_GENERATE_REPORT:
        _run_generate_report(payload)
    elif task_type == TASK_CANVAS_TICK:
        _run_canvas_tick(payload)
    elif task_type == TASK_EXPIRE_SUPPORT_REQUEST:
        _run_expire_support_request(payload)
    else:
        raise ValueError(f"unknown scheduled_task type: {task_type!r}")
```

and add below `_run_generate_report`:

```python
async def _expire_support_request_async(request_id: str) -> bool:
    """Flip a still-pending support access request to expired and tell the
    requester. Status-guarded: an approval/denial/cancel that raced the timer
    wins and this is a no-op."""
    from dembrane.directus_async import async_directus
    from dembrane.support_access import (
        REQUEST_COLLECTION,
        EVENT_REQUEST_EXPIRED,
        record_support_access_event,
    )

    req = await async_directus.get_item(REQUEST_COLLECTION, request_id)
    if not req or req.get("status") != "pending":
        return False
    await async_directus.update_item(
        REQUEST_COLLECTION,
        request_id,
        {"status": "expired", "resolved_at": get_utc_timestamp().isoformat()},
    )
    await record_support_access_event(
        workspace_id=str(req.get("workspace_id")),
        event_code=EVENT_REQUEST_EXPIRED,
        staff_user_id=req.get("requested_by"),
        params={"request_id": request_id},
    )
    return True


def _run_expire_support_request(payload: dict) -> None:
    """Handler: expire a pending support access request (idempotent)."""
    task_logger = getLogger("dembrane.tasks.expire_support_request")
    request_id = payload.get("request_id")
    if not request_id:
        raise ValueError("expire_support_access_request payload missing request_id")
    expired = run_async_in_new_loop(_expire_support_request_async(str(request_id)))
    task_logger.info(
        "support access request %s %s", request_id, "expired" if expired else "already resolved; no-op"
    )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `<PYTEST> tests/test_support_access_requests.py tests/test_join_support.py`
Expected: all PASS.

---

### Task 5: Client-side v2 router (events list, pending requests, approve, deny)

**Files:**
- Create: `server/dembrane/api/v2/support_access.py`
- Modify: `server/dembrane/api/v2/__init__.py` (import + `include_router` in the workspace-scoped block)
- Test: `server/tests/test_support_access_client.py`

**Interfaces:**
- Consumes: `get_workspace_context` middleware (`ctx.workspace_id`, `ctx.workspace`, `ctx.app_user_id`, `ctx.require_policy("settings:manage")`), `grant_support_membership` (Task 3), `record_support_access_event`, `REQUEST_COLLECTION`, `EVENT_COLLECTION`
- Produces (Task 10's UI calls these):
  - `GET  /v2/workspaces/{id}/support-access/events?page=1&limit=20` returns `{events: [{id, event_code, created_at, actor_name, staff_name, params}], has_more: bool}`
  - `GET  /v2/workspaces/{id}/support-access/requests` returns `{requests: [{id, requested_by_name, message, created_at, expires_at}]}` (pending only)
  - `POST /v2/workspaces/{id}/support-access/requests/{request_id}/approve` returns `{status: "approved", expires_at}`
  - `POST /v2/workspaces/{id}/support-access/requests/{request_id}/deny` returns `{status: "denied"}`

> Note: a similarly-named `access_requests_router` already exists in `api/v2/__init__.py` for workspace join requests. It is unrelated. The new router variable is `support_access_router`; do not conflate them.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_support_access_client.py`:

```python
"""Tests for the client-facing support access endpoints: the audit log the
customer sees, and approve/deny on pending staff requests. All four routes
are gated on settings:manage via the workspace context."""

from __future__ import annotations

from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI, HTTPException

from dembrane.api.v2.support_access import router as support_access_router
from dembrane.api.v2.middleware import get_workspace_context

_WS_ID = "ws-1"


class _FakeCtx:
    def __init__(self, can_manage: bool = True):
        self.workspace_id = _WS_ID
        self.workspace = {"id": _WS_ID, "org_id": "org-1", "allow_support_access": False}
        self.app_user_id = "au-admin"
        self._can_manage = can_manage

    def require_policy(self, policy: str) -> None:
        if not self._can_manage:
            raise HTTPException(status_code=403, detail="Forbidden")


def _build_app(can_manage: bool = True) -> FastAPI:
    app = FastAPI()
    app.dependency_overrides[get_workspace_context] = lambda: _FakeCtx(can_manage)
    app.include_router(support_access_router, prefix="/v2/workspaces")
    return app


_PENDING = {
    "id": "req-1",
    "workspace_id": _WS_ID,
    "requested_by": "au-staff",
    "status": "pending",
    "message": "billing bug",
    "created_at": "2026-07-01T00:00:00+00:00",
    "expires_at": "2099-01-01T00:00:00+00:00",
}


@contextmanager
def _patched(request_row: dict | None = None, events: list[dict] | None = None):
    directus = AsyncMock()

    async def get_item(collection: str, item_id: str):
        if collection == "support_access_request":
            return dict(request_row) if request_row else None
        return None

    async def get_items(collection: str, params: dict | None = None):
        if collection == "support_access_event":
            return list(events or [])
        if collection == "support_access_request":
            return [dict(request_row)] if request_row else []
        if collection == "app_user":
            return [
                {"id": "au-staff", "display_name": "Sam Staff"},
                {"id": "au-admin", "display_name": "Ada Admin"},
            ]
        return []

    directus.get_item = AsyncMock(side_effect=get_item)
    directus.get_items = AsyncMock(side_effect=get_items)
    directus.update_item = AsyncMock(return_value={"data": {}})
    mocks = SimpleNamespace(
        directus=directus,
        grant=AsyncMock(return_value=("joined", "m-1", "2026-07-04T00:00:00+00:00")),
        record_event=AsyncMock(return_value="ev-1"),
        cancel=AsyncMock(return_value=1),
    )
    with ExitStack() as stack:
        stack.enter_context(
            patch("dembrane.api.v2.support_access.async_directus", directus)
        )
        stack.enter_context(
            patch("dembrane.support_access.grant_support_membership", mocks.grant)
        )
        stack.enter_context(
            patch(
                "dembrane.support_access.record_support_access_event",
                mocks.record_event,
            )
        )
        stack.enter_context(
            patch("dembrane.scheduled_tasks.cancel_pending_tasks", mocks.cancel)
        )
        yield mocks


async def _get(app: FastAPI, path: str):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.get(f"/v2/workspaces/{_WS_ID}{path}")


async def _post(app: FastAPI, path: str):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.post(f"/v2/workspaces/{_WS_ID}{path}")


@pytest.mark.asyncio
async def test_events_requires_settings_manage():
    with _patched():
        res = await _get(_build_app(can_manage=False), "/support-access/events")
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_events_lists_with_names_and_has_more():
    events = [
        {
            "id": f"ev-{i}",
            "event_code": "staff_joined",
            "created_at": "2026-07-01T00:00:00+00:00",
            "actor_user_id": "au-staff",
            "staff_user_id": "au-staff",
            "params": {},
        }
        for i in range(3)
    ]
    with _patched(events=events):
        res = await _get(_build_app(), "/support-access/events?page=1&limit=2")
    assert res.status_code == 200
    body = res.json()
    assert len(body["events"]) == 2
    assert body["has_more"] is True
    assert body["events"][0]["staff_name"] == "Sam Staff"


@pytest.mark.asyncio
async def test_pending_requests_resolve_requester_name():
    with _patched(request_row=_PENDING):
        res = await _get(_build_app(), "/support-access/requests")
    assert res.status_code == 200
    body = res.json()
    assert body["requests"][0]["requested_by_name"] == "Sam Staff"
    assert body["requests"][0]["message"] == "billing bug"


@pytest.mark.asyncio
async def test_approve_grants_membership_and_resolves_request():
    with _patched(request_row=_PENDING) as mocks:
        res = await _post(_build_app(), "/support-access/requests/req-1/approve")
    assert res.status_code == 200
    assert res.json()["status"] == "approved"
    assert mocks.grant.call_args.kwargs["app_user_id"] == "au-staff"
    update_args = mocks.directus.update_item.call_args.args
    assert update_args[0] == "support_access_request"
    assert update_args[2]["status"] == "approved"
    assert update_args[2]["membership_id"] == "m-1"
    assert mocks.cancel.call_args.kwargs["payload_match"] == {"request_id": "req-1"}
    assert mocks.record_event.call_args.kwargs["event_code"] == "request_approved"


@pytest.mark.asyncio
async def test_approve_non_pending_conflicts():
    resolved = dict(_PENDING, status="denied")
    with _patched(request_row=resolved):
        res = await _post(_build_app(), "/support-access/requests/req-1/approve")
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_approve_elapsed_request_conflicts_and_expires():
    stale = dict(_PENDING, expires_at="2020-01-01T00:00:00+00:00")
    with _patched(request_row=stale) as mocks:
        res = await _post(_build_app(), "/support-access/requests/req-1/approve")
    assert res.status_code == 409
    assert mocks.directus.update_item.call_args.args[2]["status"] == "expired"


@pytest.mark.asyncio
async def test_approve_missing_request_404():
    with _patched(request_row=None):
        res = await _post(_build_app(), "/support-access/requests/req-x/approve")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_deny_resolves_and_records():
    with _patched(request_row=_PENDING) as mocks:
        res = await _post(_build_app(), "/support-access/requests/req-1/deny")
    assert res.status_code == 200
    assert res.json()["status"] == "denied"
    assert mocks.directus.update_item.call_args.args[2]["status"] == "denied"
    assert mocks.record_event.call_args.kwargs["event_code"] == "request_denied"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `<PYTEST> tests/test_support_access_client.py`
Expected: FAIL with `ModuleNotFoundError` on `dembrane.api.v2.support_access`.

- [ ] **Step 3: Implement the router**

Create `server/dembrane/api/v2/support_access.py`:

```python
"""Client-facing staff support access: audit log + request approve/deny.

The customer side of the hybrid flow. Staff file requests via
api/v2/admin.py; workspace admins see and resolve them here, and can read the
per-workspace access history. Everything requires settings:manage, the same
policy that guards the allow_support_access toggle.
"""

from typing import Any, Optional, Annotated
from logging import getLogger
from datetime import datetime, timezone

from fastapi import Depends, Query, APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context

router = APIRouter()
logger = getLogger("api.v2.support_access")

DependencyWorkspaceContext = Annotated[WorkspaceContext, Depends(get_workspace_context)]


# ── Audit log ──


class SupportAccessEventOut(BaseModel):
    id: str
    event_code: str
    created_at: Optional[str] = None
    actor_name: Optional[str] = None
    staff_name: Optional[str] = None
    params: Optional[dict[str, Any]] = None


class SupportAccessEventsResponse(BaseModel):
    events: list[SupportAccessEventOut]
    has_more: bool


async def _names_for(user_ids: list[str]) -> dict[str, str]:
    ids = [u for u in user_ids if u]
    if not ids:
        return {}
    rows = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"id": {"_in": ids}},
                "fields": ["id", "display_name"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return {}
    return {str(r["id"]): r.get("display_name") or "" for r in rows if r.get("id")}


@router.get(
    "/{workspace_id}/support-access/events",
    response_model=SupportAccessEventsResponse,
)
async def list_support_access_events(
    ctx: DependencyWorkspaceContext,
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
) -> SupportAccessEventsResponse:
    """The workspace's staff-access history, newest first. settings:manage
    only: this is the audience that controls the toggle."""
    ctx.require_policy("settings:manage")

    from dembrane.support_access import EVENT_COLLECTION

    rows = await async_directus.get_items(
        EVENT_COLLECTION,
        {
            "query": {
                "filter": {"workspace_id": {"_eq": ctx.workspace_id}},
                "fields": [
                    "id",
                    "event_code",
                    "created_at",
                    "actor_user_id",
                    "staff_user_id",
                    "params",
                ],
                "sort": ["-created_at"],
                "limit": limit + 1,
                "offset": (page - 1) * limit,
            }
        },
    )
    rows = rows if isinstance(rows, list) else []
    has_more = len(rows) > limit
    rows = rows[:limit]
    names = await _names_for(
        [r.get("actor_user_id") for r in rows] + [r.get("staff_user_id") for r in rows]
    )
    return SupportAccessEventsResponse(
        events=[
            SupportAccessEventOut(
                id=str(r["id"]),
                event_code=r.get("event_code") or "",
                created_at=r.get("created_at"),
                actor_name=names.get(str(r.get("actor_user_id"))) or None,
                staff_name=names.get(str(r.get("staff_user_id"))) or None,
                params=r.get("params") or {},
            )
            for r in rows
        ],
        has_more=has_more,
    )


# ── Pending requests + approve / deny ──


class PendingSupportRequestOut(BaseModel):
    id: str
    requested_by_name: str
    message: Optional[str] = None
    created_at: Optional[str] = None
    expires_at: Optional[str] = None


class PendingSupportRequestsResponse(BaseModel):
    requests: list[PendingSupportRequestOut]


class ResolveSupportRequestResponse(BaseModel):
    status: str
    expires_at: Optional[str] = None


@router.get(
    "/{workspace_id}/support-access/requests",
    response_model=PendingSupportRequestsResponse,
)
async def list_pending_support_requests(
    ctx: DependencyWorkspaceContext,
) -> PendingSupportRequestsResponse:
    ctx.require_policy("settings:manage")

    from dembrane.support_access import REQUEST_COLLECTION

    rows = await async_directus.get_items(
        REQUEST_COLLECTION,
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ctx.workspace_id},
                    "status": {"_eq": "pending"},
                },
                "fields": [
                    "id",
                    "requested_by",
                    "message",
                    "created_at",
                    "expires_at",
                ],
                "sort": ["-created_at"],
                "limit": -1,
            }
        },
    )
    rows = rows if isinstance(rows, list) else []
    names = await _names_for([r.get("requested_by") for r in rows])
    return PendingSupportRequestsResponse(
        requests=[
            PendingSupportRequestOut(
                id=str(r["id"]),
                requested_by_name=names.get(str(r.get("requested_by")))
                or "dembrane staff",
                message=r.get("message"),
                created_at=r.get("created_at"),
                expires_at=r.get("expires_at"),
            )
            for r in rows
        ]
    )


async def _load_pending_request(ctx: WorkspaceContext, request_id: str) -> dict:
    """Fetch + validate a request row for approve/deny. 404 on wrong
    workspace or missing; 409 when it already left pending (including a lazy
    expiry when the timer hasn't fired yet)."""
    from dembrane.support_access import (
        REQUEST_COLLECTION,
        EVENT_REQUEST_EXPIRED,
        record_support_access_event,
    )

    req = await async_directus.get_item(REQUEST_COLLECTION, request_id)
    if not req or str(req.get("workspace_id")) != str(ctx.workspace_id):
        raise HTTPException(status_code=404, detail="Request not found")
    if req.get("status") != "pending":
        raise HTTPException(
            status_code=409, detail=f"Request is already {req.get('status')}."
        )
    expires_at = req.get("expires_at")
    if expires_at and expires_at <= datetime.now(timezone.utc).isoformat():
        await async_directus.update_item(
            REQUEST_COLLECTION,
            request_id,
            {
                "status": "expired",
                "resolved_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        await record_support_access_event(
            workspace_id=ctx.workspace_id,
            event_code=EVENT_REQUEST_EXPIRED,
            staff_user_id=req.get("requested_by"),
            params={"request_id": request_id},
        )
        raise HTTPException(status_code=409, detail="Request expired.")
    return req


@router.post(
    "/{workspace_id}/support-access/requests/{request_id}/approve",
    response_model=ResolveSupportRequestResponse,
)
async def approve_support_request(
    request_id: str,
    ctx: DependencyWorkspaceContext,
) -> ResolveSupportRequestResponse:
    """Approve a pending staff request: a one-time consented 24h grant. The
    allow_support_access toggle stays off."""
    ctx.require_policy("settings:manage")

    from dembrane.support_access import (
        REQUEST_COLLECTION,
        EVENT_REQUEST_APPROVED,
        grant_support_membership,
        record_support_access_event,
    )
    from dembrane.scheduled_tasks import TASK_EXPIRE_SUPPORT_REQUEST, cancel_pending_tasks

    req = await _load_pending_request(ctx, request_id)
    staff_app_user_id = str(req.get("requested_by"))

    _status, membership_id, expires_iso = await grant_support_membership(
        workspace_id=ctx.workspace_id,
        app_user_id=staff_app_user_id,
        org_id=ctx.workspace.get("org_id"),
    )
    await async_directus.update_item(
        REQUEST_COLLECTION,
        request_id,
        {
            "status": "approved",
            "resolved_at": datetime.now(timezone.utc).isoformat(),
            "resolved_by": ctx.app_user_id,
            "membership_id": membership_id,
        },
    )
    await cancel_pending_tasks(
        task_type=TASK_EXPIRE_SUPPORT_REQUEST,
        payload_match={"request_id": request_id},
    )
    await record_support_access_event(
        workspace_id=ctx.workspace_id,
        event_code=EVENT_REQUEST_APPROVED,
        actor_user_id=ctx.app_user_id,
        staff_user_id=staff_app_user_id,
        params={
            "request_id": request_id,
            "membership_id": membership_id,
            "expires_at": expires_iso,
        },
    )
    logger.info(
        "support request %s approved on workspace %s (membership=%s)",
        request_id,
        ctx.workspace_id,
        membership_id,
    )
    return ResolveSupportRequestResponse(status="approved", expires_at=expires_iso)


@router.post(
    "/{workspace_id}/support-access/requests/{request_id}/deny",
    response_model=ResolveSupportRequestResponse,
)
async def deny_support_request(
    request_id: str,
    ctx: DependencyWorkspaceContext,
) -> ResolveSupportRequestResponse:
    ctx.require_policy("settings:manage")

    from dembrane.support_access import (
        REQUEST_COLLECTION,
        EVENT_REQUEST_DENIED,
        record_support_access_event,
    )
    from dembrane.scheduled_tasks import TASK_EXPIRE_SUPPORT_REQUEST, cancel_pending_tasks

    req = await _load_pending_request(ctx, request_id)
    await async_directus.update_item(
        REQUEST_COLLECTION,
        request_id,
        {
            "status": "denied",
            "resolved_at": datetime.now(timezone.utc).isoformat(),
            "resolved_by": ctx.app_user_id,
        },
    )
    await cancel_pending_tasks(
        task_type=TASK_EXPIRE_SUPPORT_REQUEST,
        payload_match={"request_id": request_id},
    )
    await record_support_access_event(
        workspace_id=ctx.workspace_id,
        event_code=EVENT_REQUEST_DENIED,
        actor_user_id=ctx.app_user_id,
        staff_user_id=str(req.get("requested_by")),
        params={"request_id": request_id},
    )
    return ResolveSupportRequestResponse(status="denied")
```

- [ ] **Step 4: Register the router**

In `server/dembrane/api/v2/__init__.py`, next to the `workspace_settings_router` import:

```python
from dembrane.api.v2.support_access import router as support_access_router
```

and in the workspace-scoped `include_router` block (with the other `prefix="/workspaces"` routers):

```python
v2_router.include_router(
    support_access_router, prefix="/workspaces", tags=["v2:support-access"]
)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `<PYTEST> tests/test_support_access_client.py`
Expected: all 9 PASS.

---

### Task 6: Toggle hooks (events, reminder scheduling, pending auto-cancel)

**Files:**
- Modify: `server/dembrane/support_access.py` (add `cancel_pending_requests_for_toggle_on`)
- Modify: `server/dembrane/api/v2/workspace_settings.py` (`update_workspace_settings`)
- Test: `server/tests/test_support_access_toggle_hooks.py`

**Interfaces:**
- Consumes: `TASK_SUPPORT_TOGGLE_REMINDER`, `TASK_EXPIRE_SUPPORT_REQUEST`, `schedule_task`, `cancel_pending_tasks`, `record_support_access_event`, `REMINDER_INTERVAL`
- Produces: `async def cancel_pending_requests_for_toggle_on(*, workspace_id: str, actor_user_id: str | None) -> int` in `dembrane/support_access.py`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_support_access_toggle_hooks.py`:

```python
"""Toggle PATCH side effects: flipping allow_support_access on schedules the
7-day reminder, records the event, and supersedes pending requests; flipping
it off cancels reminders and records. Same-value writes do nothing."""

from __future__ import annotations

from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.workspace_settings import router as settings_router
from dembrane.api.v2.middleware import get_workspace_context

_WS_ID = "ws-1"


class _FakeCtx:
    def __init__(self, toggle_on: bool):
        self.workspace_id = _WS_ID
        self.workspace = {
            "id": _WS_ID,
            "org_id": "org-1",
            "allow_support_access": toggle_on,
            "visibility": "open_to_organisation",
            "logo_url": None,
        }
        self.app_user_id = "au-admin"

    def require_policy(self, policy: str) -> None:
        return None

    def has_policy(self, policy: str) -> bool:
        return True


def _build_app(toggle_on: bool) -> FastAPI:
    app = FastAPI()
    app.dependency_overrides[get_workspace_context] = lambda: _FakeCtx(toggle_on)
    app.include_router(settings_router, prefix="/v2/workspaces")
    return app


@contextmanager
def _patched():
    directus = AsyncMock()
    directus.update_item = AsyncMock(return_value={"data": {}})
    mocks = SimpleNamespace(
        directus=directus,
        record_event=AsyncMock(return_value="ev-1"),
        schedule=AsyncMock(return_value="task-1"),
        cancel=AsyncMock(return_value=1),
        supersede=AsyncMock(return_value=0),
    )
    with ExitStack() as stack:
        stack.enter_context(
            patch("dembrane.api.v2.workspace_settings.async_directus", directus)
        )
        stack.enter_context(
            patch(
                "dembrane.support_access.record_support_access_event",
                mocks.record_event,
            )
        )
        stack.enter_context(patch("dembrane.scheduled_tasks.schedule_task", mocks.schedule))
        stack.enter_context(
            patch("dembrane.scheduled_tasks.cancel_pending_tasks", mocks.cancel)
        )
        stack.enter_context(
            patch(
                "dembrane.support_access.cancel_pending_requests_for_toggle_on",
                mocks.supersede,
            )
        )
        yield mocks


async def _patch_settings(app: FastAPI, body: dict):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.patch(f"/v2/workspaces/{_WS_ID}/settings", json=body)


@pytest.mark.asyncio
async def test_enable_schedules_reminder_and_supersedes_pending():
    with _patched() as mocks:
        res = await _patch_settings(_build_app(toggle_on=False), {"allow_support_access": True})
    assert res.status_code == 200
    assert mocks.schedule.call_args.kwargs["task_type"] == "support_toggle_reminder"
    assert mocks.schedule.call_args.kwargs["payload"] == {"workspace_id": _WS_ID}
    assert mocks.record_event.call_args.kwargs["event_code"] == "toggle_enabled"
    assert mocks.supersede.await_count == 1


@pytest.mark.asyncio
async def test_disable_cancels_reminder_and_records():
    with _patched() as mocks:
        res = await _patch_settings(_build_app(toggle_on=True), {"allow_support_access": False})
    assert res.status_code == 200
    assert mocks.cancel.call_args.kwargs["task_type"] == "support_toggle_reminder"
    assert mocks.record_event.call_args.kwargs["event_code"] == "toggle_disabled"
    assert mocks.supersede.await_count == 0


@pytest.mark.asyncio
async def test_same_value_is_a_no_op():
    with _patched() as mocks:
        res = await _patch_settings(_build_app(toggle_on=True), {"allow_support_access": True})
    assert res.status_code == 200
    assert mocks.schedule.await_count == 0
    assert mocks.record_event.await_count == 0


@pytest.mark.asyncio
async def test_unrelated_update_is_untouched():
    with _patched() as mocks:
        res = await _patch_settings(_build_app(toggle_on=True), {"name": "New Name"})
    assert res.status_code == 200
    assert mocks.record_event.await_count == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `<PYTEST> tests/test_support_access_toggle_hooks.py`
Expected: the two hook tests FAIL (no scheduling/recording happens yet); the no-op tests may already pass.

- [ ] **Step 3: Add `cancel_pending_requests_for_toggle_on`**

In `server/dembrane/support_access.py`, add below `send_support_access_notice`:

```python
async def cancel_pending_requests_for_toggle_on(
    *, workspace_id: str, actor_user_id: Optional[str]
) -> int:
    """The toggle just turned on: pending requests are moot because staff can
    join directly. Cancel each, cancel its expiry timer, and tell the
    requester they can come in. Returns the count superseded."""
    from dembrane.scheduled_tasks import TASK_EXPIRE_SUPPORT_REQUEST, cancel_pending_tasks

    rows = await async_directus.get_items(
        REQUEST_COLLECTION,
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "status": {"_eq": "pending"},
                },
                "fields": ["id", "requested_by"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        return 0
    now_iso = datetime.now(timezone.utc).isoformat()
    for row in rows:
        request_id = str(row["id"])
        await async_directus.update_item(
            REQUEST_COLLECTION,
            request_id,
            {"status": "cancelled", "resolved_at": now_iso, "resolved_by": actor_user_id},
        )
        await cancel_pending_tasks(
            task_type=TASK_EXPIRE_SUPPORT_REQUEST,
            payload_match={"request_id": request_id},
        )
        await record_support_access_event(
            workspace_id=workspace_id,
            event_code=EVENT_REQUEST_CANCELLED,
            actor_user_id=actor_user_id,
            staff_user_id=row.get("requested_by"),
            params={"request_id": request_id, "reason": "toggle_enabled"},
        )
    return len(rows)
```

- [ ] **Step 4: Hook the toggle PATCH (side effects wrapped in try/except)**

In `server/dembrane/api/v2/workspace_settings.py`, `update_workspace_settings`: capture the previous value from `ctx.workspace` (the pre-update snapshot) before building the payload, and run the side effects AFTER the update commits, inside a try/except so a scheduler or Directus hiccup can never 500 a settings write that already succeeded. `logger` already exists at module level. Replace the tail of the function (the current `if body.allow_support_access is not None:` block through `return`) with:

```python
    # Support access is a plain customer-controlled boolean. settings:manage
    # (required above) already restricts this to workspace admins/owners.
    support_access_changed = False
    if body.allow_support_access is not None:
        previous = bool(ctx.workspace.get("allow_support_access"))
        support_access_changed = body.allow_support_access != previous
        payload["allow_support_access"] = body.allow_support_access

    if not payload:
        raise HTTPException(status_code=400, detail="Nothing to update")

    await async_directus.update_item("workspace", ctx.workspace_id, payload)

    # Side effects run AFTER the toggle write commits. Wrap them so a scheduler
    # or Directus hiccup can never 500 a settings write that already succeeded.
    if support_access_changed:
        try:
            from dembrane.support_access import (
                REMINDER_INTERVAL,
                EVENT_TOGGLE_ENABLED,
                EVENT_TOGGLE_DISABLED,
                record_support_access_event,
                cancel_pending_requests_for_toggle_on,
            )
            from dembrane.scheduled_tasks import (
                TASK_SUPPORT_TOGGLE_REMINDER,
                schedule_task,
                cancel_pending_tasks,
            )

            if body.allow_support_access:
                await schedule_task(
                    task_type=TASK_SUPPORT_TOGGLE_REMINDER,
                    scheduled_at=datetime.now(timezone.utc) + REMINDER_INTERVAL,
                    payload={"workspace_id": ctx.workspace_id},
                )
                await record_support_access_event(
                    workspace_id=ctx.workspace_id,
                    event_code=EVENT_TOGGLE_ENABLED,
                    actor_user_id=ctx.app_user_id,
                )
                await cancel_pending_requests_for_toggle_on(
                    workspace_id=ctx.workspace_id, actor_user_id=ctx.app_user_id
                )
            else:
                await cancel_pending_tasks(
                    task_type=TASK_SUPPORT_TOGGLE_REMINDER,
                    payload_match={"workspace_id": ctx.workspace_id},
                )
                await record_support_access_event(
                    workspace_id=ctx.workspace_id,
                    event_code=EVENT_TOGGLE_DISABLED,
                    actor_user_id=ctx.app_user_id,
                )
        except Exception:
            logger.exception(
                "support-access side effects failed after toggle write (ws=%s)",
                ctx.workspace_id,
            )

    return {"status": "success"}
```

(`datetime`/`timezone` are already imported at the top of the file.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `<PYTEST> tests/test_support_access_toggle_hooks.py`
Expected: all 4 PASS.

---

### Task 7: Auto-off when the last staff session ends

**Files:**
- Modify: `server/dembrane/support_access.py` (add `maybe_auto_disable_support_access`)
- Modify: `server/dembrane/api/v2/admin.py` (`leave_workspace_support`)
- Modify: `server/dembrane/tasks.py` (`_revoke_staff_support_async`)
- Test: `server/tests/test_support_access_autooff.py`

**Interfaces:**
- Consumes: `inheritance.membership_access_expired`, `TASK_SUPPORT_TOGGLE_REMINDER`, `cancel_pending_tasks`, `record_support_access_event`, `send_support_access_notice`
- Produces: `async def maybe_auto_disable_support_access(*, workspace_id: str) -> bool` in `dembrane/support_access.py` (True when it turned the toggle off)

> Efficiency note: `maybe_auto_disable_support_access` is intentionally routed through `_revoke_staff_support_async` so all three revoke paths (leave, 24h auto-revoke, 15-min sweep) inherit it from one place. During a sweep that revokes several rows in one workspace, auto-off runs once per row, but the toggle-first guard makes every call after the first return right after a single `get_item`. This bounded redundancy is deliberate; do NOT "optimize" it by wiring auto-off separately into the sweep (that reintroduces a double-fire path).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_support_access_autooff.py`:

```python
"""Auto-off: when the last active staff_support membership ends, the toggle
flips off, reminder timers are cancelled, and the customer gets ONE combined
"session ended, access turned off" notice. Another active session, or a
toggle that is already off, must leave everything alone."""

from __future__ import annotations

from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest

from dembrane import support_access as sa

_WS_ID = "ws-1"


@contextmanager
def _patched(ws: dict, active_rows: list[dict]):
    directus = AsyncMock()
    directus.get_item = AsyncMock(return_value=ws)
    directus.get_items = AsyncMock(return_value=active_rows)
    directus.update_item = AsyncMock(return_value={"data": {}})
    mocks = SimpleNamespace(
        directus=directus,
        record_event=AsyncMock(return_value="ev-1"),
        cancel=AsyncMock(return_value=1),
    )
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.support_access.async_directus", directus))
        stack.enter_context(
            patch(
                "dembrane.support_access.record_support_access_event",
                mocks.record_event,
            )
        )
        stack.enter_context(
            patch("dembrane.scheduled_tasks.cancel_pending_tasks", mocks.cancel)
        )
        yield mocks


@pytest.mark.asyncio
async def test_last_staff_out_flips_toggle_and_records():
    ws = {"id": _WS_ID, "allow_support_access": True}
    with _patched(ws, active_rows=[]) as mocks:
        flipped = await sa.maybe_auto_disable_support_access(workspace_id=_WS_ID)
    assert flipped is True
    args = mocks.directus.update_item.call_args.args
    assert args[0] == "workspace"
    assert args[2] == {"allow_support_access": False}
    assert mocks.cancel.call_args.kwargs["task_type"] == "support_toggle_reminder"
    assert mocks.record_event.call_args.kwargs["event_code"] == "toggle_auto_disabled"


@pytest.mark.asyncio
async def test_other_active_session_prevents_auto_off():
    ws = {"id": _WS_ID, "allow_support_access": True}
    active = [{"id": "m-2", "expires_at": "2099-01-01T00:00:00+00:00"}]
    with _patched(ws, active_rows=active) as mocks:
        flipped = await sa.maybe_auto_disable_support_access(workspace_id=_WS_ID)
    assert flipped is False
    assert mocks.directus.update_item.await_count == 0


@pytest.mark.asyncio
async def test_toggle_already_off_is_a_no_op():
    ws = {"id": _WS_ID, "allow_support_access": False}
    with _patched(ws, active_rows=[]) as mocks:
        flipped = await sa.maybe_auto_disable_support_access(workspace_id=_WS_ID)
    assert flipped is False
    assert mocks.directus.update_item.await_count == 0
    assert mocks.record_event.await_count == 0


@pytest.mark.asyncio
async def test_elapsed_expiry_rows_do_not_count_as_active():
    ws = {"id": _WS_ID, "allow_support_access": True}
    stale = [{"id": "m-3", "expires_at": "2020-01-01T00:00:00+00:00"}]
    with _patched(ws, active_rows=stale) as mocks:
        flipped = await sa.maybe_auto_disable_support_access(workspace_id=_WS_ID)
    assert flipped is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `<PYTEST> tests/test_support_access_autooff.py`
Expected: FAIL with `AttributeError: ... has no attribute 'maybe_auto_disable_support_access'`.

- [ ] **Step 3: Implement the helper**

In `server/dembrane/support_access.py`, add below `cancel_pending_requests_for_toggle_on`:

```python
async def maybe_auto_disable_support_access(*, workspace_id: str) -> bool:
    """Close the door behind the last staff member: when no active
    staff_support membership remains and the toggle is on, turn it off,
    cancel reminder timers, and record toggle_auto_disabled (whose notice is
    the combined "session ended, access turned off" message). Returns True
    when the toggle was flipped.

    Check-then-set: a concurrent revoke can double-read, but the scheduler
    dispatches one runner at a time and a duplicate flip writes the same
    value, so the worst case is a duplicated notice, not wrong state.
    """
    from dembrane.inheritance import membership_access_expired
    from dembrane.scheduled_tasks import TASK_SUPPORT_TOGGLE_REMINDER, cancel_pending_tasks

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or not ws.get("allow_support_access"):
        return False
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "source": {"_eq": "staff_support"},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "expires_at"],
                "limit": -1,
            }
        },
    )
    rows = rows if isinstance(rows, list) else []
    active = [r for r in rows if not membership_access_expired(r.get("expires_at"))]
    if active:
        return False
    await async_directus.update_item(
        "workspace", workspace_id, {"allow_support_access": False}
    )
    await cancel_pending_tasks(
        task_type=TASK_SUPPORT_TOGGLE_REMINDER,
        payload_match={"workspace_id": workspace_id},
    )
    await record_support_access_event(
        workspace_id=workspace_id, event_code=EVENT_TOGGLE_AUTO_DISABLED
    )
    return True
```

- [ ] **Step 4: Wire the leave endpoint**

In `server/dembrane/api/v2/admin.py`, `leave_workspace_support`: after the revocation loop and before `await invalidate_workspace_and_org_usage(...)`, add. (The endpoint currently records no event; this adds the audit + auto-off.)

```python
    from dembrane.support_access import (
        EVENT_STAFF_LEFT,
        maybe_auto_disable_support_access,
        record_support_access_event,
        send_support_access_notice,
    )

    for row in rows:
        await record_support_access_event(
            workspace_id=workspace_id,
            event_code=EVENT_STAFF_LEFT,
            actor_user_id=app_user["id"],
            staff_user_id=app_user["id"],
            params={"membership_id": str(row["id"])},
            notify=False,
        )
    auto_disabled = await maybe_auto_disable_support_access(workspace_id=workspace_id)
    if not auto_disabled:
        await send_support_access_notice(
            workspace_id=workspace_id,
            event_code=EVENT_STAFF_LEFT,
            staff_user_id=app_user["id"],
        )
```

- [ ] **Step 5: Wire the auto-revoke path**

In `server/dembrane/tasks.py`, extend `_revoke_staff_support_async` so it records the audit event and calls auto-off inside the `source == "staff_support"` guard. Full function:

```python
async def _revoke_staff_support_async(
    workspace_id: str, membership_id: str, org_id: Optional[str]
) -> bool:
    """Soft-delete the staff support membership and bust usage caches.
    Returns True if a row was actually revoked (False = already gone)."""
    from dembrane.cache_utils import invalidate_workspace_and_org_usage
    from dembrane.directus_async import async_directus
    from dembrane.support_access import (
        EVENT_STAFF_AUTO_REVOKED,
        maybe_auto_disable_support_access,
        record_support_access_event,
        send_support_access_notice,
    )

    revoked = False
    membership = await async_directus.get_item("workspace_membership", membership_id)
    # Guard on source: a soft-deleted id can be reactivated as a genuine `direct`
    # member (same row id), so a stale revoke must never strip a real membership.
    if (
        membership
        and not membership.get("deleted_at")
        and membership.get("source") == "staff_support"
    ):
        await async_directus.update_item(
            "workspace_membership",
            membership_id,
            {"deleted_at": get_utc_timestamp().isoformat()},
        )
        revoked = True
        staff_user_id = membership.get("user_id")
        await record_support_access_event(
            workspace_id=workspace_id,
            event_code=EVENT_STAFF_AUTO_REVOKED,
            staff_user_id=staff_user_id,
            params={"membership_id": membership_id},
            notify=False,
        )
        auto_disabled = await maybe_auto_disable_support_access(
            workspace_id=workspace_id
        )
        if not auto_disabled:
            await send_support_access_notice(
                workspace_id=workspace_id,
                event_code=EVENT_STAFF_AUTO_REVOKED,
                staff_user_id=staff_user_id,
            )
    # Always invalidate — seat/usage counts must reflect the revocation even if a
    # manual leave already removed the row.
    await invalidate_workspace_and_org_usage(workspace_id, org_id)
    return revoked
```

(The 15-minute sweep `task_expire_staff_support_memberships` calls this same function, so all three revoke paths are covered.)

- [ ] **Step 6: Run the affected suites**

Run: `<PYTEST> tests/test_support_access_autooff.py tests/test_join_support.py tests/test_support_access_events.py`
Expected: all PASS. If `test_join_support.py` leave tests now fail on unpatched support_access imports, add `patch("dembrane.support_access.maybe_auto_disable_support_access", AsyncMock(return_value=True))` and `patch("dembrane.support_access.send_support_access_notice", AsyncMock())` to its `_patched` ExitStack (and `_patched_race` if the leave path runs there).

---

### Task 8: Reminder scheduled-task handler

**Files:**
- Modify: `server/dembrane/tasks.py` (`_dispatch_scheduled_task` additive branch + new handler)
- Test: `server/tests/test_support_access_reminder.py`

**Interfaces:**
- Consumes: `TASK_SUPPORT_TOGGLE_REMINDER`, `enqueue_task_sync`, `REMINDER_INTERVAL`, `EVENT_REMINDER_SENT`, `record_support_access_event`, `membership_access_expired`
- Produces: `_run_support_toggle_reminder(payload: dict) -> None` and `_support_toggle_reminder_async(workspace_id: str) -> datetime | None` in `tasks.py`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_support_access_reminder.py`:

```python
"""The weekly "support access is still on" reminder. Fires only when the
toggle is on AND no staff session is active; always re-arms itself while the
toggle stays on; goes quiet the moment the toggle is off."""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.tasks import _support_toggle_reminder_async

_WS_ID = "ws-1"


@contextmanager
def _patched(ws: dict | None, memberships: list[dict]):
    directus = AsyncMock()
    directus.get_item = AsyncMock(return_value=ws)
    directus.get_items = AsyncMock(return_value=memberships)
    record = AsyncMock(return_value="ev-1")
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.directus_async.async_directus", directus))
        stack.enter_context(
            patch("dembrane.support_access.record_support_access_event", record)
        )
        yield record


@pytest.mark.asyncio
async def test_toggle_off_stops_the_loop():
    ws = {"id": _WS_ID, "allow_support_access": False}
    with _patched(ws, []) as record:
        next_at = await _support_toggle_reminder_async(_WS_ID)
    assert next_at is None
    assert record.await_count == 0


@pytest.mark.asyncio
async def test_active_staff_session_reschedules_silently():
    ws = {"id": _WS_ID, "allow_support_access": True}
    active = [{"id": "m-1", "expires_at": "2099-01-01T00:00:00+00:00"}]
    with _patched(ws, active) as record:
        next_at = await _support_toggle_reminder_async(_WS_ID)
    assert next_at is not None
    assert record.await_count == 0


@pytest.mark.asyncio
async def test_on_and_unused_sends_reminder_and_reschedules():
    ws = {"id": _WS_ID, "allow_support_access": True}
    with _patched(ws, []) as record:
        next_at = await _support_toggle_reminder_async(_WS_ID)
    assert next_at is not None
    assert record.call_args.kwargs["event_code"] == "reminder_sent"


@pytest.mark.asyncio
async def test_deleted_workspace_stops_the_loop():
    with _patched(None, []) as record:
        next_at = await _support_toggle_reminder_async(_WS_ID)
    assert next_at is None
    assert record.await_count == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `<PYTEST> tests/test_support_access_reminder.py`
Expected: FAIL with `ImportError: cannot import name '_support_toggle_reminder_async'`.

- [ ] **Step 3: Implement handler + dispatch (ADDITIVE)**

In `server/dembrane/tasks.py`, add the reminder branch to `_dispatch_scheduled_task` (keep `TASK_CANVAS_TICK` and the `TASK_EXPIRE_SUPPORT_REQUEST` branch from Task 4). Final target state:

```python
def _dispatch_scheduled_task(row: dict) -> None:
    from dembrane.scheduled_tasks import (
        TASK_CANVAS_TICK,
        TASK_GENERATE_REPORT,
        TASK_REVOKE_STAFF_SUPPORT,
        TASK_EXPIRE_SUPPORT_REQUEST,
        TASK_SUPPORT_TOGGLE_REMINDER,
    )

    task_type = row.get("task_type")
    payload = row.get("payload") or {}
    if task_type == TASK_REVOKE_STAFF_SUPPORT:
        _run_revoke_staff_support(payload)
    elif task_type == TASK_GENERATE_REPORT:
        _run_generate_report(payload)
    elif task_type == TASK_CANVAS_TICK:
        _run_canvas_tick(payload)
    elif task_type == TASK_EXPIRE_SUPPORT_REQUEST:
        _run_expire_support_request(payload)
    elif task_type == TASK_SUPPORT_TOGGLE_REMINDER:
        _run_support_toggle_reminder(payload)
    else:
        raise ValueError(f"unknown scheduled_task type: {task_type!r}")
```

and add below `_run_expire_support_request`:

```python
async def _support_toggle_reminder_async(workspace_id: str) -> Optional[datetime]:
    """One reminder tick. Returns the next fire time (now + REMINDER_INTERVAL)
    while the toggle is on, or None to stop the loop. Sends the nudge only
    when no staff session is active: the toggle being both on and in use is
    working as intended."""
    from dembrane.inheritance import membership_access_expired
    from dembrane.directus_async import async_directus
    from dembrane.support_access import (
        REMINDER_INTERVAL,
        EVENT_REMINDER_SENT,
        record_support_access_event,
    )

    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or ws.get("deleted_at") or not ws.get("allow_support_access"):
        return None
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "source": {"_eq": "staff_support"},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "expires_at"],
                "limit": -1,
            }
        },
    )
    rows = rows if isinstance(rows, list) else []
    active = [r for r in rows if not membership_access_expired(r.get("expires_at"))]
    if not active:
        await record_support_access_event(
            workspace_id=workspace_id, event_code=EVENT_REMINDER_SENT
        )
    return datetime.now(timezone.utc) + REMINDER_INTERVAL


def _run_support_toggle_reminder(payload: dict) -> None:
    """Handler: weekly 'support access is still on' nudge; self-re-arming."""
    from dembrane.scheduled_tasks import TASK_SUPPORT_TOGGLE_REMINDER, enqueue_task_sync

    task_logger = getLogger("dembrane.tasks.support_toggle_reminder")
    workspace_id = payload.get("workspace_id")
    if not workspace_id:
        raise ValueError("support_toggle_reminder payload missing workspace_id")
    next_at = run_async_in_new_loop(_support_toggle_reminder_async(str(workspace_id)))
    if next_at is None:
        task_logger.info("reminder loop for workspace %s stopped", workspace_id)
        return
    with directus_client_context() as client:
        enqueue_task_sync(
            client,
            task_type=TASK_SUPPORT_TOGGLE_REMINDER,
            scheduled_at_iso=next_at.isoformat(),
            payload={"workspace_id": str(workspace_id)},
        )
    task_logger.info(
        "reminder for workspace %s re-armed for %s", workspace_id, next_at.isoformat()
    )
```

(`datetime`/`timezone` are already imported at the top of `tasks.py`, line 5. If the reminder test's patch of `dembrane.directus_async.async_directus` does not bite due to import binding, switch the async helper to `from dembrane import directus_async` + `directus_async.async_directus` and patch accordingly; keep the test green either way.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `<PYTEST> tests/test_support_access_reminder.py`
Expected: all 4 PASS.

---

### Task 9: Staff UI, request flow in `JoinSupportControl`

**Files:**
- Modify: `frontend/src/routes/admin/AdminSettingsRoute.tsx` (`JoinSupportControl`, currently ~904-1053)

**Interfaces:**
- Consumes: `GET/POST/DELETE /v2/admin/workspaces/{id}/support-access/request` (Task 4 shapes), Mantine `Modal` + `Textarea`, `useDisclosure`, `useState`
- Produces: staff-facing UI states: Join/Extend (toggle on), Request access (toggle off), Pending + Cancel (request pending), active session without Extend (toggle off)

> Design decision (do NOT substitute `InputModal`): the staff note is optional and "Send" must always be enabled. `InputModal` disables its confirm button when the field is empty and only fires `onConfirm` with a non-empty trimmed value, so it cannot express an optional note. Use an inline Mantine `Modal` + `Textarea` instead.

- [ ] **Step 1: Add the request query, mutations, and note state**

Inside `JoinSupportControl`, after the existing `statusKey` query, add the request query, the request/cancel mutations, the disclosure, and a note state. `queryClient` is already in scope.

```tsx
    const requestKey = ["v2", "admin", "support-request", row.workspace_id];
    const { data: reqStatus } = useQuery({
        queryKey: requestKey,
        queryFn: async () => {
            const res = await fetch(
                `${API_BASE_URL}/v2/admin/workspaces/${row.workspace_id}/support-access/request`,
                { credentials: "include" },
            );
            if (!res.ok) throw new Error(`Failed (${res.status})`);
            return res.json() as Promise<{
                support_access_enabled: boolean;
                request: {
                    id: string;
                    status: string;
                    created_at: string | null;
                } | null;
            }>;
        },
    });

    const [requestModalOpened, { open: openRequestModal, close: closeRequestModal }] =
        useDisclosure(false);
    const [requestNote, setRequestNote] = useState("");

    const requestMutation = useMutation({
        mutationFn: async (message: string) => {
            const res = await fetch(
                `${API_BASE_URL}/v2/admin/workspaces/${row.workspace_id}/support-access/request`,
                {
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                    body: JSON.stringify({ message }),
                },
            );
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `Failed (${res.status})`);
            }
            return res.json();
        },
        onError: (e) => toast.error((e as Error).message),
        onSuccess: () => {
            closeRequestModal();
            setRequestNote("");
            toast.success(t`Request sent. The workspace admins were notified.`);
            queryClient.invalidateQueries({ queryKey: requestKey });
        },
    });

    const cancelRequestMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch(
                `${API_BASE_URL}/v2/admin/workspaces/${row.workspace_id}/support-access/request`,
                { credentials: "include", method: "DELETE" },
            );
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `Failed (${res.status})`);
            }
            return res.json();
        },
        onError: (e) => toast.error((e as Error).message),
        onSuccess: () => {
            toast.success(t`Request withdrawn.`);
            queryClient.invalidateQueries({ queryKey: requestKey });
        },
    });
```

- [ ] **Step 2: Branch the action row on toggle state + add the inline modal**

Derive flags after the existing `active`/`busy` lines (extend `busy` with the two new mutations):

```tsx
    const supportEnabled = reqStatus?.support_access_enabled ?? true;
    const pendingRequest =
        reqStatus?.request?.status === "pending" ? reqStatus.request : null;
    const busy =
        joinMutation.isPending ||
        leaveMutation.isPending ||
        requestMutation.isPending ||
        cancelRequestMutation.isPending;
```

Replace the trailing `<Button>` inside the action `<Group>` (the current unconditional Join/Extend button) so join/extend only shows when the toggle is on, and add the request and pending affordances. Keep the `active` Open/Leave block unchanged:

```tsx
                {supportEnabled && (
                    <Button
                        size="xs"
                        loading={joinMutation.isPending}
                        disabled={busy || isLoading}
                        onClick={() => joinMutation.mutate()}
                    >
                        {active ? (
                            <Trans>Extend 24h</Trans>
                        ) : (
                            <Trans>Join for support (24h)</Trans>
                        )}
                    </Button>
                )}
                {!supportEnabled && !active && pendingRequest && (
                    <>
                        <Text size="xs">
                            <Trans>Request sent. Waiting for the workspace admins.</Trans>
                        </Text>
                        <Button
                            size="xs"
                            variant="subtle"
                            loading={cancelRequestMutation.isPending}
                            disabled={busy}
                            onClick={() => cancelRequestMutation.mutate()}
                        >
                            <Trans>Cancel request</Trans>
                        </Button>
                    </>
                )}
                {!supportEnabled && !active && !pendingRequest && (
                    <Button size="xs" disabled={busy} onClick={openRequestModal}>
                        <Trans>Request access</Trans>
                    </Button>
                )}
```

(When `!supportEnabled && active`, an approval-granted session: only `Open workspace` and `Leave now` render, no Extend. The door is closed; extending means asking again.)

Add `Textarea` to the `@mantine/core` import (`Modal`, `useDisclosure`, `useState`, `Stack`, `Text`, `Button`, `Group` are already imported). Add the inline modal before the closing `</Paper>`. "Send request" has no `disabled` prop, so an empty note sends fine:

```tsx
			<Modal
				opened={requestModalOpened}
				onClose={closeRequestModal}
				title={t`Request support access`}
				data-testid="support-access-request-modal"
			>
				<Stack gap="sm">
					<Text size="sm">
						<Trans>
							Tell the workspace admins what you need access for. This note is
							optional.
						</Trans>
					</Text>
					<Textarea
						value={requestNote}
						onChange={(e) => setRequestNote(e.currentTarget.value)}
						placeholder={t`e.g. investigating the report issue you emailed about`}
						autosize
						minRows={3}
						data-testid="support-access-request-note"
					/>
					<Group justify="flex-end" gap="sm">
						<Button variant="subtle" onClick={closeRequestModal}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							loading={requestMutation.isPending}
							onClick={() => requestMutation.mutate(requestNote)}
						>
							<Trans>Send request</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
```

- [ ] **Step 3: Verify**

Run: `cd frontend && pnpm exec tsc && pnpm lint`
Expected: no new errors (pre-existing warnings unchanged).

Attempt: `pnpm messages:extract`; if it fails with a root-owned-file permission error, note it for the user.

---

### Task 10: Client UI, pending requests + access history in workspace settings

**Files:**
- Create: `frontend/src/components/workspace/SupportAccessSection.tsx`
- Modify: `frontend/src/routes/workspaces/WorkspaceSettingsRoute.tsx` (mount below the support Switch in the `section === "access"` return; support Switch currently ~1916)

**Interfaces:**
- Consumes: `GET /v2/workspaces/{id}/support-access/events`, `GET /v2/workspaces/{id}/support-access/requests`, `POST .../approve`, `POST .../deny` (Task 5 shapes), `ConfirmModal`, `toast`
- Produces: `<SupportAccessSection workspaceId={string} canEdit={boolean} />`

- [ ] **Step 1: Create the component**

`frontend/src/components/workspace/SupportAccessSection.tsx`:

```tsx
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";

type PendingRequest = {
    id: string;
    requested_by_name: string;
    message: string | null;
    created_at: string | null;
    expires_at: string | null;
};

type SupportAccessEvent = {
    id: string;
    event_code: string;
    created_at: string | null;
    actor_name: string | null;
    staff_name: string | null;
    params: Record<string, unknown> | null;
};

const eventLabel = (e: SupportAccessEvent): string => {
    switch (e.event_code) {
        case "toggle_enabled":
            return t`Support access turned on`;
        case "toggle_disabled":
            return t`Support access turned off`;
        case "toggle_auto_disabled":
            return t`Support access turned off after the session ended`;
        case "request_created":
            return t`dembrane staff requested access`;
        case "request_approved":
            return t`Access request approved`;
        case "request_denied":
            return t`Access request denied`;
        case "request_expired":
            return t`Access request expired`;
        case "request_cancelled":
            return t`Access request withdrawn`;
        case "staff_joined":
            return t`dembrane staff joined for support`;
        case "staff_extended":
            return t`dembrane staff extended their session`;
        case "staff_left":
            return t`dembrane staff left`;
        case "staff_auto_revoked":
            return t`dembrane staff access ended automatically`;
        case "reminder_sent":
            return t`Reminder sent: support access still on`;
        default:
            return e.event_code;
    }
};

const formatWhen = (iso: string | null): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
};

export function SupportAccessSection({
    workspaceId,
    canEdit,
}: {
    workspaceId: string;
    canEdit: boolean;
}) {
    const queryClient = useQueryClient();
    const [limit, setLimit] = useState(5);

    const requestsKey = ["v2", "support-access", "requests", workspaceId];
    const eventsKey = ["v2", "support-access", "events", workspaceId, limit];

    const { data: requestsData } = useQuery({
        queryKey: requestsKey,
        enabled: canEdit,
        queryFn: async () => {
            const res = await fetch(
                `${API_BASE_URL}/v2/workspaces/${workspaceId}/support-access/requests`,
                { credentials: "include" },
            );
            if (!res.ok) throw new Error(`Failed (${res.status})`);
            return res.json() as Promise<{ requests: PendingRequest[] }>;
        },
    });

    const { data: eventsData } = useQuery({
        queryKey: eventsKey,
        enabled: canEdit,
        queryFn: async () => {
            const res = await fetch(
                `${API_BASE_URL}/v2/workspaces/${workspaceId}/support-access/events?page=1&limit=${limit}`,
                { credentials: "include" },
            );
            if (!res.ok) throw new Error(`Failed (${res.status})`);
            return res.json() as Promise<{
                events: SupportAccessEvent[];
                has_more: boolean;
            }>;
        },
    });

    const invalidateAll = () => {
        queryClient.invalidateQueries({ queryKey: ["v2", "support-access"] });
        queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
    };

    const resolveMutation = useMutation({
        mutationFn: async ({
            requestId,
            decision,
        }: {
            requestId: string;
            decision: "approve" | "deny";
        }) => {
            const res = await fetch(
                `${API_BASE_URL}/v2/workspaces/${workspaceId}/support-access/requests/${requestId}/${decision}`,
                { credentials: "include", method: "POST" },
            );
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `Failed (${res.status})`);
            }
            return res.json();
        },
        onError: (e) => {
            toast.error((e as Error).message);
            invalidateAll();
        },
        onSuccess: (_data, vars) => {
            toast.success(
                vars.decision === "approve"
                    ? t`Access granted for 24 hours.`
                    : t`Request denied.`,
            );
            invalidateAll();
        },
    });

    const [confirmTarget, setConfirmTarget] = useState<PendingRequest | null>(null);
    const [confirmOpened, { open: openConfirm, close: closeConfirm }] =
        useDisclosure(false);

    const pending = requestsData?.requests ?? [];
    const events = eventsData?.events ?? [];

    if (!canEdit) return null;

    return (
        <Stack gap="md">
            {pending.length > 0 && (
                <Paper withBorder radius="sm" p="sm">
                    <Stack gap="xs">
                        <Text size="sm" fw={500}>
                            <Trans>Pending access requests</Trans>
                        </Text>
                        {pending.map((req) => (
                            <Group key={req.id} justify="space-between" wrap="nowrap">
                                <Stack gap={0}>
                                    <Text size="sm">
                                        <Trans>{req.requested_by_name} from dembrane</Trans>
                                    </Text>
                                    {req.message && <Text size="xs">{req.message}</Text>}
                                    <Text size="xs">{formatWhen(req.created_at)}</Text>
                                </Stack>
                                <Group gap="sm" wrap="nowrap">
                                    <Button
                                        size="xs"
                                        variant="outline"
                                        color="red"
                                        disabled={resolveMutation.isPending}
                                        onClick={() =>
                                            resolveMutation.mutate({
                                                requestId: req.id,
                                                decision: "deny",
                                            })
                                        }
                                    >
                                        <Trans>Deny</Trans>
                                    </Button>
                                    <Button
                                        size="xs"
                                        disabled={resolveMutation.isPending}
                                        onClick={() => {
                                            setConfirmTarget(req);
                                            openConfirm();
                                        }}
                                    >
                                        <Trans>Approve</Trans>
                                    </Button>
                                </Group>
                            </Group>
                        ))}
                    </Stack>
                </Paper>
            )}

            {events.length > 0 && (
                <Stack gap="xs">
                    <Text size="sm" fw={500}>
                        <Trans>Access history</Trans>
                    </Text>
                    {events.map((e) => (
                        <Group key={e.id} justify="space-between" wrap="nowrap">
                            <Text size="xs">
                                {eventLabel(e)}
                                {e.staff_name ? ` (${e.staff_name})` : ""}
                            </Text>
                            <Text size="xs">{formatWhen(e.created_at)}</Text>
                        </Group>
                    ))}
                    {eventsData?.has_more && (
                        <Button
                            size="xs"
                            variant="subtle"
                            onClick={() => setLimit((n) => n + 10)}
                        >
                            <Trans>Show more</Trans>
                        </Button>
                    )}
                </Stack>
            )}

            {confirmTarget && (
                <ConfirmModal
                    opened={confirmOpened}
                    onClose={() => {
                        closeConfirm();
                        setConfirmTarget(null);
                    }}
                    onConfirm={() => {
                        resolveMutation.mutate({
                            requestId: confirmTarget.id,
                            decision: "approve",
                        });
                        closeConfirm();
                        setConfirmTarget(null);
                    }}
                    loading={resolveMutation.isPending}
                    title={t`Approve support access`}
                    data-testid="support-access-approve-modal"
                    confirmLabel={<Trans>Approve for 24 hours</Trans>}
                    message={
                        <Trans>
                            Give {confirmTarget.requested_by_name} from dembrane admin access
                            to this workspace for 24 hours? Access ends automatically.
                        </Trans>
                    }
                />
            )}
        </Stack>
    );
}
```

Before finishing, open `frontend/src/components/common/ConfirmModal.tsx` and confirm the prop names used above (`opened`, `onClose`, `onConfirm`, `loading`, `title`, `confirmLabel`, `message`, `data-testid`) against its actual `ConfirmModalProps` (verified present; `confirmColor` and `cancelLabel` also exist). The AdminSettingsRoute usage is the reference.

- [ ] **Step 2: Mount it in the access section**

In `frontend/src/routes/workspaces/WorkspaceSettingsRoute.tsx`, import it with the other workspace components:

```tsx
import { SupportAccessSection } from "@/components/workspace/SupportAccessSection";
```

In the `section === "access"` return of `PrivacyAndDefaultsSection`, directly after the support-access `<Switch>`, add (`workspaceId` and `canEdit` are in scope):

```tsx
                {workspaceId && (
                    <SupportAccessSection workspaceId={workspaceId} canEdit={canEdit} />
                )}
```

Also make the toggle mutation refresh the audit surfaces: in `supportAccessMutation.onSuccess`, add:

```tsx
                queryClient.invalidateQueries({ queryKey: ["v2", "support-access"] });
```

- [ ] **Step 3: Verify**

Run: `cd frontend && pnpm exec tsc && pnpm lint`
Expected: no new errors.

Attempt: `pnpm messages:extract` (same permission caveat as Task 9).

- [ ] **Step 4: Manual pass (if local stack is running)**

With the dev stack up: enable the toggle in workspace settings as a client admin, confirm the `toggle_enabled` row appears in Access history; as staff (admin console), join and confirm the client sees `staff_joined`; leave and confirm the toggle flips off with the combined ended notice in the Inbox; with the toggle off, file a request as staff and approve it as the client, confirming the 24h session and the `request_approved` history row. If the stack isn't running, state that this manual pass is pending.

---

### Task 11: Docs update + full verification sweep

**Files:**
- Modify: `docs/staff_support_access.md`
- Test: all suites

**Interfaces:**
- Consumes: everything above. No new code.

- [ ] **Step 1: Update the user guide**

Read `docs/staff_support_access.md` fully, then update it to describe: the hybrid request flow (toggle off → staff request → admin approve/deny, one-time 24h grant, toggle stays off), auto-off, the weekly reminder, the client notifications/emails per event, and the Access history in workspace settings. Keep the existing tone and structure. The "Turning it off" section (currently ~lines 40-45) states that turning the toggle off does not revoke existing sessions ("Anyone already inside finishes their current 24-hour window"): that stays true for a manual toggle-off, but now the toggle ALSO turns itself off automatically when the last staff session ends. Reconcile that section so the two behaviors do not read as contradictory.

- [ ] **Step 2: Run every backend suite this feature touches**

Run: `<PYTEST> tests/test_support_access_events.py tests/test_support_access_requests.py tests/test_support_access_client.py tests/test_support_access_toggle_hooks.py tests/test_support_access_autooff.py tests/test_support_access_reminder.py tests/test_join_support.py tests/test_staff_support_accounting.py`
Expected: all PASS.

- [ ] **Step 3: Confirm no wider regressions**

Run: `<PYTEST> tests/` (full suite)
Expected: matches the host baseline (environment-dependent failures needing live Directus/LLM infra are expected). No NEW failures relative to a pre-change run of the same command; if unsure, compare against a `git worktree` baseline on `main`.

- [ ] **Step 4: Frontend final check**

Run: `cd frontend && pnpm exec tsc && pnpm lint`
Expected: clean.

- [ ] **Step 5: Hand off to the user**

Summarize: what changed, the migration script that must run against staging/production Directus before deploy (`server/scripts/add_support_access_audit_and_requests.py`), the snapshot diff to review, the Lingui extraction still to run if it failed locally, and that all changes are uncommitted for the user's own commit flow.

---

## Plan self-review notes

- Spec coverage: reminder (Tasks 6+8), audit log exposure (Tasks 1, 2, 5, 10), revoke notification + door close (Tasks 2, 7), request flow + notifications (Tasks 2, 4, 5, 9, 10). Recipients, severities, and copy match the spec's notification table, including the merged end-of-session notice and in-app-only extends.
- Type consistency: `grant_support_membership` tuple `(status, membership_id, expires_iso)` is produced in Task 3 and consumed in Task 5; `StaffSupportRequestStatus.support_access_enabled` produced in Task 4, consumed in Task 9; event-code strings match between module constants, tests, and the frontend `eventLabel` switch.
- Corrections applied vs the original draft: (1) `_dispatch_scheduled_task` edits are additive and keep `TASK_CANVAS_TICK`; (2) the toggle side-effect block is wrapped in try/except; (3) the staff request UI uses an inline `Modal` + `Textarea` (optional note), not `InputModal`; (4) join-support test patches land in both `_patched` and `_patched_race`; (5) all line numbers are treated as approximate anchors.
- Known judgment calls implementers should not "fix" silently: approval does not write a `staff_joined` event (the `request_approved` event carries `membership_id`/`expires_at`); toggle flips by the customer notify nobody; a staff self-cancel is silent; approval-granted sessions cannot be extended; auto-off is routed through `_revoke_staff_support_async` on purpose (do not wire it separately into the sweep).
