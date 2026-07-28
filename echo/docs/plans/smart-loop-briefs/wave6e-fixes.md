# Brief: Wave 6e - three verified failures from the post-deploy check

Read wave6d-REPORT.md (the evidence) and wave6c-REPORT.md (the previous attempt).
Three fixes, each with hard evidence. Branch: sameer/smart-loop-hardening.

## A (HIGH): the seeded setup run STILL gets stopped - find the real caller

wave6d network capture for run f37a72af-6a5b-404b-a766-dd7d706958dd: stream attach
(after_seq=0), re-attach (after_seq=1), then TWO POST /stop calls with NO user click ->
AGENT_CANCELLED. The 6c fix (Stop type=button) was not the cause or not the only cause.

- Hunt EVERY path that can reach stopAgenticRun in the frontend: direct calls, effect
  cleanups, chatId-change effects, unmount handlers, the watchdog added in 6c (could it
  or its guards call stop?), and anything that "cleans up" a previous run when state
  changes. Two stops suggests a mount/remount sequence during the create->navigate
  flow (possible locale-prefix redirect or layout remount) where each instance stops
  the run it thinks is stale.
- DESIGN RULE to enforce: the runtime is reconnect-driven - abandoning a stream is
  SAFE and the run resumes on reattach. The frontend must NEVER stop a run except an
  explicit user action on the Stop control. Delete/disable any programmatic stop.
- Reproduce locally (full local stack, wave-4 proxy env vars, echo-host-redis): create
  a project via the wizard, watch the network tab - prove the stop calls are gone and
  the stream stays attached. This reproduction is REQUIRED this time; wave 6c shipped
  without it and the bug survived.

## B (HIGH): scheduled ticks crash with a cancel-scope error in the worker

Evidence (echo-next, canvas_generation): status=error, detail "Attempted to exit
cancel scope in a different task than it was entered in", tick_kind=scheduled, empty
content_html. Manual refresh (inline in the API process) works; scheduled ticks (Dramatiq
worker via run_async_in_new_loop) intermittently crash.

- Root cause class: async clients/objects shared across event loops. This codebase
  already solved this once - the shared-background-loop fix (grep dembrane/async_helpers
  and its callers; see how summaries/merge tasks run async work on ONE persistent
  background loop instead of new loops with shared clients).
- Fix the tick execution path to either (a) run on the established shared background
  loop pattern, or (b) construct fresh client instances per tick (no module-level
  async_directus/httpx/litellm client reuse across loops). Prefer (a) for consistency.
- Also make the tick record the error detail on the agent_loop_run row (wave6d found
  error generations but agent_loop_run rows were missing/not queryable for it - ensure
  every tick writes its run row even on crash).
- Reproduce locally: run a REAL network-queue Dramatiq worker on the host
  (`cd echo/server && uv run dramatiq ...` - find the exact entrypoint in the repo/
  devcontainer config) with the local stack; create a canvas with cadence 2; watch a
  scheduled tick produce a real generation without the cancel-scope error. REQUIRED.

## C (MEDIUM): "Pause the wall." answers but does not pause

wave6d beat 5: composer returns to idle (6c watchdog works) and the agent replies, but
the loop stays active. Determine what the agent actually did: pull the run's events from
echo-next (GET /agentic run events via api.echo-next with a Directus admin token - find
the run for the 'Pause the wall.' turn in chat on project
ed606b2f-8d84-45b5-9e6a-efb51e9cb7b6, canvas 5) - did it call pauseCanvasLoop? With what
canvas_id? What did the tool return?
- Likely causes: the model answered without calling the tool, or could not resolve
  "the wall" to a canvas id (does the prompt tell it to listCanvases first?), or the
  tool errored silently. Fix accordingly (prompt nudge: resolve the canvas via
  listCanvases before lifecycle calls + confirm by name; or tool accepts a name and
  resolves server-side - pick the more robust one and say why).
- Add an agent test for the chosen behavior.

## D (LOW): methodology create/edit modal was un-automatable

wave6d could not script the create/edit flow (focus/field losses). Review the modal:
proper labels/testIds on every field, no focus traps, stable ids. Add testIds per house
convention so the flow is verifiable.

QA: gates for everything touched (server whole-tree ruff + tests incl. a new tick-loop
test; frontend tsc/lint/lingui; agent pytest). The two REQUIRED local reproductions
(A: no stop calls in the create flow network log; B: a worker-driven scheduled tick
succeeding) must be described with evidence in the report. No git write commands.
Report -> echo/docs/plans/smart-loop-briefs/wave6e-REPORT.md.
