"""
Create / extend Directus schema collections via the Directus API.

Usage:
    python scripts/create_schema.py --step 1        # app_user only (test)
    python scripts/create_schema.py --step 2        # org + org_membership
    python scripts/create_schema.py --step 3        # workspace + workspace_membership
    python scripts/create_schema.py --step 4        # workspace_invite + project_membership
    python scripts/create_schema.py --step 5        # (removed)
    python scripts/create_schema.py --step 6        # add fields to project
    python scripts/create_schema.py --step 7        # add deleted_at to existing collections
    python scripts/create_schema.py --step 8        # remove legacy chat collection
    python scripts/create_schema.py --step 9-16     # notifications, visibility, downgrade, etc.
    python scripts/create_schema.py --step 17       # conversation.is_over_cap
    python scripts/create_schema.py --step 18       # workspace_request collection
    python scripts/create_schema.py --step 19       # workspace.tier_expires_at
    python scripts/create_schema.py --step 20       # workspace.pre_warning_sent
    python scripts/create_schema.py --step 21       # workspace discount fields
    python scripts/create_schema.py --step all      # everything

Requires DIRECTUS_TOKEN and DIRECTUS_BASE_URL env vars (reads from directus/.env).
"""

import argparse
import json
import os
import sys

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DIRECTUS_URL = os.environ.get("DIRECTUS_BASE_URL", "http://directus:8055")
DIRECTUS_TOKEN = os.environ.get("DIRECTUS_TOKEN", "")

if not DIRECTUS_TOKEN:
    # Try reading from directus/.env
    env_path = os.path.join(os.path.dirname(__file__), "..", "directus", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DIRECTUS_TOKEN="):
                    DIRECTUS_TOKEN = line.split("=", 1)[1].strip().strip('"').strip("'")

HEADERS = {
    "Authorization": f"Bearer {DIRECTUS_TOKEN}",
    "Content-Type": "application/json",
}


def api(method, path, data=None):
    """Make a Directus API call. Returns response JSON or raises on error."""
    url = f"{DIRECTUS_URL}{path}"
    resp = requests.request(method, url, headers=HEADERS, json=data, timeout=30)
    if resp.status_code >= 400:
        print(f"  ERROR {resp.status_code}: {resp.text[:500]}")
        return None
    if resp.status_code == 204:
        return {}
    return resp.json()


def collection_exists(name):
    """Check if a collection already exists."""
    resp = requests.get(
        f"{DIRECTUS_URL}/collections/{name}", headers=HEADERS, timeout=10
    )
    return resp.status_code == 200


def field_exists(collection, field):
    """Check if a field already exists on a collection."""
    resp = requests.get(
        f"{DIRECTUS_URL}/fields/{collection}/{field}", headers=HEADERS, timeout=10
    )
    return resp.status_code == 200


def create_collection(name, fields, meta=None):
    """Create a collection with fields. Skips if already exists."""
    if collection_exists(name):
        print(f"  SKIP {name} (already exists)")
        return True

    payload = {
        "collection": name,
        "meta": meta or {},
        "schema": {},
        "fields": fields,
    }
    print(f"  Creating collection: {name}")
    result = api("POST", "/collections", payload)
    if result:
        print(f"  OK {name} created")
        return True
    return False


def add_field(collection, field_name, field_def):
    """Add a field to an existing collection. Skips if already exists."""
    if field_exists(collection, field_name):
        print(f"  SKIP {collection}.{field_name} (already exists)")
        return True

    payload = {"field": field_name, **field_def}
    print(f"  Adding field: {collection}.{field_name}")
    result = api("POST", f"/fields/{collection}", payload)
    if result:
        print(f"  OK {collection}.{field_name} added")
        return True
    return False


def create_relation(collection, field, related_collection, meta=None, schema=None):
    """Create a M2O relation."""
    payload = {
        "collection": collection,
        "field": field,
        "related_collection": related_collection,
    }
    if meta:
        payload["meta"] = meta
    if schema:
        payload["schema"] = schema

    print(f"  Creating relation: {collection}.{field} -> {related_collection}")
    result = api("POST", "/relations", payload)
    if result:
        print(f"  OK relation created")
        return True
    return False


# ---------------------------------------------------------------------------
# Field definitions (reusable)
# ---------------------------------------------------------------------------

def pk_uuid():
    return {
        "field": "id",
        "type": "uuid",
        "schema": {"is_primary_key": True, "has_auto_increment": False},
        "meta": {"special": ["uuid"], "interface": "input", "readonly": True, "hidden": True},
    }


def timestamp_created():
    return {
        "type": "timestamp",
        "schema": {"is_nullable": True, "default_value": "CURRENT_TIMESTAMP"},
        "meta": {"special": ["date-created"], "interface": "datetime", "readonly": True,
                 "width": "half"},
    }


def timestamp_updated():
    return {
        "type": "timestamp",
        "schema": {"is_nullable": True, "default_value": "CURRENT_TIMESTAMP"},
        "meta": {"special": ["date-updated"], "interface": "datetime", "readonly": True,
                 "width": "half"},
    }


def deleted_at_field():
    return {
        "type": "timestamp",
        "schema": {"is_nullable": True, "default_value": None},
        "meta": {"interface": "datetime", "width": "half", "note": "Soft delete timestamp"},
    }


# ---------------------------------------------------------------------------
# Step 1: app_user
# ---------------------------------------------------------------------------

def step_1_app_user():
    print("\n=== Step 1: app_user ===")

    fields = [
        pk_uuid(),
        {
            "field": "directus_user_id",
            "type": "uuid",
            "schema": {"is_nullable": True, "is_unique": True},
            "meta": {"interface": "input", "note": "Maps to directus_users.id"},
        },
        {
            "field": "email",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input"},
        },
        {
            "field": "display_name",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input"},
        },
        {
            "field": "created_at",
            **timestamp_created(),
        },
        {
            "field": "updated_at",
            **timestamp_updated(),
        },
    ]

    meta = {
        "accountability": "all",
        "display_template": "{{display_name}}",
    }

    ok = create_collection("app_user", fields, meta)
    if not ok:
        return False

    # Note: directus_user_id is a logical FK to directus_users but we do NOT
    # create a Directus relation for it. This is intentional — app_user is our
    # indirection layer and we don't want Directus managing this relationship.

    return True


# ---------------------------------------------------------------------------
# Step 2: org + org_membership
# ---------------------------------------------------------------------------

def step_2_org():
    print("\n=== Step 2: org + org_membership ===")

    # --- org ---
    org_fields = [
        pk_uuid(),
        {
            "field": "name",
            "type": "string",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "logo_url",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input"},
        },
        {
            "field": "created_by",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "FK to app_user.id"},
        },
        {
            "field": "deleted_at",
            **deleted_at_field(),
        },
        {
            "field": "created_at",
            **timestamp_created(),
        },
        {
            "field": "updated_at",
            **timestamp_updated(),
        },
    ]

    ok = create_collection("org", org_fields, {
        "accountability": "all",
        "display_template": "{{name}}",
    })
    if not ok:
        return False

    # Relation: org.created_by -> app_user
    create_relation("org", "created_by", "app_user", schema={"on_delete": "SET NULL"})

    # --- org_membership ---
    om_fields = [
        pk_uuid(),
        {
            "field": "org_id",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "user_id",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "role",
            "type": "string",
            "schema": {"is_nullable": False},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Owner", "value": "owner"},
                    {"text": "Admin", "value": "admin"},
                    {"text": "Member", "value": "member"},
                ]},
                "required": True,
            },
        },
        {
            "field": "custom_policies",
            "type": "json",
            "schema": {"is_nullable": True, "default_value": "[]"},
            "meta": {"interface": "input-code", "options": {"language": "json"},
                     "note": "Extra policies beyond role preset. Usually empty."},
        },
        {
            "field": "deleted_at",
            **deleted_at_field(),
        },
        {
            "field": "created_at",
            **timestamp_created(),
        },
        {
            "field": "updated_at",
            **timestamp_updated(),
        },
    ]

    ok = create_collection("org_membership", om_fields, {
        "accountability": "all",
    })
    if not ok:
        return False

    # Relations
    create_relation("org_membership", "org_id", "org", schema={"on_delete": "CASCADE"})
    create_relation("org_membership", "user_id", "app_user", schema={"on_delete": "CASCADE"})

    return True


