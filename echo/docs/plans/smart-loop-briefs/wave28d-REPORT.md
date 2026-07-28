# Wave 28d Report: Lens, Host Guide, Honest Backfill

## Summary

Implemented Wave 28d for the living canvas loop:

- Connected the canvas report name and current brief to extraction prompts, including the explicit purpose/lens instruction and acceptance of zero quotes for off-topic conversations.
- Added `Host guide` as the fourth fixed v1 tab after Story, persisted as `agent_loop.canvas_host_guide`, rendered from server ledger HTML, and replaced on each tick.
- Made cold-start backfill honest and resilient by splitting long conversations into about 20k-character extraction windows and recording per-conversation/window outcomes in generation and run detail.

## Changes

### Lens in extraction

- `_extract_living_canvas_update` now receives `report_name` and `brief`.
- Extraction payload includes:
  - report name,
  - current brief,
  - the exact purpose instruction that unrelated conversations may correctly return zero quotes,
  - the guardrail against pre-populating static snippets from the brief.
- Canvas preview now passes the same lens context.

### Host guide tab

- `CANVAS_TAB_SET_V1` is now fixed as:
  - `crux`
  - `concept_cloud`
  - `story`
  - `host_guide`
- Added `canvas_host_guide` to fresh state, state patches, service reads, and the Wave 28 migration script.
- Added a host-guide model prompt grounded only in:
  - brief,
  - current ledger summary,
  - quote attribution counts,
  - recent run activity.
- Host guide shape:
  - `where_the_room_is`
  - `what_to_ask_next`
  - `under_heard`
  - `updated_at`
- Rendering omits the under-heard block when no under-heard entries are present.

### Honest backfill

- Cold-start backfill now processes each conversation independently.
- Long conversations are windowed into bounded extraction calls using `CANVAS_TRANSCRIPT_WINDOW_CHARS = 20_000`.
- Model extraction errors are recorded per conversation/window and do not abort remaining conversations.
- Generation/run detail now includes examples like:
  - `backfill: 2 conversations`
  - `backfill conv conv-1: 1 accepted / 0 rejected`
  - `backfill conv conv-lon window 1: 1 accepted / 0 rejected`
  - `backfill conv conv-fai: model error: context length`
- The Wave 28c missing-marker gap was that `backfill: N conversations` was only assembled after a successful all-or-nothing extraction merge; an extraction exception exited before ledger detail existed.

## Tests

Passed with local dummy env values from `server/.env.sample`:

```bash
cd echo/server
uv run ruff check .
```

Result: `All checks passed!`

```bash
cd echo/server
uv run pytest -q tests/test_canvas_*.py tests/api/test_bff_canvases.py
```

Result: `46 passed, 2 warnings`.

## Notes

- `echo/agent` was not touched, so the agent pytest gate was not run.
- Directus snapshot JSON was not hand-edited. The idempotent Wave 28 migration script now ensures `canvas_host_guide`.
