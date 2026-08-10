# directus-sync push fails on production with a DROP INDEX for an index that does not exist

**Rule: if a column is indexed on production, the snapshot field file must say
`is_indexed: true`. A `false` there against a live index named by any other convention
makes Directus emit a `DROP INDEX` for a name that was never created, and the entire
`schema/apply` aborts.**

## What happened

`cd echo/directus && bash sync.sh ... push` against production returned a 500:

```
drop index "conversation_chunk_timestamp_index" - index "conversation_chunk_timestamp_index" does not exist
```

Nothing applied. The same push succeeded against local and testing.

## Mechanism

`sync.sh push` ends in `POST /schema/apply`. Directus builds the diff by introspecting
the live database and comparing it against the committed snapshot under
`echo/directus/sync/snapshot/`.

Directus introspection reports `is_indexed: true` for a column if *any* index covers
it, regardless of that index's name. Production carries hand-applied performance
indexes using an `idx_*` naming convention (for `conversation_chunk.timestamp`, indexes
such as `idx_chunk_conv_timestamp` and `idx_chunk_recent_non_upload`). Those indexes
are not represented anywhere in the repository, so a `pull` from a database that lacks
them writes `is_indexed: false` into the snapshot.

That leaves the diff as `is_indexed: true -> false` on production, which Directus
translates into "drop the index on this column". The knex layer does not look up which
index actually exists. It generates the name from its own convention,
`{table}_{field}_index`, so it emits
`DROP INDEX "conversation_chunk_timestamp_index"`. No such index exists. Postgres
errors, and because `schema/apply` runs in a single transaction the whole push rolls
back, including every unrelated collection and field change in the same snapshot.

Local and testing never hit this: they have no `idx_*` indexes, so the column is
genuinely unindexed, snapshot `false` matches live `false`, and no index statement is
generated at all. The failure is production-only by construction.

## Fix

Set `is_indexed: true` in the snapshot field file. For
`conversation_chunk.timestamp` this is
`echo/directus/sync/snapshot/fields/conversation_chunk/timestamp.json`, done in
`fix(directus): mark conversation_chunk.timestamp as indexed in schema snapshot`
(4635762b, PR #724):

```json
"schema": {
  ...
  "is_indexed": true,
```

Source `true` matches live `true`, the diff disappears, and no index DDL is generated.
The file is committed with `is_indexed: true` today.

This is one of the narrow cases where editing snapshot JSON by hand is correct. The
standing rule in `AGENTS.md` is never to hand-write these files, because they should be
produced by `sync.sh pull` after running an idempotent migration script. That rule
still holds for structure. It cannot hold here, since a `pull` from any environment
without the production perf indexes reintroduces the `false`.

## What not to do

Creating `conversation_chunk_timestamp_index` on production so that the `DROP` has a
target does clear the immediate 500, but the push then drops it while the `idx_*`
indexes keep the column indexed. The next `pull`/`push` cycle regenerates the same
mismatch, so the failure returns on every sync.

## Applying it to the next field

When a push fails on production with `drop index ... does not exist`:

1. Read the table and column out of the index name in the error.
2. Confirm the column really is indexed on production
   (`\d <table>` or a query against `pg_indexes`), under whatever name.
3. Set `is_indexed: true` on that field's snapshot file and push again.

Directus system tables are not affected. Only `directus_users` is present in the
snapshot; `directus_activity`, `directus_revisions` and `directus_presets` are not, so
their indexes never take part in `schema/apply`.

## See also

- `../../AGENTS.md`, "Directus Rules (Critical)"
- [../database_migrations.md](../database_migrations.md)