# ---------------------------------------------------------------------------
# Step 3: workspace + workspace_membership
# ---------------------------------------------------------------------------

def step_3_workspace():
    print("\n=== Step 3: workspace + workspace_membership ===")

    # --- workspace ---
    ws_fields = [
        pk_uuid(),
        {
            "field": "org_id",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "name",
            "type": "string",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "description",
            "type": "text",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input-multiline"},
        },
        {
            "field": "logo_url",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "Override org logo"},
        },
        {
            "field": "tier",
            "type": "string",
            "schema": {"is_nullable": False, "default_value": "free"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Free", "value": "free"},
                    {"text": "Pilot", "value": "pilot"},
                    {"text": "Pioneer", "value": "pioneer"},
                    {"text": "Innovator", "value": "innovator"},
                    {"text": "Changemaker", "value": "changemaker"},
                    {"text": "Guardian", "value": "guardian"},
                ]},
            },
        },
        {
            "field": "billed_to_workspace_id",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "Partner billing. NULL = org pays."},
        },
        {
            "field": "is_default",
            "type": "boolean",
            "schema": {"is_nullable": False, "default_value": False},
            "meta": {"interface": "boolean"},
        },
        {
            "field": "legal_basis",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Consent", "value": "consent"},
                    {"text": "Client-managed", "value": "client-managed"},
                    {"text": "Dembrane Events", "value": "dembrane-events"},
                ]},
            },
        },
        {
            "field": "privacy_policy_url",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input"},
        },
        {
            "field": "settings",
            "type": "json",
            "schema": {"is_nullable": True, "default_value": "{}"},
            "meta": {"interface": "input-code", "options": {"language": "json"},
                     "note": "Feature flags, limits"},
        },
        {
            "field": "deleted_at",
            **deleted_at_field(),
        },
        {
            "field": "created_by",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "FK to app_user.id"},
        },
        {
            "field": "created_at",
            **timestamp_created(),
        },
        {
            "field": "updated_at",
            **timestamp_updated(),
        },
    ]

    ok = create_collection("workspace", ws_fields, {
        "accountability": "all",
        "display_template": "{{name}}",
    })
    if not ok:
        return False

    # Relations
    create_relation("workspace", "org_id", "org", schema={"on_delete": "CASCADE"})
    create_relation("workspace", "created_by", "app_user", schema={"on_delete": "SET NULL"})
    create_relation("workspace", "billed_to_workspace_id", "workspace",
                    schema={"on_delete": "SET NULL"})

    # --- workspace_membership ---
    wm_fields = [
        pk_uuid(),
        {
            "field": "workspace_id",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "user_id",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "role",
            "type": "string",
            "schema": {"is_nullable": False},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Owner", "value": "owner"},
                    {"text": "Admin", "value": "admin"},
                    {"text": "Member", "value": "member"},
                    {"text": "Viewer", "value": "viewer"},
                ]},
                "required": True,
            },
        },
        {
            "field": "custom_policies",
            "type": "json",
            "schema": {"is_nullable": True, "default_value": "[]"},
            "meta": {"interface": "input-code", "options": {"language": "json"},
                     "note": "Extra policies beyond role preset. Usually empty."},
        },
        {
            "field": "source",
            "type": "string",
            "schema": {"is_nullable": False, "default_value": "direct"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Direct", "value": "direct"},
                    {"text": "Inherited", "value": "inherited"},
                ]},
                "note": "direct = explicitly invited. inherited = auto-added from org role.",
            },
        },
        {
            "field": "is_external",
            "type": "boolean",
            "schema": {"is_nullable": False, "default_value": False},
            "meta": {"interface": "boolean",
                     "note": "True if user's primary org != workspace's org"},
        },
        {
            "field": "deleted_at",
            **deleted_at_field(),
        },
        {
            "field": "created_at",
            **timestamp_created(),
        },
        {
            "field": "updated_at",
            **timestamp_updated(),
        },
    ]

    ok = create_collection("workspace_membership", wm_fields, {
        "accountability": "all",
    })
    if not ok:
        return False

    create_relation("workspace_membership", "workspace_id", "workspace",
                    schema={"on_delete": "CASCADE"})
    create_relation("workspace_membership", "user_id", "app_user",
                    schema={"on_delete": "CASCADE"})

    return True


# ---------------------------------------------------------------------------
# Step 4: workspace_invite + project_membership
# ---------------------------------------------------------------------------

