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

6. Shared analysis objects and recipe runs (`analysis_scope`, `analysis_run`,
   `analysis_step`, `analysis_object`, `analysis_object_revision`,
   `analysis_relation`, `analysis_snapshot`, `analysis_outbox`,
   `analysis_request_key`, plus `map_result.manifest_version` and
   `map_result.snapshot_id`). The collections, fields and foreign keys come
   from the snapshot push in step 2. The unique keys the lifecycle relies on
   (accepted idempotency keys, request order, one step per run, revision
   numbers, one publication sequence per scope, one snapshot per source event),
   the composite and partial indexes, the CHECK constraints on statuses and hash
   versions and the same-project and immutability triggers are SQL-only. Deploy
   in this order:

   1. Push the snapshot (step 2).
   2. Run the Map SQL (step 5), then this script:

```bash
psql -h postgres -p 5432 -U dembrane -v ON_ERROR_STOP=1 \
    -f echo/directus/migrations/add_analysis_constraints.sql
```

   3. Deploy the API, the ticks worker (`prod-worker-ticks.sh` serves
      `task_analysis_run` and `task_analysis_outbox_dispatch`) and the
      scheduler (`task_analysis_outbox_sweep`, every minute), in that order or
      together. Nothing writes the new tables before the application that uses
      them is deployed, and existing `map_result` rows read as
      `manifest_version = 1`.

The script is idempotent, runs in one transaction and stops on the first error;
it refuses to run before the push. Its indexes never use Directus's
`{table}_{field}_index` names and none is single-column, so a pull still writes
`is_indexed: false` for these fields and a later push leaves every SQL object in
place. To roll back, stop the analysis actors, revert the application and keep
the schema and its data. `add_analysis_schema.py` in the same folder is the
Directus script the snapshot was pulled from, kept for a local database without
a push.