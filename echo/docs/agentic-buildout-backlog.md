# Agentic chat + monitoring build-out: backlog and design notes

This is the running backlog for the agentic-chat and host-monitoring work. It
doubles as the design record for the open questions raised during the build.

Linear note: no Linear API key was available in the session that produced this,
so issues could not be filed directly. This document is the backlog; port each
item to Linear when the key is available.

## What shipped in this PR (for context)

- Chat UX polish: impersonal empty state, click-to-edit title, redesigned
  composer, message-preservation on failed send.
- Schema foundation: `project_chat.is_private`, `support_request`,
  `usage_insight`, `agent_memory`.
- Read previous chats (`listProjectChats` + `readChat`), host-scoped, private-aware.
- Reach out to the dembrane team (`reachOutToDembrane` -> `support_request` outbox).
- Idle-sweep capture of anonymized usage insights (`usage_insight`).
- Host-facing live conversation monitoring + error visibility.

## Backlog

### Memory (agent-side + UI)
Status: schema shipped (`agent_memory`); code not shipped (the implementation
subagent died mid-run and its partial was reverted to avoid dead code).

- **Agent-side read/write tools + endpoints.** `GET/POST /agentic/projects/{id}/memory`,
  `EchoClient.list_memory/write_memory`, and `readMemory` / `remember(scope, content, memory_key)`
  tools. Read spans user + workspace + project scope; writes upsert on
  `memory_key`. Rule: content is generic/non-PII except at `user` scope. Writes
  are surfaced as ordinary tool calls. Reason deferred: needs a clean rebuild.
- **UI exposure of memories (multi-surface).** User preferences at user settings,
  workspace preferences at a workspace-context surface, project memory alongside
  the existing project context. Host-visible and host-editable. Reason deferred:
  multi-surface frontend work that needs its own design pass; the agent-side
  store is the prerequisite.
- **Workspace-context surface.** Workspaces have no `context` field today. Decide:
  add `workspace.context` (schema) vs. use `agent_memory` scope=workspace as the
  store behind a workspace-context UI. Reason deferred: product/schema decision.
- **Nano-model summarization of tool-call activity.** Summarize each tool call
  with a very small model for the chat's activity view ("read a memory", "updated
  the project context"). Reason deferred: needs a nano-model choice and a
  summarization layer; the activity view already collapses/labels tool calls, so
  this is an enhancement, not a blocker.

### Scheduling / crons (design answer + backlog)
The question was: how do we dynamically register crons, and can a project set up
its own schedule?

- **Two mechanisms already exist.** (1) `scheduler.py` (APScheduler,
  `BlockingScheduler` + `CronTrigger`) is **static**: jobs are declared in code and
  `.send()` dramatiq actors. Good for fixed system jobs (the insight sweep was
  added here). (2) `scheduled_tasks.py` + `task_process_scheduled_tasks` (runs
  every minute) is a **durable, DB-backed queue** of "run task X at time T" rows.
- **Recommendation for per-project / dynamic schedules: reuse `scheduled_task`,
  not new APScheduler jobs.** A project wanting a recurring action (e.g. a
  scheduled report) enqueues a `scheduled_task` row; a recurring one re-enqueues
  its next occurrence on completion. APScheduler stays for a small fixed set of
  system sweeps. Do **not** store crons in `agent_memory` — schedules are
  operational state, not memory.
- **Cronitor (as used in Sam).** External cron-liveness monitoring. Add heartbeat
  pings around the `scheduler.py` jobs so a dead scheduler is detected. Reason
  deferred: ops/observability; wire once the scheduler set stabilizes.
- **Project-authored schedules UI.** Let a host schedule a recurring report/action
  from inside a project. Reason deferred: needs the `scheduled_task` recurring
  abstraction above plus UI.

### Insights export (owner's side)
The `usage_insight` and `support_request` rows are written; the **export job**
that reads them and forwards to Slack is intended to be a separate Sam cron
(owner to build). Also: add Cronitor monitoring for the new insight-sweep job.

### Monitoring: intended liveness model (design)
This is **not an infra problem**; it is aggregation and math over signals we
already collect.

- When a session starts, a channel opens between the server and the participant.
  The participant sends a **ping every ~5s** (this piece exists). That ping is the
  primary "still here" signal.
- The host dashboard's MONITOR should decide whether a conversation is live by
  **aggregating multiple signals**, not one: the 5s ping, transcription activity,
  audio upload (chunk arrival), echo/verify events, and the **finish button**
  (finish means the participant definitively ended, so: not live).
- **What shipped is a first proxy:** `is_live` currently keys off recent
  `conversation_chunk` arrival (audio upload) within 45s. That is one of the
  signals above and a reasonable v1, but the richer model should fold in the 5s
  ping (primary), transcription progress, echo/verify, and treat the finish
  button as a definitive "ended" state. Follow-up: locate where the participant
  5s ping is persisted (the monitor build found the server->client SSE keep-alive,
  which is a different, connection-level ping) and incorporate it.

### Monitoring: mobile + notifications (direction)
- Make the monitor page **mobile-friendly** so a host can walk the room. The
  sidebar is already collapsible (next release), so the app is mostly there.
- Prefer **web push notifications + haptics** for "a conversation stopped / is
  failing" alerts. **SMS delivery is unreliable**, so do not lean on it.

### Monitoring follow-ups
- **Error badges inside the existing conversation-list rows.** The list endpoint
  (`useInfiniteConversationsByProjectId`) carries no chunk-error field; surfacing
  it there needs a join of chunk error state into the list query. Deferred:
  larger than the monitor section already shipped.
- **Upload (non-portal) error visibility.** The live monitor filters to portal
  sources by design. Surfacing upload/transcription failures is a separate
  surface. Deferred.

### reach_out_to_dembrane: capture the chat
Only `project_id` reaches the agent service (route `/copilotkit/{project_id}`),
so a `support_request` cannot yet be linked to the exact `project_chat`.
Threading `chat_id` from the server run context through to the agent service is a
cross-service change. Deferred.

### GPS / proximity for conversations
The owner flagged GPS/proximity as "great, but let's start with [monitoring]".
Explicitly deferred by the owner.