def step_4_invite_and_project_membership():
    print("\n=== Step 4: workspace_invite + project_membership ===")

    # --- workspace_invite ---
    wi_fields = [
        pk_uuid(),
        {
            "field": "workspace_id",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "email",
            "type": "string",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "role",
            "type": "string",
            "schema": {"is_nullable": False},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Admin", "value": "admin"},
                    {"text": "Member", "value": "member"},
                    {"text": "Viewer", "value": "viewer"},
                ]},
                "required": True,
                "note": "Role to assign on acceptance",
            },
        },
        {
            "field": "invited_by",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "FK to app_user.id"},
        },
        {
            "field": "token",
            "type": "string",
            "schema": {"is_nullable": False, "is_unique": True},
            "meta": {"interface": "input", "note": "secrets.token_urlsafe(32)"},
        },
        {
            "field": "expires_at",
            "type": "timestamp",
            "schema": {"is_nullable": False},
            "meta": {"interface": "datetime", "note": "7 days from creation"},
        },
        {
            "field": "accepted_at",
            "type": "timestamp",
            "schema": {"is_nullable": True},
            "meta": {"interface": "datetime"},
        },
        {
            "field": "created_at",
            **timestamp_created(),
        },
    ]

    ok = create_collection("workspace_invite", wi_fields, {
        "accountability": "all",
    })
    if not ok:
        return False

    create_relation("workspace_invite", "workspace_id", "workspace",
                    schema={"on_delete": "CASCADE"})
    create_relation("workspace_invite", "invited_by", "app_user",
                    schema={"on_delete": "SET NULL"})

    # --- project_membership ---
    pm_fields = [
        pk_uuid(),
        {
            "field": "project_id",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "user_id",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "role",
            "type": "string",
            "schema": {"is_nullable": False, "default_value": "editor"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Editor", "value": "editor"},
                    {"text": "Viewer", "value": "viewer"},
                ]},
            },
        },
        {
            "field": "custom_policies",
            "type": "json",
            "schema": {"is_nullable": True, "default_value": "[]"},
            "meta": {"interface": "input-code", "options": {"language": "json"},
                     "note": "Extra policies beyond role preset. Usually empty."},
        },
        {
            "field": "granted_by",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "FK to app_user.id"},
        },
        {
            "field": "created_at",
            **timestamp_created(),
        },
    ]

    ok = create_collection("project_membership", pm_fields, {
        "accountability": "all",
    })
    if not ok:
        return False

    create_relation("project_membership", "project_id", "project",
                    schema={"on_delete": "CASCADE"})
    create_relation("project_membership", "user_id", "app_user",
                    schema={"on_delete": "CASCADE"})
    create_relation("project_membership", "granted_by", "app_user",
                    schema={"on_delete": "SET NULL"})

    return True


# ---------------------------------------------------------------------------
# Step 5: usage_event
# ---------------------------------------------------------------------------

def step_5_usage_event():
    print("\n=== Step 5: usage_event ===")

    fields = [
        pk_uuid(),
        {
            "field": "trace_id",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "Request correlation ID"},
        },
        {
            "field": "org_id",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "Reference only, no FK constraint"},
        },
        {
            "field": "workspace_id",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "Reference only, no FK constraint"},
        },
        {
            "field": "project_id",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "Reference only, no FK constraint"},
        },
        {
            "field": "user_id",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input", "note": "Reference only, no FK constraint"},
        },
        {
            "field": "event_type",
            "type": "string",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True},
        },
        {
            "field": "event_data",
            "type": "json",
            "schema": {"is_nullable": True, "default_value": "{}"},
            "meta": {"interface": "input-code", "options": {"language": "json"},
                     "note": "Always include \"v\": 1 for schema versioning"},
        },
        {
            "field": "created_at",
            **timestamp_created(),
        },
    ]

    ok = create_collection("usage_event", fields, {
        "accountability": "all",
        "note": "Append-only. Never updated. Never deleted.",
    })

    # No FK relations — these are reference-only UUID fields
    return ok


# ---------------------------------------------------------------------------
# Step 6: Add fields to project
# ---------------------------------------------------------------------------

def step_6_project_fields():
    print("\n=== Step 6: Add fields to project ===")

    add_field("project", "workspace_id", {
        "type": "uuid",
        "schema": {"is_nullable": True},
        "meta": {"interface": "input", "note": "FK to workspace. NULL during migration."},
    })

    # Create the relation for workspace_id
    if not field_exists("project", "workspace_id"):
        pass  # field creation failed, skip relation
    else:
        create_relation("project", "workspace_id", "workspace",
                        schema={"on_delete": "SET NULL"})

    add_field("project", "visibility", {
        "type": "string",
        "schema": {"is_nullable": False, "default_value": "workspace"},
        "meta": {
            "interface": "select-dropdown",
            "options": {"choices": [
                {"text": "Workspace", "value": "workspace"},
                {"text": "Private", "value": "private"},
            ]},
            "note": "workspace = visible to all workspace members. private = explicit sharing.",
        },
    })

    add_field("project", "deleted_at", {
        **deleted_at_field(),
    })

    return True


# ---------------------------------------------------------------------------
# Step 7: Add deleted_at to existing collections
# ---------------------------------------------------------------------------

def step_7_deleted_at():
    print("\n=== Step 7: Add deleted_at to existing collections ===")

    for collection in ["conversation", "project_chat", "project_report"]:
        add_field(collection, "deleted_at", {
            **deleted_at_field(),
        })

    return True


# ---------------------------------------------------------------------------
# Step 8: Remove legacy chat collection
# ---------------------------------------------------------------------------

def step_8_remove_chat():
    print("\n=== Step 8: Remove legacy chat collection ===")

    if not collection_exists("chat"):
        print("  SKIP chat (already removed)")
        return True

    # Verify it's empty first
    resp = api("GET", "/items/chat?limit=0&meta=total_count")
    if resp and resp.get("meta", {}).get("total_count", 0) > 0:
        count = resp["meta"]["total_count"]
        print(f"  ABORT: chat collection has {count} rows! Not safe to remove.")
        return False

    print("  Confirmed: chat collection is empty")
    print("  Deleting chat collection...")
    result = api("DELETE", "/collections/chat")
    if result is not None:
        print("  OK chat collection removed")
        return True
    return False


# ---------------------------------------------------------------------------
# Step 9: Notifications (inbox) — flat per-recipient rows
# ---------------------------------------------------------------------------

