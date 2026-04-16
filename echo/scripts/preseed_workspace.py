"""
Pre-seed workspaces for existing clients.

Creates orgs, workspaces, and invites users. Handles both existing
Directus users (immediate setup) and new users (creates Directus
account with invite email).

Usage:
    python scripts/preseed_workspace.py --config preseed/example.yaml
    python scripts/preseed_workspace.py --config preseed/example.yaml --dry-run

YAML config format:

    org:
      name: "Dietz Consulting"
      owner: petra@dietz.nl
      admins:
        - jan@dietz.nl
        - lisa@dietz.nl

    workspaces:
      - name: "Client Alpha"
        tier: pioneer
        include_projects: true    # move owner+admin projects here

      - name: "Client Beta"
        tier: pioneer
        include_projects: false   # empty workspace
"""

import argparse
import sys
from logging import getLogger, basicConfig, INFO
from pathlib import Path

import yaml

# Add server to path so we can import dembrane modules
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

logger = getLogger("preseed")


def load_config(path: str) -> dict:
    with open(path) as f:
        return yaml.safe_load(f)


def find_directus_user_by_email(client, email: str) -> dict | None:
    """Find a Directus user by email. Returns None if not found."""
    users = client.get_users(
        {"query": {"filter": {"email": {"_eq": email}}, "fields": ["id", "email", "first_name", "last_name"], "limit": 1}}
    )
    if isinstance(users, list) and len(users) > 0:
        return users[0]
    return None


def find_or_create_directus_user(client, email: str, role_id: str, dry_run: bool) -> dict | None:
    """Find existing Directus user or create one with invite."""
    existing = find_directus_user_by_email(client, email)
    if existing:
        logger.info(f"  Found existing Directus user: {email} (id: {existing['id']})")
        return existing

    if dry_run:
        logger.info(f"  WOULD create Directus user + send invite: {email}")
        return None

    logger.info(f"  Creating Directus user + sending invite: {email}")
    result = client.post("/users", json={
        "email": email,
        "role": role_id,
        "status": "invited",
    })
    user = result.get("data", result)
    logger.info(f"  Created Directus user: {email} (id: {user.get('id')})")
    return user


def find_or_create_app_user(client, directus_user_id: str, email: str, display_name: str, dry_run: bool) -> dict | None:
    """Find existing app_user or create one."""
    items = client.get_items("app_user", {"query": {"filter": {"directus_user_id": {"_eq": directus_user_id}}, "limit": 1}})
    if isinstance(items, list) and len(items) > 0:
        logger.info(f"  Found existing app_user for {email}")
        return items[0]

    if dry_run:
        logger.info(f"  WOULD create app_user for {email}")
        return None

    from dembrane.utils import generate_uuid
    app_user_id = generate_uuid()
    result = client.create_item("app_user", {
        "id": app_user_id,
        "directus_user_id": directus_user_id,
        "email": email,
        "display_name": display_name,
    })
    app_user = result["data"]
    logger.info(f"  Created app_user: {app_user['id']} for {email}")
    return app_user


