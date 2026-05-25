# AGENTS.md

Context for AI coding assistants on the ECHO codebase. Only patterns and rules that aren't obvious from one read of the relevant file live here.

ECHO is an event-driven platform for collective sense-making — workshops, consultations, civic forums collect and analyze conversations.

## Maintenance Protocol

- Read this file before making changes. Fix stale links/paths immediately when you spot them
- Rely on `git log` / `git blame` for timing — no manual timestamps in this file
- Auto-correct typos and formatting without asking; escalate only on new patterns or contradictions
- Keep instructions aligned with repo reality. If something drifts, repair it
- Skip documenting secrets, temporary hacks, or anything that would rot within a sprint

When to propose an addition — primary signal is **what the user just told you**:

- User taught a convention ("we use X here", "never do Y", "the reason for Z is…") → "Add this to AGENTS.md?"
- User corrected your approach with a rule that would help another teammate → "Capture this?"
- User confirmed a non-obvious decision you were unsure about → "Worth documenting?"
- User flagged a pitfall, hidden constraint, or past incident → "Add to warnings?"

Secondary signals (look for these on top of user input, not instead of it):

- Same pattern recurring across files you already had to read for the task
- A bug fix where the root cause would surprise a reader

What **not** to add: anything a smart model can derive in ≤2 turns from `ls`, `cat package.json`, `git log`, or a single file read. Repo structure, file inventories, TODO lists, build commands, dep versions, change hotspots — leave those to the tooling.

## Stakeholder Q&A docs

Docs like `*-QUESTIONS-FOR-<NAME>.md` follow a tag-in-place convention so pending vs answered stays scannable:

- `🔴 blocking` — blocks other work
- `🟡 non-blocking` — can proceed without
- `✅ answered <date>` — resolved

New questions go to the top. Answered questions **stay in place** — don't move them to an "Answered" section at the bottom. Update the heading tag to `✅ answered <date>` and add an `**Answer:**` line near the top of the block.

## Brand & UI Copy

Follow `brand/STYLE_GUIDE.md` for all user-facing text.

- Shortest possible, highest clarity. No jargon.
- Never say "AI" — use "language model" or just describe the action ("Generating your report…" not "Generating with AI…")
- Never say "successfully" — state what happened ("Saved", not "Successfully saved")
- "dembrane" is always lowercase, even at sentence start
- Never use bold for emphasis — use Royal Blue (`#4169e1`) or italics
- Say "participants/hosts", not "users"
- Dutch translations use informal "je/jij"; keep English terms when they sound better (Dashboard, Upload, Chat)
- Italian translations use informal "tu", target A2 reading level, sentence case for titles, active voice over passive — see `brand/STYLE_GUIDE.md` for the glossary

## UI Rules

- Never stack multiple `Alert` components — pick one
- Don't use `@mantine/charts`
- Loading spinners: always pass `alwaysDembrane` on `DembraneLoadingSpinner` for whitelabel safety; never `animate-spin` on custom logos
- Show emails only on hover, never in list rows by default
- Conversations come from QR codes or audio uploads — never add "new conversation" buttons
- Prefer text buttons over icon-only buttons for important actions
- Destructive actions: `ConfirmModal` (`confirmColor="red"`), never `window.confirm`
- Single-field prompts: `InputModal`, never `window.prompt`
- Status messages: `toast.*` from `@/components/common/Toaster`, never `window.alert`

## Translations

- Lingui — `<Trans>` component or `` t` `` template literal
- Supported: en-US, nl-NL, de-DE, fr-FR, es-ES, it-IT
- Workflow: `pnpm messages:extract` → edit `.po` files → `pnpm messages:compile`

## Feature Flags

- Naming: `ENABLE_*` (backend), `VITE_ENABLE_*` (frontend)
- Backend lives in `server/dembrane/settings.py` `FeatureFlagSettings`
- Frontend lives in `frontend/src/config.ts`
- Document in `.env.example` files

## Branching & Deployment

See [docs/branching_and_releases.md](docs/branching_and_releases.md) for the full guide.

- **Feature flow**: branch off `main` → (optional) `testing` → PR to `main` → auto-deploys to Echo Next
- **Releases**: tagged from `main` every ~2 weeks → auto-deploys to production
- **Hotfixes**: branch off release tag → fix → new release → cherry-pick back into `main`
- Always check for Directus data migrations before deploying — see [docs/database_migrations.md](docs/database_migrations.md)

## Architecture

```
Frontend (React/Vite/Mantine)  →  Backend API (FastAPI)  →  Directus (headless CMS/DB)
                                       ↕                          ↕
                               Dramatiq Workers           PostgreSQL
                               (gevent + standard)
                                       ↕
                                    Redis (pub/sub, task broker, caching)
                                       ↕
                               Agent Service (LangGraph, port 8001)