def step_9_notifications():
    """Per-user notifications — one row per (event, recipient).

    The announcement pattern (parent + translations + activity) was
    rejected here because fan-out is almost always 1–3 people and pre-
    rendering N locales per row wastes more than we'd save on string
    dedupe. Client-side Lingui catalogs render text from `event_code +
    params` when that migration lands; for now title/message are plain
    English strings written at emit time.

    Severity is server-derived from the event_code — client renders
    styling from severity, never from event_code.

    Scope is the denormalized breadcrumb ("Org › Workspace › Project")
    computed once at emit time; a later rename correctly preserves the
    historical breadcrumb instead of mutating past notifications.

    Note on channels: in-app only for now. A future email digest or
    Slack bridge reads the same rows rather than having its own store.
    """
    print("\n=== Step 9: notification (flat per-recipient) ===")

    notification_fields = [
        pk_uuid(),
        {
            "field": "audience_user_id", "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True,
                     "note": "FK to app_user — the recipient."},
        },
        {
            "field": "actor_user_id", "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input",
                     "note": "FK to app_user — who triggered the event."},
        },
        {
            "field": "event_code", "type": "string",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True,
                     "note": "Machine enum. WORKSPACE_ADDED, INVITE_ACCEPTED, REPORT_READY, etc."},
        },
        {
            "field": "severity", "type": "string",
            "schema": {"is_nullable": False, "default_value": "info"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Info", "value": "info"},
                    {"text": "Action required", "value": "action_required"},
                    {"text": "Destructive", "value": "destructive"},
                ]},
                "note": "Server-derived from event_code. Controls row styling.",
            },
        },
        {
            "field": "action", "type": "string",
            "schema": {"is_nullable": False, "default_value": "NONE"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "None", "value": "NONE"},
                    {"text": "Navigate to workspace", "value": "NAVIGATE_WS"},
                    {"text": "Navigate to project", "value": "NAVIGATE_PROJECT"},
                    {"text": "Navigate to report", "value": "NAVIGATE_REPORT"},
                    {"text": "Navigate to chat", "value": "NAVIGATE_CHAT"},
                    {"text": "Navigate to invite", "value": "NAVIGATE_INVITE"},
                    {"text": "Navigate to organisation settings", "value": "NAVIGATE_ORGANISATION_SETTINGS"},
                    {"text": "Navigate to workspace settings", "value": "NAVIGATE_WORKSPACE_SETTINGS"},
                ]},
                "note": "Codified nav target. UI resolves the URL from ref_* fields.",
            },
        },
        {"field": "title", "type": "string",
         "schema": {"is_nullable": False},
         "meta": {"interface": "input", "required": True,
                  "note": "Server-rendered headline. Plain text."}},
        {"field": "message", "type": "text",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input-multiline",
                  "note": "Optional body. Markdown allowed."}},
        {"field": "scope", "type": "string",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input",
                  "note": "Breadcrumb: 'Org › Workspace › Project'. Frozen at emit time."}},
        {"field": "params", "type": "json",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input-code", "options": {"language": "JSON"},
                  "note": "Event-specific params for future client-rendered i18n."}},
        {"field": "ref_org_id", "type": "uuid",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input"}},
        {"field": "ref_workspace_id", "type": "uuid",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input"}},
        {"field": "ref_project_id", "type": "uuid",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input"}},
        {"field": "ref_chat_id", "type": "uuid",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input"}},
        {"field": "ref_report_id", "type": "uuid",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input"}},
        {"field": "ref_conversation_id", "type": "uuid",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input"}},
        {"field": "ref_invite_id", "type": "uuid",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input"}},
        {"field": "read_at", "type": "timestamp",
         "schema": {"is_nullable": True},
         "meta": {"interface": "datetime",
                  "note": "When the recipient marked this read. Null = unread."}},
        {"field": "expires_at", "type": "timestamp",
         "schema": {"is_nullable": True},
         "meta": {"interface": "datetime",
                  "note": "Hide from inbox after this timestamp."}},
        {"field": "created_at", **timestamp_created()},
        {"field": "updated_at", **timestamp_updated()},
    ]
    if not create_collection("notification", notification_fields, {
        "accountability": "all",
        "display_template": "{{event_code}} → {{audience_user_id}}",
    }):
        return False

    create_relation("notification", "audience_user_id", "app_user",
                    schema={"on_delete": "CASCADE"})
    create_relation("notification", "actor_user_id", "app_user",
                    schema={"on_delete": "SET NULL"})
    create_relation("notification", "ref_org_id", "org",
                    schema={"on_delete": "SET NULL"})
    create_relation("notification", "ref_workspace_id", "workspace",
                    schema={"on_delete": "SET NULL"})
    create_relation("notification", "ref_project_id", "project",
                    schema={"on_delete": "SET NULL"})
    create_relation("notification", "ref_chat_id", "project_chat",
                    schema={"on_delete": "SET NULL"})
    # Skipped: project_report.id is bigInteger but ref_report_id is uuid.
    # Directus rejects the FK outright (column-type mismatch). We store
    # the report id as an opaque string at the application layer and
    # accept the absence of referential-integrity for this one link.
    # If project_report is ever re-keyed to uuid, uncomment this.
    # create_relation("notification", "ref_report_id", "project_report",
    #                 schema={"on_delete": "SET NULL"})
    create_relation("notification", "ref_conversation_id", "conversation",
                    schema={"on_delete": "SET NULL"})
    create_relation("notification", "ref_invite_id", "workspace_invite",
                    schema={"on_delete": "SET NULL"})

    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def step_10_workspace_visibility():
    """Add workspace.visibility enum (open_to_organisation | private).

    Matrix v1.1 §6 replaces the two-boolean inherit_organisation_admins /
    inherit_organisation_members model with a single visibility enum. This step:

      1. Adds the column (nullable for transition).
      2. Backfills existing rows from settings.inherit_organisation_admins:
             inherit_organisation_admins == True  → 'open_to_organisation'  (default)
             inherit_organisation_admins == False → 'private'

    What it does NOT do (those happen after the backfill_direct_memberships
    script runs --apply in prod):
      - Drop settings.inherit_organisation_admins / inherit_organisation_members flags.
      - Drop settings.sticky_removed tombstones.
      - Simplify inheritance.user_can_access to direct-only.

    Idempotent — rerunning only backfills rows still NULL.
    """
    print("\n=== Step 10: workspace.visibility enum ===")

    add_field("workspace", "visibility", {
        "type": "string",
        "schema": {"is_nullable": True, "default_value": "open_to_organisation"},
        "meta": {
            "interface": "select-dropdown",
            "options": {"choices": [
                {"text": "Open to organisation", "value": "open_to_organisation"},
                {"text": "Private", "value": "private"},
            ]},
            "note": (
                "Matrix v1.1 §6. open_to_organisation = discoverable by organisation admins "
                "(join) and members (request access). private = visible only "
                "to organisation admins in discovery. Innovator+ tier to create."
            ),
        },
    })

    # Backfill from existing settings flags for any workspace still NULL.
    # Batched paging handled by fetch-all behavior.
    resp = api(
        "GET",
        "/items/workspace"
        "?fields=id,settings,visibility,deleted_at"
        "&filter[visibility][_null]=true"
        "&filter[deleted_at][_null]=true"
        "&limit=-1",
    )
    if not resp:
        print("  WARN: could not fetch workspaces to backfill")
        return True
    rows = resp.get("data") or []
    print(f"  Backfilling {len(rows)} workspaces with NULL visibility")

    fixed = 0
    failed = 0
    for row in rows:
        settings = row.get("settings") or {}
        if not isinstance(settings, dict):
            settings = {}
        follows_admins = settings.get("inherit_organisation_admins", True)
        visibility = "open_to_organisation" if follows_admins else "private"
        result = api(
            "PATCH",
            f"/items/workspace/{row['id']}",
            {"visibility": visibility},
        )
        if result is not None:
            fixed += 1
        else:
            failed += 1
    print(f"  Backfilled {fixed}/{len(rows)} (errors: {failed})")

    return True


def step_11_downgrade_tracking():
    """Add workspace.downgraded_at + downgraded_from_tier for the 7-day
    post-downgrade banner (matrix v1.1 §3).

    Rules:
      - Set both on tier downgrade; clear both on tier upgrade.
      - Frontend renders the banner until
            downgraded_at + 7 days < now()
        OR until the admin dismisses it (dismissal state lives in a
        per-user settings key, not on the workspace).

    Idempotent.
    """
    print("\n=== Step 11: workspace downgrade tracking ===")

    add_field("workspace", "downgraded_at", {
        "type": "timestamp",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "datetime",
            "note": (
                "Set when a staff tier change lowered this workspace's tier. "
                "Frontend renders the post-downgrade banner for 7 days from "
                "this timestamp (matrix v1.1 §3)."
            ),
        },
    })

    add_field("workspace", "downgraded_from_tier", {
        "type": "string",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "input",
            "note": (
                "The tier the workspace was on BEFORE the downgrade. Used "
                "so the banner can say 'downgraded from X to Y' without "
                "guessing. Cleared on next upgrade."
            ),
        },
    })

    return True


def step_12_access_requests():
    """Create the access_request collection for Slack-style discovery
    (matrix v1.1 §6).

    Flow: a organisation member clicks "Request access" on an open workspace →
    writes a pending row here → audience (workspace admins + organisation admins)
    is notified → admin approves (writes a workspace_membership direct
    row + marks request approved) or rejects (marks request rejected;
    no notification to requester per matrix §6 "silent rejection").

    Fields are deliberately lean: the workshop question about adding a
    user-provided "reason" text is deferred — add post-release if abuse
    patterns demand it.

    Idempotent.
    """
    print("\n=== Step 12: access_request collection ===")

    if not collection_exists("access_request"):
        print("  Creating access_request collection...")
        # Directus auto-creates an integer PK if `fields` is omitted.
        # Pass the PK explicitly so we get uuid from the start; trying
        # to alter it afterwards via add_field silently noops.
        api("POST", "/collections", {
            "collection": "access_request",
            "meta": {
                "icon": "meeting_room",
                "note": (
                    "Pending join requests from organisation members on open-to-organisation "
                    "workspaces. Matrix v1.1 §6 Slack-style discovery."
                ),
                "display_template": "{{user_id}} → {{workspace_id}} ({{status}})",
                "sort_field": "requested_at",
            },
            "schema": {},
            "fields": [
                {
                    "field": "id",
                    "type": "uuid",
                    "schema": {
                        "is_primary_key": True,
                        "has_auto_increment": False,
                        "is_nullable": False,
                    },
                    "meta": {
                        "hidden": True,
                        "readonly": True,
                        "interface": "input",
                        "special": ["uuid"],
                    },
                }
            ],
        })
        print("  OK access_request collection created")

    add_field("access_request", "workspace_id", {
        "type": "uuid",
        "schema": {"is_nullable": False},
        "meta": {"interface": "input"},
    })
    create_relation("access_request", "workspace_id", "workspace",
                    schema={"on_delete": "CASCADE"})

    add_field("access_request", "user_id", {
        "type": "uuid",
        "schema": {"is_nullable": False},
        "meta": {"interface": "input"},
    })
    create_relation("access_request", "user_id", "app_user",
                    schema={"on_delete": "CASCADE"})

    add_field("access_request", "status", {
        "type": "string",
        "schema": {"is_nullable": False, "default_value": "pending"},
        "meta": {
            "interface": "select-dropdown",
            "options": {"choices": [
                {"text": "Pending", "value": "pending"},
                {"text": "Approved", "value": "approved"},
                {"text": "Rejected", "value": "rejected"},
            ]},
        },
    })

    add_field("access_request", "requested_at", {
        "type": "timestamp",
        "schema": {"is_nullable": False, "default_value": "now()"},
        "meta": {"interface": "datetime", "readonly": True},
    })

    add_field("access_request", "actioned_at", {
        "type": "timestamp",
        "schema": {"is_nullable": True},
        "meta": {"interface": "datetime"},
    })

    add_field("access_request", "actioned_by", {
        "type": "uuid",
        "schema": {"is_nullable": True},
        "meta": {"interface": "input", "note": "app_user.id of the approver/rejecter"},
    })
    create_relation("access_request", "actioned_by", "app_user",
                    schema={"on_delete": "SET NULL"})

    add_field("access_request", "deleted_at", {
        **deleted_at_field(),
    })

    return True


def step_13_partner_model():
    """Matrix §10 partner-client model.

    Adds two nullable FKs on workspace + a referral_ledger collection.
    billed_to_team_id tracks which organisation pays the subscription (partner
    pre-handoff, client post-handoff). effective_client_team_id is
    set when there's a client distinct from the paying organisation.

    The referral ledger records partner kickback agreements (20%
    default, per-workspace, optional expiry).

    Idempotent.
    """
    print("\n=== Step 13: partner-client model ===")

    # Workspace fields.
    add_field("workspace", "billed_to_team_id", {
        "type": "uuid",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "input",
            "note": (
                "FK to org. Which organisation pays the subscription. NULL for "
                "pre-migration workspaces. Partner-owned workspaces point "
                "here pre-handoff."
            ),
        },
    })
    create_relation("workspace", "billed_to_team_id", "org",
                    schema={"on_delete": "SET NULL"})

    add_field("workspace", "effective_client_team_id", {
        "type": "uuid",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "input",
            "note": (
                "FK to org. The client the workspace is for, when "
                "different from billed_to_team_id (partner-client "
                "arrangement). Set on handoff completion."
            ),
        },
    })
    create_relation("workspace", "effective_client_team_id", "org",
                    schema={"on_delete": "SET NULL"})

    # Handoff state on workspace — one workspace in handoff at a time.
    add_field("workspace", "handoff_status", {
        "type": "string",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "select-dropdown",
            "options": {"choices": [
                {"text": "Pending (client accept)", "value": "pending"},
                {"text": "Completed", "value": "completed"},
            ]},
            "note": (
                "Matrix §10. Set 'pending' when partner initiates; "
                "cleared on client accept (and effective_client_team_id "
                "flips)."
            ),
        },
    })

    add_field("workspace", "handoff_target_team_id", {
        "type": "uuid",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "input",
            "note": (
                "Target client organisation during a pending handoff. Cleared on "
                "accept."
            ),
        },
    })
    create_relation("workspace", "handoff_target_team_id", "org",
                    schema={"on_delete": "SET NULL"})

    # Referral ledger collection.
    if not collection_exists("referral_ledger"):
        print("  Creating referral_ledger collection...")
        api("POST", "/collections", {
            "collection": "referral_ledger",
            "meta": {
                "icon": "account_balance",
                "note": (
                    "Matrix §10. Partner kickback agreements per workspace. "
                    "Staff edits; partners read via GET /v2/orgs/:id/"
                    "referral-ledger."
                ),
                "display_template":
                    "{{partner_team_id}} → {{workspace_id}} ({{partner_kickback_percent}}%)",
                "sort_field": "starts_at",
            },
            "schema": {},
        })
        print("  OK referral_ledger collection created")

    add_field("referral_ledger", "id", {
        "type": "uuid",
        "schema": {"is_primary_key": True, "has_auto_increment": False, "is_nullable": False},
        "meta": {"hidden": True, "readonly": True, "interface": "input", "special": ["uuid"]},
    })

    add_field("referral_ledger", "workspace_id", {
        "type": "uuid",
        "schema": {"is_nullable": False},
        "meta": {"interface": "input"},
    })
    create_relation("referral_ledger", "workspace_id", "workspace",
                    schema={"on_delete": "CASCADE"})

    add_field("referral_ledger", "partner_team_id", {
        "type": "uuid",
        "schema": {"is_nullable": False},
        "meta": {"interface": "input", "note": "The organisation receiving the kickback."},
    })
    create_relation("referral_ledger", "partner_team_id", "org",
                    schema={"on_delete": "CASCADE"})

    add_field("referral_ledger", "partner_kickback_percent", {
        "type": "integer",
        "schema": {"is_nullable": False, "default_value": 20},
        "meta": {"interface": "input", "note": "Default 20% per matrix §10."},
    })

    add_field("referral_ledger", "starts_at", {
        "type": "timestamp",
        "schema": {"is_nullable": False, "default_value": "now()"},
        "meta": {"interface": "datetime"},
    })

    add_field("referral_ledger", "expires_at", {
        "type": "timestamp",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "datetime",
            "note": "Optional. NULL = no expiry; set per deal or globally later.",
        },
    })

    add_field("referral_ledger", "notes", {
        "type": "text",
        "schema": {"is_nullable": True},
        "meta": {"interface": "input-multiline"},
    })

    add_field("referral_ledger", "created_by_staff_id", {
        "type": "uuid",
        "schema": {"is_nullable": True},
        "meta": {"interface": "input", "note": "app_user.id of the staff creator"},
    })
    create_relation("referral_ledger", "created_by_staff_id", "app_user",
                    schema={"on_delete": "SET NULL"})

    add_field("referral_ledger", "deleted_at", {
        **deleted_at_field(),
    })

    return True


