"""
Session 2: Create workspace schema collections via Directus API.

Usage:
    python scripts/create_schema.py --step 1        # app_user only (test)
    python scripts/create_schema.py --step 2        # org + org_membership
    python scripts/create_schema.py --step 3        # workspace + workspace_membership
    python scripts/create_schema.py --step 4        # workspace_invite + project_membership
    python scripts/create_schema.py --step 5        # (removed — usage_event dropped)
    python scripts/create_schema.py --step 6        # add fields to project
    python scripts/create_schema.py --step 7        # add deleted_at to existing collections
    python scripts/create_schema.py --step 8        # remove legacy chat collection
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
            "schema": {"is_nullable": False, "default_value": "pioneer"},
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
# Step 9: Notifications (inbox) — mirrors the announcement trio
# ---------------------------------------------------------------------------

def step_9_notifications():
    """Per-user notifications. Follows the announcement pattern
    (parent + translations + activity) and adds targeting fields
    (audience_user_id, action enum, ref_* nullable FKs).

    Note on channels: this is the canonical in-app store. A future
    delivery layer can read from it to ship email or Slack; we don't
    split the storage per channel. Inbox UI, email digests, and Slack
    webhooks all flow through the same rows. (See the sibling comment
    in dembrane/notifications.py service module.)
    """
    print("\n=== Step 9: notification + notification_translations + notification_activity ===")

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
                     "note": "Machine enum. INVITE_CREATED, ROLE_CHANGED, SHARE_ADDED, REPORT_READY, etc."},
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
                    {"text": "Navigate to team settings", "value": "NAVIGATE_TEAM_SETTINGS"},
                    {"text": "Navigate to workspace settings", "value": "NAVIGATE_WORKSPACE_SETTINGS"},
                ]},
                "note": "Codified nav target. UI resolves the URL from ref_* fields.",
            },
        },
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
        {
            "field": "level", "type": "string",
            "schema": {"is_nullable": False, "default_value": "info"},
            "meta": {
                "interface": "select-dropdown",
                "options": {"choices": [
                    {"text": "Info", "value": "info"},
                    {"text": "Urgent", "value": "urgent"},
                ]},
            },
        },
        {"field": "expires_at", "type": "timestamp",
         "schema": {"is_nullable": True},
         "meta": {"interface": "datetime",
                  "note": "Hide from inbox after this timestamp."}},
        {"field": "translations", "type": "alias",
         "meta": {"interface": "translations", "special": ["translations"]}},
        {"field": "activity", "type": "alias",
         "meta": {"interface": "list-o2m", "special": ["o2m"]}},
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
    create_relation("notification", "ref_report_id", "project_report",
                    schema={"on_delete": "SET NULL"})
    create_relation("notification", "ref_conversation_id", "conversation",
                    schema={"on_delete": "SET NULL"})
    create_relation("notification", "ref_invite_id", "workspace_invite",
                    schema={"on_delete": "SET NULL"})

    # notification_translations
    nt_fields = [
        pk_uuid(),
        {"field": "notification_id", "type": "uuid",
         "schema": {"is_nullable": False},
         "meta": {"interface": "input", "required": True}},
        {"field": "languages_code", "type": "string",
         "schema": {"is_nullable": False},
         "meta": {"interface": "input", "required": True}},
        {"field": "title", "type": "string",
         "schema": {"is_nullable": False},
         "meta": {"interface": "input", "required": True}},
        {"field": "message", "type": "text",
         "schema": {"is_nullable": True},
         "meta": {"interface": "input-multiline",
                  "note": "Markdown allowed."}},
    ]
    if not create_collection("notification_translations", nt_fields, {
        "accountability": "all",
    }):
        return False
    create_relation("notification_translations", "notification_id", "notification",
                    meta={"one_field": "translations"},
                    schema={"on_delete": "CASCADE"})
    create_relation("notification_translations", "languages_code", "languages",
                    schema={"on_delete": "NO ACTION"})

    # notification_activity — per-user read state. Mirrors announcement_activity
    # exactly so the inbox drawer can render both with one component. Rows
    # are pre-created on emit (one per notification — audience is known) so
    # unread counts are a simple aggregate.
    na_fields = [
        pk_uuid(),
        {"field": "notification_id", "type": "uuid",
         "schema": {"is_nullable": False},
         "meta": {"interface": "input", "required": True}},
        {"field": "user_id", "type": "uuid",
         "schema": {"is_nullable": False},
         "meta": {"interface": "input", "special": ["user-created"],
                  "required": True,
                  "note": "FK to directus_users (matches announcement_activity)."}},
        {"field": "read", "type": "boolean",
         "schema": {"is_nullable": False, "default_value": False},
         "meta": {"interface": "boolean"}},
        {"field": "created_at", **timestamp_created()},
        {"field": "updated_at", **timestamp_updated()},
    ]
    if not create_collection("notification_activity", na_fields, {
        "accountability": "all",
    }):
        return False
    create_relation("notification_activity", "notification_id", "notification",
                    meta={"one_field": "activity"},
                    schema={"on_delete": "CASCADE"})

    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

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
}


def main():
    parser = argparse.ArgumentParser(description="Create workspace schema in Directus")
    parser.add_argument("--step", required=True,
                        help="Step number (1-8) or 'all'")
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
            print(f"ERROR: Unknown step {step_num}. Valid: 1-8 or 'all'")
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
