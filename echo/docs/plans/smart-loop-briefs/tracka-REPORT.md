# Track A report - loop engine

## Files

- `echo/server/dembrane/canvas/service.py`
- `echo/server/dembrane/canvas/gather.py`
- `echo/server/dembrane/canvas/ticks.py`
- `echo/server/dembrane/canvas/sanitize.py`
- `echo/server/dembrane/canvas/events.py`
- `echo/server/dembrane/api/v2/bff/canvases.py`
- `echo/server/dembrane/api/v2/__init__.py`
- `echo/server/dembrane/scheduled_tasks.py`
- `echo/server/dembrane/tasks.py`
- `echo/server/dembrane/settings.py`
- `echo/server/tests/test_canvas_sanitize.py`
- `echo/server/tests/test_canvas_gather.py`
- `echo/server/tests/test_canvas_ticks.py`
- `echo/server/tests/api/test_bff_canvases.py`
- `echo/server/tests/test_scheduled_tasks.py`

## What shipped

- Canvas service creates `project_report(kind='canvas')`, the first `canvas_config_revision`, one active `agent_loop`, and an immediate durable `scheduled_task`.
- Tick pipeline implements gather, no-op detection against the latest ok generation, one `MULTI_MODAL_FAST` model call, markdown-fence stripping, HTML sanitization, `canvas_generation` storage, `agent_loop_run` history, Redis `canvas:generation:{report_id}` nudges, failure counting, and auto-pause after 3 errors.
- Scheduling reuses `scheduled_task` with task type `canvas_tick`; the Dramatiq runner calls `run_async_in_new_loop(run_tick(...))`.
- BFF is mounted at `/api/v2/bff/canvases` and returns the Track B top-level shape: `id`, `name`, `kind`, `project_id`, `latest_generation`, `loop`.

## Caps and limits

- HTML cap: `CANVAS_MAX_HTML_BYTES`, default `240000`.
- Gather per-conversation transcript cap: `CANVAS_MAX_TRANSCRIPT_CHARS_PER_CONVERSATION`, default `6000`.
- Gather total transcript cap: `CANVAS_MAX_TOTAL_TRANSCRIPT_CHARS`, default `28000`.
- Gather window default: 60 minutes; accepted spec is `{window_minutes, tag_ids?, conversation_ids?}`.
- Manual refresh rate limit: Redis key `canvas:refresh:{canvas_id}`, `SET NX`, 30 second TTL. Hot response is `429 {"detail":"Just refreshed"}`.

## QA evidence

- `cd echo/server && uv run ruff check .`: passed.
- `cd echo/server && uv run pytest tests/test_canvas_sanitize.py tests/test_canvas_gather.py tests/test_canvas_ticks.py tests/api/test_bff_canvases.py tests/test_scheduled_tasks.py -q`: 18 passed.
- `cd echo/server && uv run pytest tests/ -q`: 1030 passed, 4 skipped, 67 failed, 2 errors. No canvas tests failed. Failures were broad pre-existing/local-environment areas: the four failures named in the brief, plus local S3/audio/big.m4a, billing/tier pricing expectations, Redis/devcontainer connectivity in invite paths, embedding config, and external transcription sample URL/API cases.

## Live curl transcript

Local setup notes:

- Directus and Postgres were reachable on localhost.
- The existing Redis container was not host-mapped, while `.env` had `REDIS_URL=redis://localhost:6379`; I started a temporary host-mapped Valkey container for live QA.
- Server command: `cd echo/server && uv run uvicorn dembrane.main:app --port 8123 --loop asyncio`.
- Project used: `ada57b56-d707-4be2-a1ce-25eadeaf5bad` (`Facilation 1`), accessible to `admin@dembrane.com`.
- LLM group used: `MULTI_MODAL_FAST`; local configured model was `vertex_ai/gemini-3.5-flash`.

```text
POST /api/v2/bff/canvases
{"id":"2","name":"Track A live canvas","kind":"canvas","project_id":"ada57b56-d707-4be2-a1ce-25eadeaf5bad","latest_generation":null,"loop":{"status":"active","expires_at":"2026-07-07T22:18:20.933Z","cadence_minutes":5}}
HTTP 200

POST /api/v2/bff/canvases/2/refresh
{"generation":"pending"}
HTTP 202

GET /api/v2/bff/canvases/2
HTTP 200
body included latest_generation.id=72d3f36c-adbd-46ef-855a-9649ea0bf466, status=ok, report_id=2, config_revision_id=a985eb49-1ff9-4833-b872-71bb782b4f72.

GET /api/v2/bff/canvases/2/generations?limit=8
HTTP 200
count=1, newest first, first.status=ok.

POST refresh twice fast after TTL
first:
{"generation":"pending"}
HTTP 202
second:
{"detail":"Just refreshed"}
HTTP 429
```

Generation HTML sample, first 30 lines:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Facilation 1 - Participant Concerns & Themes</title>
    <style>
        /* Base Reset & System Fonts */
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: #fcfcfd;
            color: #1d1d1f;
            line-height: 1.5;
            -webkit-font-smoothing: antialiased;
        }

        /* The Kit CSS implementation */
        .canvas-shell {
            max-width: 1100px;
            margin: 0 auto;
            padding: 40px 24px;
            display: flex;
            flex-direction: column;
            gap: 32px;
        }
```

## UI verification

Not completed. `echo/frontend/vite.config.ts` proxies `/api` to `http://localhost:8000/`, but port 8000 is already held by the devcontainer `gvproxy` and returns an empty reply. I left the frontend untouched per scope; the curl contract is the completed hard requirement.

## Contract deviations

None intended. The top-level `name` comes from `agent_loop.name` because `project_report` has no `name` field; the BFF still returns the exact Track B shape.

## Wave 3 notes

- Chat authoring tools should call `POST /v2/bff/canvases` with mandatory `expires_at`, `brief`, and gather spec; no schema mutation is needed.
- Try-it previews can reuse `execute_gather_spec`, `_generate_html`, and `sanitize_canvas_html`, but should avoid persisting a `canvas_generation`.
- Config edits should use `revise_config`, then run a manual tick for immediate preview/apply feedback.
- `resolve_canvas_reader_context` is the tick gate. If the acting user loses project access, ticks fail closed and increment loop failures.