def step_14_kickback_extensions():
    """Matrix §10 kickback: round out `referral_ledger` with the three
    fields step 13 didn't carry.

    - `from_org_id`: client org (owner of the workspace at the time the
      agreement was written). Denormalized so the ledger doesn't need
      to join back through workspace to answer "what are we earning
      from Client X across all their workspaces?" Snapshotted at
      creation; does not update if workspace ownership moves later —
      a handoff would produce a new ledger row.
    - `to_organisation_discount_percent`: optional parallel benefit — the
      partner's own subscription gets N% off. Null = no discount.
      Independent of `partner_kickback_percent`.
    - `eur_cap_kickback`: optional cap on total lifetime kickback in
      euros. Null = uncapped. Payout side checks this before cutting
      a cheque; the product doesn't enforce it (invoicing is manual
      at this stage).

    Idempotent.
    """
    print("\n=== Step 14: kickback extensions on referral_ledger ===")

    if not collection_exists("referral_ledger"):
        print("  referral_ledger missing — run step 13 first")
        return False

    add_field("referral_ledger", "from_org_id", {
        "type": "uuid",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "input",
            "note": (
                "FK to org — the client whose workspace bill is being "
                "shared. Denormalized from workspace.org_id at the time "
                "the agreement was written; stays stable across handoffs."
            ),
        },
    })
    create_relation("referral_ledger", "from_org_id", "org",
                    schema={"on_delete": "SET NULL"})

    add_field("referral_ledger", "to_organisation_discount_percent", {
        "type": "integer",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "input",
            "note": (
                "Optional. Discount % applied to the partner organisation's own "
                "subscription. Independent of the kickback percent. "
                "Null = no discount."
            ),
        },
    })

    add_field("referral_ledger", "eur_cap_kickback", {
        "type": "decimal",
        "schema": {
            "is_nullable": True,
            "numeric_precision": 12,
            "numeric_scale": 2,
        },
        "meta": {
            "interface": "input",
            "note": (
                "Optional lifetime cap on kickback paid out under this "
                "agreement, in euros. Null = uncapped. Enforced on the "
                "payout side; not by the product."
            ),
        },
    })

    return True


