# Brief: Wave 17 - the agent keeps telling us what it should be able to do

Owner, verbatim: "it should keep telling us what new tools it should have like
being able to link to internal tabs, update the host guide like these!"

Evidence the pipeline is silent: on echo-next the `insight` collection is the
OLD analysis-run insight (project_analysis_run_id/title/summary), the agent
never writes anywhere, and `support_request` has exactly 2 rows ever. Yet
today alone hosts surfaced: "can you not change it yourself?" (canvas styling
gap), the need to navigate to internal tabs, wanting the host guide updated.
Every one of those should have become a durable row the team reads.

Branch: sameer/agent-self-insights (you are on it, off main 2d126a68). Read
echo/agent/agent.py (requestHelp flow, remember/readMemory), the Directus
rules in echo/AGENTS.md (NEVER hand-write snapshot JSON; idempotent migration
script), and directus/migrations/add_smart_loop_phase0_schema.py for the
helper style.

## Item 1: agent_insight collection (migration script)

New collection `agent_insight` via an idempotent Python migration
(directus/migrations/add_agent_insight_schema.py, same helpers/style as
phase0): uuid pk, created_at, kind (string: capability_gap | friction |
wish | praise), content (text: ONE-to-three sentences, the need in plain
words), suggested_capability (text, nullable: what tool/ability would have
served), workspace_id/project_id/chat_id/message_id (string reach-back ids,
nullable), status (string, default "new"). Run it against LOCAL Directus in
the podman stack to verify idempotency, then `bash sync.sh ... pull` and
commit the snapshot (revert _syncId shuffle noise in operations.json). Do NOT
run against echo-next; the orchestrator does that post-merge.

## Item 2: recordInsight tool + prompt (the behavior)

- Tool `recordInsight(kind, content, suggested_capability=None)` in agent.py:
  writes a row with the run's workspace/project/chat/message reach-back ids
  (mirror how support_request rows get their context). Server-side endpoint
  or direct Directus write - follow how requestHelp persists support_request
  and stay consistent.
- Prompt section "## Noticing what dembrane cannot do yet": whenever the
  agent (a) cannot fulfill a request directly, (b) resorts to a workaround,
  (c) the host expresses friction with the product, or (d) the host wishes
  for a capability, it records ONE insight in the same turn. Rules: the
  content is the host's NEED restated plainly, never transcript verbatims or
  participant content; one row per distinct need per chat (do not spam
  repeats); logging is quiet - the agent does not narrate "I logged an
  insight" on every turn, but when the host explicitly wishes for a feature
  it may say, once, "I've noted this for the dembrane team." requestHelp
  stays the loud, host-facing path for broken things and account questions;
  recordInsight is the quiet product-learning path. Both can fire on the
  same turn when appropriate.
- Add today's live examples to the prompt as few-shot guidance (canvas
  styling confusion -> capability_gap with suggested_capability; wish for
  navigating to a tab -> wish).

## Item 3: the host guide IS editable - make the agent know it

Owner: "update the host guide like these!" The project settings field
host_guide is already proposable via proposeProjectUpdate (frontend
FIELD_LABELS has host_guide). Add prompt guidance: when the host wants
participants/facilitators guided differently, offer a host_guide update
proposal (drafted in the project's language, short). Verify the update
endpoint accepts host_guide; if it does not, that finding goes in the report
and becomes an insight row example instead.

## QA

- Migration: run twice against local podman Directus (idempotent), pull
  snapshot, commit snapshot + script.
- Gates: agent uv run pytest -q (new tool + prompt assertions); server
  whole-tree ruff + focused pytest if server touched; no frontend changes
  expected (insights are team-facing, read via Directus/Slack cron).
- curl QA: create a run that hits a capability edge locally and show the
  agent_insight row created.

No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave17-REPORT.md.
