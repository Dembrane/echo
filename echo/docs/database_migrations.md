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

5. Map (`map_result`, `map_embedding`, `map_fact_check`). The collections come
   from the snapshot push in step 2. The vector column, its checks and the
   indexes Map relies on are SQL-only, because Directus does not model pgvector
   columns. Run after the push and before deploying the API that uses Map:

```bash
psql -h postgres -p 5432 -U dembrane -v ON_ERROR_STOP=1 \
    -f echo/directus/migrations/add_map_vectors.sql
```

The script is idempotent and stops on the first error. A later snapshot push
leaves the SQL-managed column and indexes in place. To roll back, revert the
application and keep this schema and its data; never drop the shared `vector`
extension. `add_map_schema.py` in the same folder is the Directus script the
snapshot was pulled from, kept for a fresh local database without a push.