def run_preseed(config: dict, dry_run: bool = True):
    from dembrane.directus import create_directus_client
    from dembrane.utils import generate_uuid
    from dembrane.settings import get_settings

    settings = get_settings()
    client = create_directus_client(token=settings.directus.token)

    org_config = config["org"]
    workspace_configs = config.get("workspaces", [])

    # Get the Basic User role ID for new user creation
    basic_user_role_id = None
    try:
        import requests
        resp = requests.get(
            f"{settings.directus.base_url}/roles?fields=id,name",
            headers={"Authorization": f"Bearer {settings.directus.token}"},
            timeout=10,
        )
        for role in resp.json().get("data", []):
            if role["name"] == "Basic User":
                basic_user_role_id = role["id"]
                break
    except Exception as e:
        logger.error(f"Failed to fetch roles: {e}")
        return

    if not basic_user_role_id:
        logger.error("Could not find 'Basic User' role")
        return

    logger.info(f"{'DRY RUN — ' if dry_run else ''}Pre-seeding org: {org_config['name']}")

    # ── Collect all emails ──
    all_emails = {
        org_config["owner"]: "owner",
    }
    for email in org_config.get("admins", []):
        all_emails[email] = "admin"
    for email in org_config.get("members", []):
        if email not in all_emails:
            all_emails[email] = "member"

    # ── Ensure all users exist in Directus + app_user ──
    app_users: dict[str, dict] = {}  # email -> app_user record

    for email, role in all_emails.items():
        logger.info(f"\nProcessing user: {email} (org role: {role})")

        directus_user = find_or_create_directus_user(client, email, basic_user_role_id, dry_run)
        if not directus_user:
            if dry_run:
                app_users[email] = {"id": f"<dry-run-{email}>", "email": email}
            continue

        first = directus_user.get("first_name") or ""
        last = directus_user.get("last_name") or ""
        display_name = f"{first} {last}".strip() or email

        app_user = find_or_create_app_user(
            client, directus_user["id"], email, display_name, dry_run
        )
        if app_user:
            app_users[email] = app_user
        elif dry_run:
            app_users[email] = {"id": f"<dry-run-{email}>", "email": email}

    owner_email = org_config["owner"]
    owner_app_user = app_users.get(owner_email)
    if not owner_app_user:
        logger.error(f"Owner {owner_email} could not be resolved. Aborting.")
        return

    # ── Create org ──
    logger.info(f"\nCreating org: {org_config['name']}")

    existing_orgs = client.get_items("org_membership", {
        "query": {"filter": {"user_id": {"_eq": owner_app_user["id"]}, "role": {"_eq": "owner"}, "deleted_at": {"_null": True}}, "fields": ["org_id"], "limit": 1}
    })

    if isinstance(existing_orgs, list) and len(existing_orgs) > 0:
        org_id = existing_orgs[0]["org_id"]
        logger.info(f"  Org already exists: {org_id}")
    elif dry_run:
        org_id = "<dry-run-org>"
        logger.info(f"  WOULD create org: {org_config['name']}")
    else:
        org_id = generate_uuid()
        client.create_item("org", {
            "id": org_id,
            "name": org_config["name"],
            "created_by": owner_app_user["id"],
        })
        client.create_item("org_membership", {
            "id": generate_uuid(),
            "org_id": org_id,
            "user_id": owner_app_user["id"],
            "role": "owner",
        })
        logger.info(f"  Created org: {org_id}")

    # Add org admins/members
    for email, role in all_emails.items():
        if email == owner_email:
            continue
        app_user = app_users.get(email)
        if not app_user or app_user["id"].startswith("<dry-run"):
            if dry_run:
                logger.info(f"  WOULD add {email} as org {role}")
            continue

        # Check if already a member
        existing = client.get_items("org_membership", {
            "query": {"filter": {"org_id": {"_eq": org_id}, "user_id": {"_eq": app_user["id"]}, "deleted_at": {"_null": True}}, "limit": 1}
        })
        if isinstance(existing, list) and len(existing) > 0:
            logger.info(f"  {email} already org member, skipping")
            continue

        if dry_run:
            logger.info(f"  WOULD add {email} as org {role}")
        else:
            client.create_item("org_membership", {
                "id": generate_uuid(),
                "org_id": org_id,
                "user_id": app_user["id"],
                "role": role,
            })
            logger.info(f"  Added {email} as org {role}")

    # ── Create workspaces ──
    for ws_config in workspace_configs:
        ws_name = ws_config["name"]
        ws_tier = ws_config.get("tier", "pioneer")
        include_projects = ws_config.get("include_projects", False)

        logger.info(f"\nCreating workspace: {ws_name} (tier: {ws_tier})")

        # Check if workspace already exists
        existing_ws = client.get_items("workspace", {
            "query": {"filter": {"org_id": {"_eq": org_id}, "name": {"_eq": ws_name}, "deleted_at": {"_null": True}}, "limit": 1}
        })

        if isinstance(existing_ws, list) and len(existing_ws) > 0:
            ws_id = existing_ws[0]["id"]
            logger.info(f"  Workspace already exists: {ws_id}")
        elif dry_run:
            ws_id = f"<dry-run-ws-{ws_name}>"
            logger.info(f"  WOULD create workspace: {ws_name}")
        else:
            ws_id = generate_uuid()
            client.create_item("workspace", {
                "id": ws_id,
                "org_id": org_id,
                "name": ws_name,
                "tier": ws_tier,
                "is_default": False,
                "created_by": owner_app_user["id"],
            })
            logger.info(f"  Created workspace: {ws_id}")

        # Add workspace memberships for org admins/owner (inherited)
        for email, org_role in all_emails.items():
            if org_role not in ("owner", "admin"):
                continue
            app_user = app_users.get(email)
            if not app_user or app_user["id"].startswith("<dry-run"):
                continue

            existing_wm = client.get_items("workspace_membership", {
                "query": {"filter": {"workspace_id": {"_eq": ws_id}, "user_id": {"_eq": app_user["id"]}, "deleted_at": {"_null": True}}, "limit": 1}
            })
            if isinstance(existing_wm, list) and len(existing_wm) > 0:
                continue

            ws_role = "owner" if email == owner_email else "admin"
            if dry_run:
                logger.info(f"  WOULD add {email} as workspace {ws_role} (inherited)")
            else:
                client.create_item("workspace_membership", {
                    "id": generate_uuid(),
                    "workspace_id": ws_id,
                    "user_id": app_user["id"],
                    "role": ws_role,
                    "source": "inherited",
                })
                logger.info(f"  Added {email} as workspace {ws_role} (inherited)")

        # Add workspace members (direct)
        for email, org_role in all_emails.items():
            if org_role != "member":
                continue
            app_user = app_users.get(email)
            if not app_user or app_user["id"].startswith("<dry-run"):
                continue

            existing_wm = client.get_items("workspace_membership", {
                "query": {"filter": {"workspace_id": {"_eq": ws_id}, "user_id": {"_eq": app_user["id"]}, "deleted_at": {"_null": True}}, "limit": 1}
            })
            if isinstance(existing_wm, list) and len(existing_wm) > 0:
                continue

            if dry_run:
                logger.info(f"  WOULD add {email} as workspace member (direct)")
            else:
                client.create_item("workspace_membership", {
                    "id": generate_uuid(),
                    "workspace_id": ws_id,
                    "user_id": app_user["id"],
                    "role": "member",
                    "source": "direct",
                })
                logger.info(f"  Added {email} as workspace member (direct)")

        # Move projects if requested
        if include_projects and not dry_run:
            for email in all_emails:
                app_user = app_users.get(email)
                if not app_user or app_user["id"].startswith("<dry-run"):
                    continue

                # Find user's directus_user_id
                du_id = app_user.get("directus_user_id")
                if not du_id:
                    continue

                projects = client.get_items("project", {
                    "query": {"filter": {"directus_user_id": {"_eq": du_id}, "workspace_id": {"_null": True}}, "fields": ["id"], "limit": -1}
                })
                if isinstance(projects, list):
                    for proj in projects:
                        client.update_item("project", proj["id"], {"workspace_id": ws_id})
                    if projects:
                        logger.info(f"  Moved {len(projects)} projects from {email} into {ws_name}")
        elif include_projects and dry_run:
            logger.info(f"  WOULD move projects from org members into {ws_name}")

    logger.info(f"\n{'DRY RUN complete' if dry_run else 'Pre-seed complete'}.")


def main():
    basicConfig(level=INFO, format="%(message)s")

    parser = argparse.ArgumentParser(description="Pre-seed workspaces from YAML config")
    parser.add_argument("--config", required=True, help="Path to YAML config file")
    parser.add_argument("--dry-run", action="store_true", help="Log what would be done without writing")
    args = parser.parse_args()

    config = load_config(args.config)

    run_preseed(config, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
