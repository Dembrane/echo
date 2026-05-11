# CLAUDE.md

Rules and conventions for working on the ECHO codebase. Follow these precisely.

## Directus Rules (Critical)

**Never hand-write Directus sync/snapshot JSON files.** To create or modify Directus collections:

1. Write a Python script (e.g., `scripts/create_schema.py`) that uses the Directus REST API (`POST /collections`, `POST /fields`, `POST /relations`) with the admin token
2. Make scripts idempotent (check `collection_exists()` / `field_exists()` before creating)
3. Run the script step-by-step to verify each change
4. After all changes, pull the schema: `cd directus && bash sync.sh -u http://directus:8055 -e admin@dembrane.com -p admin pull`
5. Commit the sync output (the JSON files in `directus/sync/snapshot/`)

See `scripts/create_schema.py` for the established pattern (Session 2 workspaces schema).

### Python DirectusClient

- `create_item` / `update_item` return `{"data": {...}}` — **MUST** unwrap with `["data"]`
- `get_items` / `get_item` return data directly (no wrapper)
- `get_items` requires `{"query": {filter, fields, sort, ...}}` wrapper
- `search()` silently returns `{"error": "..."}` on failure — always validate return is a list before iterating

```python
# CORRECT
new = client.create_item("collection", {...})["data"]
items = client.get_items("collection", {"query": {"filter": {...}}})
if not isinstance(items, list):
    items = []

# WRONG — missing ["data"] unwrap
new = client.create_item("collection", {...})
# WRONG — missing "query" wrapper
items = client.get_items("collection", {"filter": {...}})
```

### TypeScript Directus SDK

- Auto-unwraps everything — no `["data"]` needed
- If there's a type error with `<relationship>.count`, add it to `typesDirectus.d.ts` and use `count("<relationship>")` in fields

See `memory/directus-rules.md` for comprehensive patterns.

## Brand & UI Copy

Follow `brand/STYLE_GUIDE.md` for all user-facing text:

- **Never say "AI"** — use "language model" or just describe the action ("Generating your report..." not "Generating report with AI...")
- **Never say "successfully"** — just state what happened ("Saved" not "Successfully saved")
- **"dembrane" always lowercase**, even at sentence start
- **Never use bold for emphasis** — use Royal Blue (#4169e1) or italics
- Say "participants/hosts" not "users"
- Dutch translations: use informal "je/jij" form, keep English terms when they sound better (Dashboard, Upload, Chat)

## UI Rules

- **Never stack multiple Alert components** — show either the error alert or the info alert, not both
- **Don't use `@mantine/charts`** — use better charting libraries
- **Loading spinners**: always use `alwaysDembrane` prop on `DembraneLoadingSpinner` for whitelabel safety; never `animate-spin` on custom logos
- **Show emails only on hover** — don't display them by default in lists
- **Conversations come from QR codes or uploads** — never add "new conversation" buttons in the UI
- **Prefer text buttons over icon-only buttons** for important actions (e.g., "Go full screen" should be a text button)

## Architecture Preferences

- **BFF pattern**: move frontend Directus SDK calls to backend `/bff/` routes. Frontend should call aggregated API endpoints, not make multiple Directus queries
- **URL-driven state**: use URL search params (not React state) so state is shareable and persistent
- **SSE for progress**: use Server-Sent Events + Redis pub/sub for real-time progress (report generation, health streams)
- **No asyncio in Dramatiq actors**: use gevent pools + dramatiq groups instead. Report generation is fully synchronous
- **gevent.pool.Pool only in `network` queue** (uses `dramatiq-gevent`). CPU queue runs standard dramatiq
- **Use `gevent.sleep()` not `time.sleep()`** in network-queue actors

## LLM Model Groups

- `MULTI_MODAL_PRO` (Gemini 2.5 Pro) — chat, report generation, transcript correction. **Do not downgrade chat to Flash.**
- `MULTI_MODAL_FAST` (Gemini 2.5 Flash) — suggestions, verification, stateless endpoints, lightweight tasks
- `TEXT_FAST` (Azure GPT-4.1) — being deprecated, migrating to Gemini
- Report prompt templates are written IN the target language (not just instructing the LLM to write in that language)

## Translations

```bash
cd frontend
pnpm messages:extract    # Extract new strings to .po files
# Edit .po files in src/locales/ (en-US, nl-NL, de-DE, fr-FR, es-ES, it-IT)
pnpm messages:compile    # Compile for production
```

Use `<Trans>` component or `` t` `` template literal from Lingui.

## Branching Strategy & Deployment

See [docs/branching_and_releases.md](docs/branching_and_releases.md) for the full guide.

Quick reference:
- **Feature flow**: branch off `main` → (optional) merge to `testing` for testing → PR to `main` → auto-deploys to Echo Next
- **Releases**: tagged from `main` every ~2 weeks → auto-deploys to production
- **Hotfixes**: branch off release tag → fix → new release → cherry-pick into main
- Always check for Directus data migrations before deploying (see `docs/database_migrations.md`)

## Transcription

- AssemblyAI `universal-3-pro` supports: en, es, pt, fr, de, it
- Dutch ("nl") requires `universal-2` fallback — `universal-3-pro` does NOT support it
- Production uses webhook mode (`ASSEMBLYAI_WEBHOOK_URL`), polling is only a fallback

## Dramatiq Tasks

- Restart workers after changing task signatures (positional args are serialized)
- `SkipRetryOnUnrecoverableError` middleware skips retries for TypeError, SyntaxError, AttributeError, ImportError, NotImplementedError
- When invoking async code from Dramatiq actors, use `run_async_in_new_loop` from `dembrane.async_helpers`

## Project Management

- Linear for issue tracking — tickets are `ECHO-xxx`
- Two-week cycles/sprints
- GitOps repo: `dembrane/echo-gitops` (separate repo)
