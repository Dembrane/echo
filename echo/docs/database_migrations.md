# Database Migrations

These are handled through the [directus-sync](https://github.com/tractr/directus-sync) extension on Directus running on the PostgreSQL database.

1. CD into directus folder (../echo/directus)

2. **Run** the sync command in the dev container terminal or a WSL terminal inside "echo > directus" directory:

```bash
1. run command: ./sync.sh
2. choose option 1: push
```

3. Run the SQL script on the machine

`psql -h postgres -p 5432 -U dembrane`

- default password is dembrane if you're using the dev container

```bash
CREATE extension vector;
```

4. Membership unique indexes (one active membership per user per org/workspace;
   the invite race fix in `dembrane/api/v2/_invite_helpers.py` relies on these.
   Deploy the API change first, then run):

```bash
CREATE UNIQUE INDEX IF NOT EXISTS org_membership_active_org_user_uniq
    ON org_membership (org_id, user_id) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_membership_active_ws_user_uniq
    ON workspace_membership (workspace_id, user_id) WHERE deleted_at IS NULL;
```

If creation fails with a duplicate-key error, duplicate active rows exist;
dedupe them first (keep one row per pair, soft-delete the rest), then re-run.