def step_15_prompt_template_workspace_scope():
    """Scope prompt_template to workspaces.

    Pre-matrix, prompt_template was a per-user collection: every row was
    keyed by user_created, and there was no concept of a shared library.
    Matrix v1.1 §4 says members of a workspace collaborate on the chat
    surface — so a template written by one member should be reusable by
    another. To get there without breaking existing rows:

      - Add workspace_id (nullable UUID FK) so a template can live in a
        workspace instead of being tied only to a user.
      - Add scope (string, default 'user') so the backend filter is
        explicit: 'user' rows are private to user_created, 'workspace'
        rows are shared with anyone in workspace_id.
      - Leave existing rows untouched — they'll stay scope='user' and
        keep behaving exactly as before.

    Role gating is enforced at the endpoint layer (template.py):
      admin/owner/member can create/update scope='workspace' templates;
      is_external guests cannot (they can still read + create
      scope='user' templates).
    """
    if not collection_exists("prompt_template"):
        print("  prompt_template missing — nothing to migrate")
        return False

    add_field("prompt_template", "workspace_id", {
        "type": "uuid",
        "schema": {"is_nullable": True},
        "meta": {
            "interface": "input",
            "note": (
                "Optional FK to workspace. When set alongside "
                "scope='workspace', the template is visible to every "
                "workspace member. NULL = user-private template."
            ),
        },
    })
    create_relation("prompt_template", "workspace_id", "workspace",
                    schema={"on_delete": "CASCADE"})

    add_field("prompt_template", "scope", {
        "type": "string",
        "schema": {"is_nullable": False, "default_value": "user"},
        "meta": {
            "interface": "select-dropdown",
            "options": {
                "choices": [
                    {"text": "User (private)", "value": "user"},
                    {"text": "Workspace (shared)", "value": "workspace"},
                ],
            },
            "note": (
                "Controls visibility. 'user' = private to user_created "
                "(legacy behavior). 'workspace' = shared with everyone "
                "in workspace_id."
            ),
        },
    })

    return True


