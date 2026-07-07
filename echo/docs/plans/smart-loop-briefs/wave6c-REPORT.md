# Wave 6c report - agentic run lifecycle bugs

Run date: 2026-07-08 Europe/Amsterdam. Branch: `sameer/smart-loop-hardening`.

## Summary

Fixed the frontend run lifecycle hardening in `echo/frontend/src/components/chat/AgenticChatPanel.tsx`.

Bug 1 root cause: the agentic composer renders the Stop control inside the same `<form>` as Send, but the Stop `Button` did not explicitly opt out of form submission. That made the control vulnerable to browser/form event semantics while a seeded setup turn was transitioning from "send" to "stop"; the only frontend caller of `/agentic/runs/{id}/stop` is `handleStop`, so the fix makes Stop a non-submit button.

Bug 2 root cause: stream attachment was only attempted from the submit/hydrate imperative paths. If that path was missed, aborted, or overwritten by a stale stream callback, the run could stay queued/running with only `user.message` persisted because the backend executes turns only when a client attaches to `POST /runs/{id}/stream`.

## Changes

- Added current-run guards around stream event and final status callbacks so an aborted old stream cannot mutate the active chat's run state.
- Added de-duplication for stream starts by run id and cursor, so repeat attachment attempts do not thrash the same active stream.
- Added a watchdog effect: whenever the current run is `queued` or `running`, no stream is active, and the stream has not fallen back to polling, the panel opens `/stream` for the current run id.
- Set the agentic Stop button to `type="button"` so it cannot submit the composer form.

## Copy review

Reviewed the canvas tooltip copy in `CanvasRoute.tsx`. I left `Pause updates` / `Resume updates` and `Ask for the latest version` unchanged because the visible button labels remain simple (`Pause`, `Resume`, `Refresh now`) and the tooltip copy does not expose cadence or internal implementation.

## Verification

- `cd echo/frontend && ./node_modules/.bin/tsc --noEmit`: passed.
- `cd echo/frontend && ./node_modules/.bin/biome lint src/components/chat/AgenticChatPanel.tsx --diagnostic-level=error`: passed.
- `cd echo/frontend && ./node_modules/.bin/biome lint . --diagnostic-level=error`: passed.
- `git diff --check`: passed.

I could not run the requested local browser walk or full local stack in this worker session. I also did not run server ruff/tests because the patch is frontend-only and the backend stream/stop contract was unchanged.

## Remaining QA

- Browser-confirm setup project creation: the seeded setup turn should create a run and attach `/stream`; there should be no `/runs/{id}/stop` request unless the user clicks Stop.
- Browser-confirm follow-up lifecycle turn after a completed canvas proposal: the follow-up run/turn should attach `/stream` for the current run id immediately after `user.message` is persisted.
