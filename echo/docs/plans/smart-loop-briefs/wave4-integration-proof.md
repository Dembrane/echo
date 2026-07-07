# Brief: Wave 4 - the real-stack integration proof (the story, live)

Everything is built and committed on this branch: schema, loop engine, canvas shell,
Library, proposal card, agent tools. Read the four REPORT files in this directory plus
`echo/docs/plans/smart-loop.md` (v1 acceptance in "Build phases"). Your job: prove the
story END TO END against the REAL local stack - no stubs, no fixtures - fix what breaks
(integration-scale fixes only), and document the proof.

## Environment (known-good recipe)

- Directus localhost:8055 (admin@dembrane.com/admin; static Bearer `admin`), Postgres
  5432, Redis via the `echo-host-redis` container on 6379 (start it if gone:
  `podman run -d --name echo-host-redis -p 6379:6379 docker.io/valkey/valkey:8`).
- If Directus JWTs look expired: `podman machine ssh "sudo date -s @$(date +%s)"`.
- Server: `cd echo/server && uv run uvicorn dembrane.main:app --port 8000 --loop
  asyncio` - CHECK FIRST whether port 8000 is free (`lsof -i :8000`); podman's gvproxy
  sometimes holds it. If it is held, add a minimal env override to the vite dev proxy
  target in `echo/frontend/vite.config.ts` (e.g. process.env.VITE_DEV_API_PROXY ||
  "http://localhost:8000/") - a dev-only, backward-compatible change - and run the
  server on 8123 with VITE_DEV_API_PROXY=http://localhost:8123/ for the dev server.
- Frontend: `corepack pnpm@10 run dev` in echo/frontend (takes whatever port is free).
- Login IN THE BROWSER as admin@dembrane.com/admin (real session, real cookies).
- NOTE: the tick scheduler runs via scheduled_task + Dramatiq workers, which are NOT
  running on the host. Manual refresh drives generation inline - use it. Scheduled-tick
  verification stays out of scope for this proof; note it in the report.

## The proof (Playwright, real stack, project ada57b56-d707-4be2-a1ce-25eadeaf5bad)

1. Library: open /w/{ws}/projects/{pid}/library - the real canvases from earlier waves
   list with real loop status lines.
2. Canvas page: open canvas 2 - the real latest generation renders in the locked
   iframe; version strip shows real generations; Pause -> Resume round-trips against
   the real endpoints.
3. Preview: exercise the CanvasSuggestionCard Try-it path against the REAL preview
   endpoint. Preferred: drive a real agentic chat turn that produces a proposeCanvas
   proposal (the agent service may not be running locally - if the full agent loop is
   impractical, mount the card with a hand-built proposal payload but hit the REAL
   preview + create endpoints; state clearly which variant you did).
4. Apply: create a real canvas from the card (name it "Wave 4 integration proof",
   expiry ~2h) -> "Open in Library" navigates to it -> manual Refresh now produces a
   REAL generation (gemini) that renders on-brand kit classes in the iframe.
5. Judge the generation against `echo/server/dembrane/canvas/skill.md` (fragment, kit
   classes only, honest about data, meaningful not generic) - paste the first 40 lines
   and your judgement.
6. Screenshot each step (Playwright screenshots to
   echo/docs/plans/smart-loop-briefs/wave4-shots/, committed... no: save them there but
   do NOT git-add; just reference filenames).

## Rules

- Integration-scale fixes only (wiring, proxy, shapes, small UI states). Anything
  structural: STOP and write it in the report instead of building it.
- Any file you change: run the matching gates (server: whole-tree ruff + focused
  pytest; frontend: tsc + lint + lingui if strings changed).
- No git write commands. Report -> echo/docs/plans/smart-loop-briefs/wave4-REPORT.md
  with: what rendered (DOM evidence per step), what you fixed and why, what you could
  not prove and the reason, and the generation-quality judgement.