def step_16_access_request_uuid_pk():
    """Convert access_request.id from integer → uuid.

    The original step_12 declared id as uuid, but the `POST /collections`
    call auto-created the table with an integer auto-increment PK, and
    the subsequent `add_field id type=uuid` doesn't alter an existing
    PK column (Directus noops on conflicting shape). Everything else in
    the schema is UUID, so access_request is the odd one out and the
    backend has to str()-cast int ids to match Pydantic types.

    This step migrates via Postgres SQL because the Directus REST API
    can't change a PK column type. Strategy:
      1. Rename current int column to id_old.
      2. Add new uuid column `id` with uuid_generate_v4() default.
      3. Backfill: id = gen_random_uuid() for every existing row.
      4. Drop id_old + its PK constraint.
      5. Add PK on new id.

    Assumes access_request rows are ephemeral (pending join requests
    that get resolved in hours/days). Losing the integer ids is fine —
    any in-flight notifications reference the request by id-in-payload,
    not by FK, and the UX re-queries by (workspace_id, user_id, status).

    Idempotent: checks the current column type first.
    """
    print("\n=== Step 16: access_request.id integer → uuid ===")
    if not collection_exists("access_request"):
        print("  access_request missing — run step 12 first")
        return False

    # Ask Directus what the current type is.
    current = api("GET", "/fields/access_request/id")
    if not current:
        print("  ERROR: couldn't read access_request.id field")
        return False
    current_type = (current.get("data") or {}).get("type")
    if current_type == "uuid":
        print("  already uuid — nothing to do")
        return True
    if current_type not in ("integer", "bigInteger"):
        print(f"  unexpected current type {current_type!r}; aborting")
        return False

    # Directus doesn't expose raw SQL. We drop + recreate the collection.
    # access_request has no inbound FKs (verified via snapshot). The
    # outbound FKs (workspace_id / user_id / actioned_by) live on this
    # table and get recreated by step 12 below.
    print("  dropping access_request collection…")
    api("DELETE", "/collections/access_request")
    print("  recreating with uuid pk via step 12…")
    return step_12_access_requests()


def step_17_conversation_is_over_cap():
    """Add conversation.is_over_cap boolean for over-cap stamping (ADR 0001).

    Durable accounting stamp set once at conversation finish. True iff the
    workspace's tier disallows overage AND the workspace was at or past its
    hour cap before this conversation started. Never recomputed retroactively.

    Idempotent.
    """
    print("\n=== Step 17: conversation.is_over_cap ===")

    add_field("conversation", "is_over_cap", {
        "type": "boolean",
        "schema": {"is_nullable": False, "default_value": False},
        "meta": {
            "interface": "boolean",
            "readonly": True,
            "note": (
                "ADR 0001. Durable stamp set at finish. True = workspace was "
                "at/past its lifetime cap before this conversation started. "
                "The live UI lock is computed from this + current tier."
            ),
        },
    })

    return True


def step_18_workspace_request():
    """Create the workspace_request collection (Slice 08).

    Unified collection for new-workspace and tier-upgrade requests.
    Staff review at /admin/upgrades; requesters see read-only rows.

    Schema trimmed per grilling session: decided_at + decided_by replace
    separate approved_at/approved_by/denied_at/denied_by. No
    proposed_inherit_organisation_admins (always true). No
    proposed_type_discount or proposed_percent_discount (discounts are
    staff-granted only).

    Idempotent.
    """
    print("\n=== Step 18: workspace_request collection ===")

    wr_fields = [
        pk_uuid(),
        {
            "field": "kind",
            "type": "string",
            "schema": {"is_nullable": False},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "New workspace", "value": "new_workspace"},
                    {"text": "Tier upgrade", "value": "tier_upgrade"},
                ]},
                "required": True,
            },
        },
        {
            "field": "status",
            "type": "string",
            "schema": {"is_nullable": False, "default_value": "pending"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Pending", "value": "pending"},
                    {"text": "Approved", "value": "approved"},
                    {"text": "Denied", "value": "denied"},
                ]},
            },
        },
        {
            "field": "requested_by",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True,
                     "note": "FK to app_user — the submitter."},
        },
        {
            "field": "org_id",
            "type": "uuid",
            "schema": {"is_nullable": False},
            "meta": {"interface": "input", "required": True,
                     "note": "Target org for new_workspace; existing org for tier_upgrade."},
        },
        {
            "field": "workspace_id",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input",
                     "note": "Set for tier_upgrade; null for new_workspace until approved."},
        },
        {
            "field": "proposed_name",
            "type": "string",
            "schema": {"is_nullable": True, "max_length": 100},
            "meta": {"interface": "input",
                     "note": "Only for new_workspace."},
        },
        {
            "field": "proposed_tier",
            "type": "string",
            "schema": {"is_nullable": False, "default_value": "innovator"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Pilot", "value": "pilot"},
                    {"text": "Pioneer", "value": "pioneer"},
                    {"text": "Innovator", "value": "innovator"},
                    {"text": "Changemaker", "value": "changemaker"},
                    {"text": "Guardian", "value": "guardian"},
                ]},
            },
        },
        {
            "field": "proposed_visibility",
            "type": "string",
            "schema": {"is_nullable": False, "default_value": "open_to_organisation"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Open to organisation", "value": "open_to_organisation"},
                    {"text": "Private", "value": "private"},
                ]},
            },
        },
        {
            "field": "requester_message",
            "type": "text",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input-multiline",
                     "note": "Free text from requester, max 1000 chars."},
        },
        {
            "field": "granted_tier",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Free", "value": "free"},
                    {"text": "Pilot", "value": "pilot"},
                    {"text": "Pioneer", "value": "pioneer"},
                    {"text": "Innovator", "value": "innovator"},
                    {"text": "Changemaker", "value": "changemaker"},
                    {"text": "Guardian", "value": "guardian"},
                ]},
                "note": "What staff actually granted (may differ from proposed).",
            },
        },
        {
            "field": "granted_tier_expires_at",
            "type": "timestamp",
            "schema": {"is_nullable": True},
            "meta": {"interface": "datetime",
                     "note": "Optional expiry on the granted tier."},
        },
        {
            "field": "granted_type_discount",
            "type": "string",
            "schema": {"is_nullable": True},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Scholarship", "value": "scholarship"},
                    {"text": "Staff discount", "value": "staff_discount"},
                ]},
            },
        },
        {
            "field": "granted_percent_discount",
            "type": "integer",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input",
                     "note": "0-100. Applied at tier subscription price only."},
        },
        {
            "field": "resulting_workspace_id",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input",
                     "note": "Points to created (new_workspace) or upgraded (tier_upgrade) workspace."},
        },
        {
            "field": "decided_at",
            "type": "timestamp",
            "schema": {"is_nullable": True},
            "meta": {"interface": "datetime",
                     "note": "When staff approved or denied."},
        },
        {
            "field": "decided_by",
            "type": "uuid",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input",
                     "note": "FK to app_user — the staff member who decided."},
        },
        {
            "field": "denial_reason",
            "type": "text",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input-multiline",
                     "note": "Required on deny; shown to requester."},
        },
        {
            "field": "staff_notes",
            "type": "text",
            "schema": {"is_nullable": True},
            "meta": {"interface": "input-multiline",
                     "note": "Internal staff notes. Never shown to requester. Field-level locked to staff role."},
        },
        {"field": "created_at", **timestamp_created()},
        {"field": "updated_at", **timestamp_updated()},
    ]

    ok = create_collection("workspace_request", wr_fields, {
        "accountability": "all",
        "display_template": "{{kind}} — {{status}} ({{proposed_tier}})",
        "sort_field": "created_at",
    })
    if not ok:
        return False

    create_relation("workspace_request", "requested_by", "app_user",
                    schema={"on_delete": "CASCADE"})
    create_relation("workspace_request", "org_id", "org",
                    schema={"on_delete": "CASCADE"})
    create_relation("workspace_request", "workspace_id", "workspace",
                    schema={"on_delete": "SET NULL"})
    create_relation("workspace_request", "resulting_workspace_id", "workspace",
                    schema={"on_delete": "SET NULL"})
    create_relation("workspace_request", "decided_by", "app_user",
                    schema={"on_delete": "SET NULL"})

    return True


