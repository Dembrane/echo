# Parity environment

The Python API (echo main) against its own Postgres, Directus 11.13.4 and Valkey (compose project
`parity`, ports 5440, 8065, 6395). The schema is built the way main deploys it (Directus bootstrap,
directus-sync push, `add_map_vectors.sql`, `add_analysis_constraints.sql`) and checked against
echo-next's dump. The fixed seed (`fixtures.ts`) is frozen as `parity_template`, so every scenario
starts from the same rows. Logins and tokens live in `.env.parity` (generated, gitignored).

- `./bootstrap.sh`: rebuild everything from nothing, including the schema check and the template.
- `./reset.sh [db]`: recreate `db` (default `dembrane`, the one Directus and the API use) from the
  template and flush Valkey. About 0.2s.
- `./run-old-api.sh`: the Python API on :8100. `bun verify-old-api.ts` logs in as every seeded user
  and reads their data back, including the MCP grant.

Known gaps:
- No object store: audio upload, download and transcription paths fail.
- LLM groups point at Vertex (gemini-3.8-flash, eu) with this box's gcloud credentials, copied from
  `~/orca/echo/echo/server/.env`; no LLM-backed endpoint has been exercised yet.
- directus-sync gives roles and policies fresh ids on every bootstrap; the seed resolves them by name.
- Directus-managed timestamps (`date_created`) and startup-seeded rows are frozen by the template but
  differ between bootstraps. Logins write `directus_sessions`: ignore it when diffing rows.
- The membership unique indexes from `docs/database_migrations.md` step 4 are left out: neither
  echo-next nor prod has them.
