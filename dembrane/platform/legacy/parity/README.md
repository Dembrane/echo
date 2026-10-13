# Parity environment

The Python API (echo main) against its own Postgres, Directus 11.13.4 and Valkey (compose project
`parity`, ports 5440, 8065, 6395). The schema is built the way main deploys it (Directus bootstrap,
directus-sync push, `add_map_vectors.sql`, `add_analysis_constraints.sql`) and checked against
echo-next's dump. The fixed seed (`fixtures.ts`) is frozen as `parity_template`, so every scenario
starts from the same rows. Logins and tokens live in `.env.parity` (generated, gitignored).

The old side (Python API, Directus, the demo scripts) comes from a checkout of echo main at
`OLD_ECHO_DIR`, by default `~/orca/workspaces/echo-parity-main`:

```sh
git fetch origin
git worktree add ~/orca/workspaces/echo-parity-main origin/main --detach
OLD_ECHO_DIR=~/orca/workspaces/echo-parity-main ./run-old-api.sh
```

- `./bootstrap.sh`: rebuild everything from nothing, including the schema check and the template.
- `./reset.sh [db]`: recreate `db` (default `dembrane`, the one Directus and the API use) from the
  template and flush Valkey. About 0.2s.
- `./run-old-api.sh`: the Python API on :8100. `bun verify-old-api.ts` logs in as every seeded user
  and reads their data back, including the MCP grant.
- `PARITY_API_PORT=8212 ./run-new-api.sh`: this worktree's Bun API with the env that makes it answer
  like the old one (public URL, storage, Vertex, secrets from `.env.parity`). Point the runner at it
  with `PARITY_NEW_URL`.

## Fixture

`fixture/parity_template.sql` is a dump of `parity_template`, so the suites that copy the template
run without the old stack. `fixture/load.sh` builds `parity_template`, `parity_template_platform`
and `parity_auth` from it on an empty server; the server checks do that on every change.

After a bootstrap that changes the seed, `fixture/dump.sh` rewrites the file. It applies
`fixture/scrub.sql` first: of Directus's own tables only users, roles, policies, access, folders
and settings keep their rows, the ones the platform reads. Tokens and secrets are cleared, every
address is on example.com, and every user has the password `parity-fixture-password`
(`TEST_PARITY_USER_PASSWORD` for the auth suite).

Known gaps:
- No object store: audio upload, download and transcription paths fail.
- LLM groups point at Vertex (gemini-3.8-flash, eu) with this box's gcloud credentials, copied from
  `~/orca/echo/echo/server/.env`; no LLM-backed endpoint has been exercised yet.
- directus-sync gives roles and policies fresh ids on every bootstrap; the seed resolves them by name.
- Directus-managed timestamps (`date_created`) and startup-seeded rows are frozen by the template but
  differ between bootstraps. Logins write `directus_sessions`: ignore it when diffing rows.
- The membership unique indexes from main's `echo/docs/database_migrations.md` step 4 are left out: neither
  echo-next nor prod has them.