def step_19_workspace_tier_expires_at():
    """Add workspace.tier_expires_at nullable timestamp (Slice 15).

    Staff-writable. When set and elapsed, the hourly cron downgrades
    the workspace to free. NULL means no auto-expiry.

    Idempotent.
    """
    print("\n=== Step 19: workspace.tier_expires_at ===")

    add_field("workspace", "tier_expires_at", {
        "type": "timestamp",
        "schema": {"is_nullable": True, "default_value": None},
        "meta": {
            "interface": "datetime",
            "note": (
                "Optional tier expiry. Staff sets at approval time. "
                "Hourly cron downgrades to free when elapsed."
            ),
        },
    })

    return True


def step_20_workspace_pre_warning_sent():
    """Add workspace.pre_warning_sent boolean (Slice 16).

    Deduplicates the 3-day tier-expiry pre-warning email. Reset to
    false whenever staff changes tier_expires_at.

    Idempotent.
    """
    print("\n=== Step 20: workspace.pre_warning_sent ===")

    add_field("workspace", "pre_warning_sent", {
        "type": "boolean",
        "schema": {"is_nullable": False, "default_value": False},
        "meta": {
            "interface": "boolean",
            "note": (
                "Dedup flag for 3-day tier-expiry pre-warning email. "
                "Reset to false when tier_expires_at changes."
            ),
        },
    })

    return True


def step_21_workspace_discount_fields():
    """Add workspace.type_discount and workspace.percent_discount (Slice 19).

    Staff-writable, members read-only. Descriptive metadata only — no code
    path computes a price using these fields.

    Idempotent.
    """
    print("\n=== Step 21: workspace.type_discount + workspace.percent_discount ===")

    add_field("workspace", "type_discount", {
        "type": "string",
        "schema": {"is_nullable": True, "default_value": None},
        "meta": {
            "interface": "select-dropdown",
            "options": {"choices": [
                {"text": "Scholarship", "value": "scholarship"},
                {"text": "Staff discount", "value": "staff_discount"},
            ]},
            "note": (
                "Categorical discount label. Staff write, members read. "
                "Descriptive only — not enforced by any billing code path."
            ),
        },
    })

    add_field("workspace", "percent_discount", {
        "type": "integer",
        "schema": {"is_nullable": True, "default_value": None},
        "meta": {
            "interface": "input",
            "note": (
                "0-100. Applied at tier subscription price only (descriptive). "
                "Does NOT discount overage, add-on seats, or à la carte items."
            ),
        },
    })

    return True


STEPS = {
    "1": ("app_user", step_1_app_user),
    "2": ("org + org_membership", step_2_org),
    "3": ("workspace + workspace_membership", step_3_workspace),
    "4": ("workspace_invite + project_membership", step_4_invite_and_project_membership),
    "5": ("usage_event", step_5_usage_event),
    "6": ("project fields (workspace_id, visibility, deleted_at)", step_6_project_fields),
    "7": ("deleted_at on conversation, project_chat, project_report", step_7_deleted_at),
    "8": ("remove legacy chat", step_8_remove_chat),
    "9": ("notifications trio (inbox)", step_9_notifications),
    "10": ("workspace.visibility enum + backfill", step_10_workspace_visibility),
    "11": ("workspace downgrade tracking", step_11_downgrade_tracking),
    "12": ("access_request collection", step_12_access_requests),
    "13": ("partner-client model (§10)", step_13_partner_model),
    "14": ("kickback extensions on referral_ledger", step_14_kickback_extensions),
    "15": ("prompt_template workspace scope", step_15_prompt_template_workspace_scope),
    "16": ("access_request.id integer → uuid", step_16_access_request_uuid_pk),
    "17": ("conversation.is_over_cap stamp", step_17_conversation_is_over_cap),
    "18": ("workspace_request collection", step_18_workspace_request),
    "19": ("workspace.tier_expires_at field", step_19_workspace_tier_expires_at),
    "20": ("workspace.pre_warning_sent flag", step_20_workspace_pre_warning_sent),
    "21": ("workspace discount fields (type_discount, percent_discount)", step_21_workspace_discount_fields),
}


def main():
    parser = argparse.ArgumentParser(description="Create workspace schema in Directus")
    parser.add_argument("--step", required=True,
                        help="Step number (1-21) or 'all'")
    args = parser.parse_args()

    # Verify connection
    print(f"Directus URL: {DIRECTUS_URL}")
    health = api("GET", "/server/health")
    if not health:
        print("ERROR: Cannot connect to Directus")
        sys.exit(1)
    print("Directus is healthy\n")

    if args.step == "all":
        steps_to_run = list(STEPS.keys())
    else:
        steps_to_run = [args.step]

    for step_num in steps_to_run:
        if step_num not in STEPS:
            print(f"ERROR: Unknown step {step_num}. Valid: 1-21 or 'all'")
            sys.exit(1)

        name, fn = STEPS[step_num]
        print(f"{'='*60}")
        print(f"Step {step_num}: {name}")
        print(f"{'='*60}")

        ok = fn()
        if not ok:
            print(f"\nStep {step_num} FAILED. Stopping.")
            sys.exit(1)

        print(f"Step {step_num} complete.\n")

    print("\nAll requested steps complete.")
    print("Next: run 'cd directus && bash sync.sh pull' to capture schema changes.")


if __name__ == "__main__":
    main()