```

- **Directus** is the data layer — all collections (projects, conversations, reports) live there
- **LiteLLM** routes all LLM calls with automatic failover between deployments
- **Agent service** runs separately on port 8001; agentic chat streams via `POST /api/agentic/runs/{run_id}/stream` (no Dramatiq dispatch). The runtime is reconnect-driven and lease-based in Redis

### BFF Pattern

Backend-for-frontend routes under `/bff/` aggregate data the frontend needs into one call — prefer this over having the frontend make multiple Directus SDK calls. Example: `/bff/projects/home` bundles pinned projects, paginated list, search, and admin info.

### URL-Driven State

Filters, search queries, and selected tabs live in URL search params (not React state) so state is shareable and survives refresh.

### Real-Time Progress (SSE)

Long-running progress streams via Server-Sent Events backed by Redis pub/sub (report generation, health). Don't poll for progress that has an SSE channel.

### Dramatiq & Async Rules

- **No `asyncio` in Dramatiq actors** — recurring event-loop corruption bugs led to this. Use `gevent` pools + `dramatiq.group()` instead. Report generation is fully synchronous
- `gevent.pool.Pool` is only safe on the `network` queue (uses `dramatiq-gevent`); the CPU queue runs standard dramatiq
- Use `gevent.sleep()` (not `time.sleep()`) in network-queue actors
- Restart workers after changing actor signatures — positional args are serialized
- `SkipRetryOnUnrecoverableError` middleware skips retries for `TypeError`, `SyntaxError`, `AttributeError`, `ImportError`, `NotImplementedError`
- To invoke async code from a Dramatiq actor: `run_async_in_new_loop` from `dembrane.async_helpers` — never `asyncio.run` (clashes with nested loops)
- Wrap blocking I/O in async endpoints with `run_in_thread_pool` from `dembrane.async_helpers` (Directus, service-layer, S3, token counting). Don't wrap already-async calls (e.g. `rag.aquery`)

### LLM Model Groups

Which group powers which feature is non-obvious — don't downgrade silently.

- `MULTI_MODAL_PRO` (Gemini 2.5 Pro) — chat, report generation, transcript correction. **Do not downgrade chat to Flash**
- `MULTI_MODAL_FAST` (Gemini 2.5 Flash) — suggestions, verification, stateless endpoints
- `TEXT_FAST` (Azure GPT-4.1) — being deprecated, migrating to Gemini
- Report prompt templates are written **in the target language**, not English with a "write in X" instruction
- LLM router supports failover: define primary as `LLM__<GROUP>__*` and fallbacks as `LLM__<GROUP>_1__*`, `_2__*`, etc.

### Transcription

- AssemblyAI `universal-3-pro` supports en, es, pt, fr, de, it
- Dutch (`nl`) **requires** `universal-2` fallback — `universal-3-pro` does not support it
- Production uses webhook mode (`ASSEMBLYAI_WEBHOOK_URL`); polling is only a fallback
- After raw transcription, a Gemini pass corrects, normalizes hotwords, redacts PII, and adds recording feedback
- Load S3 audio via the shared file service (`_get_audio_file_object`) — signed URLs may expire mid-request

## Directus Rules (Critical)

**Never hand-write Directus sync/snapshot JSON files.** To create or modify collections:

1. Write an idempotent Python script that uses the Directus REST API (`POST /collections`, `POST /fields`, `POST /relations`) with the admin token. Check `collection_exists()` / `field_exists()` before creating
2. Run it step-by-step to verify each change against a local Directus
3. Pull the schema: `cd directus && bash sync.sh -u http://directus:8055 -e admin@dembrane.com -p admin pull`
4. Commit the snapshot JSON under `directus/sync/snapshot/` — that is the source of truth; the one-shot migration script does not need to be committed

### Python DirectusClient

- `create_item` / `update_item` return `{"data": {...}}` — **MUST** unwrap with `["data"]`
- `get_items` / `get_item` return data directly (no wrapper)
- `get_items` requires `{"query": {filter, fields, sort, ...}}` wrapper
- `search()` silently returns `{"error": "..."}` on failure — always validate the return is a list before iterating

### TypeScript Directus SDK

- Auto-unwraps everything — no `["data"]` needed
- Type error on `<relationship>.count`? Add the type to `typesDirectus.d.ts` and use `count("<relationship>")` in fields

### File Cleanup

When clearing a file reference from a user record (avatar, whitelabel logo), delete the orphaned Directus file afterwards:

1. Fetch current file ID from the user record
2. Set the field to `None`
3. `directus.delete_file(file_id)`

See `server/dembrane/api/user_settings.py` (`remove_avatar`, `remove_whitelabel_logo`) for the reference implementation.

## Project Management

- Linear for issue tracking — tickets are `ECHO-xxx`
- Two-week cycles
- GitOps repo: `dembrane/echo-gitops` (separate repo, vendored under `echo-gitops/`)
