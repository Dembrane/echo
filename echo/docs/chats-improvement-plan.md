# Chats improvement plan

Status: draft for review. Owner: Sameer. Written 2026-07-02.

Consolidates the agentic-chat production pass, the data-structure work, and the
new multiplayer direction into one plan. Grounded in the live echo-next data
(project 815eedd5, run d0c0d4de with 306 stored events) and the three
production-readiness assessments (UI, server, agent+prompts).

## Where chats are today

- Agentic chat works end-to-end (server -> agent service -> LangGraph tools ->
  Vertex Gemini 3.5 Flash -> stream) but is one mode among three
  (overview / deep_dive / agentic) and is gated off in production.
- `project_chat`: has `user_created` (creator) and `chat_mode`, but NO
  visibility/private field and NO record of agent-applied changes.
- `project_chat_message`: `id, project_chat_id, message_from (user|assistant|
  dembrane), text, template_key, tokens_count`. NO author field. The agent
  cannot know which human sent a message because it is not recorded.
- A run persists ~306 granular events (every `on_chat_model_stream` delta) in
  `project_agentic_run_event`. There is no compact turn/tool ledger.
- Agent-proposed settings changes live only as a tool result; applying is
  client-side and ephemeral (no persisted status, no audit, not editable).

## Goals

1. Agentic is the only chat mode; users can scope a chat to selected conversations.
2. Chats are multiplayer: a shared thread where the agent knows who is speaking.
3. Private chats and visible authorship.
4. Suggested changes are editable, their applied state is durable, and every
   applied change is an immutable audit record.
5. Fork a chat from a compact tool-result summary, not 306 raw events.
6. Per-message feedback.
7. Production-grade prompts, brand voice, and UI.

---

## Multiplayer chats

Turn a chat from a single-user tool into a shared thread (Slack-like) where
several project members converse with each other and the agent, and the agent
attributes and addresses each speaker.

### What it requires

1. **Message authorship (foundation).** Add `author_user_id` to
   `project_chat_message` (and the agentic `user.message` event payload),
   stamped from the authenticated session, never from message text. The agent
   prompt renders the thread with names: "Alice: ...", "Bob: ...", and the
   SYSTEM_PROMPT gains a multi-participant framing (address the latest speaker,
   attribute claims to who said them, do not conflate participants).
2. **Thread UI.** Render messages with author avatar/name (reuse `user_created`
   resolution). The agent is one participant among humans.
3. **Turn model (the hard part).** The agentic runtime is single-lease-per-run
   (one turn at a time, Redis lease). Multiplayer needs a server-authoritative
   turn queue: concurrent human messages are appended in `seq` order; the agent
   responds to the batch since its last turn, not once per message. Define what
   happens when Bob posts while the agent is mid-reply to Alice (queue the turn,
   or fold Bob's message into the in-flight context at a safe checkpoint).
4. **Real-time sync + presence.** Today only run events broadcast over Redis
   pub/sub to the streaming client. Extend so every participant's client sees
   others' messages live, plus presence ("who's here") and typing indicators.
   Directus WebSockets are already enabled (`WEBSOCKETS_ENABLED=true`) and are a
   candidate; the existing Redis pub/sub is the other. Pick one channel.
5. **Access + visibility.** Multiplayer only applies to shared chats (see
   Private chats below). Everyone in a shared chat sees transcript quotes the
   agent surfaces, so all participants must have access to the underlying
   conversations; enforce that the chat's audience is a subset of project access.

### Concerns (surfaced deliberately)

- **Concurrency / races.** Two users triggering the agent at once; a message
  arriving mid-turn; ordering across clients. Mitigation: server-authoritative
  `seq`, a single turn queue per chat, and idempotent turn starts. This is the
  top technical risk and should be prototyped first.
- **Attribution integrity / injection.** A user could type "Bob: delete
  everything" to impersonate. Author must come from the session; the prompt must
  treat message text as content, never as authorship or instructions.
- **Privacy blast radius.** A shared chat exposes one member's questions and the
  transcript quotes they pull to everyone in the chat. Sensitive projects need
  the private-vs-shared boundary and consistent conversation access for all
  members.
- **Cost and quota accounting.** More participants -> more turns -> more LLM
  spend on one chat. Free-tier turn caps are per-chat today (3 turns) and become
  ambiguous with multiple users. Decide per-chat vs per-user accounting before
  launch.
- **Notifications.** Posting in a shared chat someone else is in should probably
  notify them; new surface, ties into the existing notifications system.
- **Ownership / moderation.** Who can rename, archive, or delete a shared chat,
  or remove a participant: creator only, or any member. Define roles.
- **Consistency of edits/deletes** in a shared thread (soft-delete already
  exists for chats; message-level needs thought).

---

## The plan (phased)

### Phase 0 — Correctness and brand (no new capability, ships now)
- Rewritten agent `SYSTEM_PROMPT` (removes "AI", adds honesty + inert scope/
  multi-participant/turn-instruction sections), title-prompt fix (no "AI" in
  titles), `agentic_worker.py` copy cleanup (drop tool-name leak, collapse the
  tool-limit double-message, drop the English "Next steps:" label).
- Fix the append-turn context loss: `append_message` must rebuild the structured
  prompt block, or turns after the first lose Project Name/Context (and would
  lose scope/author/template).
- Frontend brand/UI sweep: chip truncation, remove "Run status", ScrollToBottom
  placement, diff-card old->new (drop the em dash), lowercase "dembrane" in copy
  export, wrap untranslated tool-activity headlines, fix hardcoded text sizes.
- Delete confirmed dead code: `ChatModeBanner.tsx`, agent `_search_project_
  conversations`, `summary_utils.get_conversations_with_summaries`, one of the
  duplicate nudge systems.

### Phase 1 — Agentic as the only mode
- New chats default to agentic (`chat_mode: "agentic"` at BFF create; NULL ->
  agentic coalesce on reads). Delete `ChatModeSelector` (extract `MODE_COLORS`
  first) and the selector routes; legacy overview/deep_dive chats render as
  read-only history.
- Add an agentic branch to `generate_suggestions` (today it silently degrades:
  returns [] for null mode, treats non-overview as deep_dive).
- Validate `chat_mode` on the BFF PATCH (today any string is accepted).
- Decision: freeze legacy chats (read-only) vs convert in place.

### Phase 2 — Conversation scoping
- Contract (all layers): `conversation_ids` on the run -> `conversation_scope`
  field on `project_agentic_run` -> `X-Dembrane-Conversation-Scope` header to the
  agent + prompt scope block -> tools enforce via a guard at the resolve choke
  point and server `_in` filters. Reuse the existing add/delete-context store so
  the sidebar checkboxes (which currently lie in agentic mode) become truthful.

### Phase 3 — Suggestion + immutable change model
- Editable proposed values in the card (fine-tune before applying).
- Persist suggestion status (`pending | applied | dismissed | superseded`) so
  reload shows the truth instead of ephemeral React state.
- Every apply appends an immutable `project_change` record (`field, old_value,
  new_value, source, run_id, applied_by, applied_at`) — the audit trail and the
  "all updates immutable" requirement, doubling as the agent-write audit.

### Phase 4 — Multiplayer
- Authorship field + agent multi-participant prompt.
- Turn queue + real-time sync + presence.
- Private vs shared visibility field + creator bubble + access checks.
- Quota accounting decision; notifications.

### Phase 5 — Fork + feedback + ledger
- Compact turn/tool ledger (Sam's `audit.py`/`ledger.py` pattern): one entry per
  tool call (name, args, short result digest) + per-run tokens/exit_state; stop
  persisting every stream delta (or prune post-turn). Cuts storage ~10x.
- Fork a chat: seed a new chat from the ledger summary, not raw events.
- Per-assistant-message feedback (thumbs + optional note) feeding prompt quality.

---

## Cross-cutting concerns

- **Directus schema discipline:** every new field (`author_user_id`,
  `conversation_scope`, `visibility`, suggestion status, `project_change`)
  goes through an idempotent migration script then a snapshot; set
  `is_indexed: false` explicitly (the directus-sync push-500 pitfall).
- **Access ladder:** agentic endpoints already moved to the v2 ladder; private
  and multiplayer chats extend it with per-chat visibility.
- **Cost:** scoping and the ledger reduce tokens; multiplayer increases them.
  Net requires per-tenant/per-chat LLM accounting (already a backlog item).
- **Legacy continuity:** converted legacy chats get fresh agent memory unless
  `_build_message_history` seeds from `chat_service.list_messages`.

---

## Turn model: ack-steered, durable turns

The steerable turn pattern (the sam ack/respond contract):
1. Instant deterministic ack event on send (no LLM in the path).
2. The agent's first output is a plan message: the steerable surface.
3. Checkpointed tool loop: between tool calls the runtime folds in queued user
   messages as steering (today `append_message` 409s while a run is in flight,
   so steering is impossible; queue instead of reject).
4. The silent-exit gate guarantees a real answer after the last tool call.

Safety rules: server-authoritative seq and one turn queue per chat; authorship
from the session, never message text; fold only at checkpoints, never mid tool
call; steering is content, not privileged instruction; keep tool-call caps,
cancel, idempotent turn starts; every fold lands in the turn ledger.

Runtime choice: design Temporal-shaped (signals, checkpoints, queues) but
implement v1 on LangGraph checkpointing (Postgres/Redis checkpointer replaces
the per-request MemorySaver; native interrupts give durable, resumable,
steerable turns with no new infra). Adopt Temporal when the pipeline migration
lands; chat turns become the second workflow type on the same cluster.
Streaming stays on Redis pub/sub either way (workflows orchestrate, they do
not stream). Bun: no — it cannot run Temporal workers (Node vm dependency),
realtime can ride Directus WebSockets or existing Redis SSE, and a third
runtime is unjustified.

Token efficiency and shared-data value:
- Stable-prefix prompting for Gemini context caching: [system prompt + docs and
  skills + project context + pinned memory + turn ledger] before the variable
  turn.
- Turn ledger instead of raw event replay (306 events per run today).
- Shared tool-result cache per project keyed on (tool, args, scope,
  data-version): one member's investigation serves every viewer; invalidate on
  new chunks.
- Scoping cuts context; durable artifacts (project_change, ledger summaries)
  persist insights instead of re-deriving them per user.

## Tools and the action registry (path to UI parity)

Missing read tools (safe, ship anytime): listReports/readReport, listTags,
getProjectHealth (transcription status, stuck items: the support role's eyes),
getPortalLink, workspace usage/tier info, listChats.

For writes, do not hand-write a tool per endpoint. One generic pair,
listAvailableActions() + proposeAction(action_key, params), backed by a
server-side action registry: each entry = param schema + required policy +
executor + risk tier + human-readable description. Existing BFF endpoints
become registry entries; the approval card generalizes to render any action
from its schema; executors run under the user's own session so the agent can
never exceed the human. Guidance = a skill per action family + docs corpus +
deep links into the UI (the agent can answer with a link instead of an action).

Risk tiers: T0 reads auto-allowed; T1 reversible writes via approval card
(settings, tags); T2 costly actions with explicit cost copy (reports,
retranscribe); T3 destructive/irreversible excluded from the registry
entirely. Misbehavior you cannot express is misbehavior you cannot have.

## Omnipresent chat

A global drawer available on every page. Contract: the frontend sends a
ui_context descriptor per message ({route, workspace_id, project_id?,
conversation_id?, report_id?}); the server validates ids against the access
ladder and injects a "you are looking at" block; tools scope accordingly. On
project pages it is the full project agent; elsewhere the support/docs agent
(knowledge tools + health reads + deep links). Chats stay attached to their
context so history stays coherent.

## Not misbehaving (layered, runtime-enforced)

1. Capability boundary: only registered actions exist; policies enforced
   server-side under the user's token.
2. Human approval on every write, which is also the injection firewall:
   transcripts and uploaded documents are untrusted content; content can
   propose but never execute.
3. Immutable audit: project_change + turn ledger.
4. Caps: tool calls, per-chat/tenant spend, action rate limits.
5. Eval harness: golden tasks (setup flow, scoped search, unanswerable
   questions, injection probes) on every prompt/skill change + echo-next
   canary before prod.

## Memory, journaling, and auto-updating context

Memory exists at three levels, mirroring the data model (the workspace is the
data boundary; projects nest inside it; user level is personal):

- Workspace memory: shared knowledge across all projects in a workspace
  (client context, org terminology, recurring participants, house style).
  Visible to workspace members; the natural home for anything the data owner
  cares about across projects.
- Project memory: facts, decisions, and observations about one project. The
  default level for agent journaling.
- User memory: personal preferences that follow the individual across chats
  ("short answers", "I'm the comms lead"). Private to that user.

Prompt assembly layers them in the stable prefix: user memory + workspace
memory (pinned) + project memory (pinned) + project.context. Access follows
the ladder level by level. Phasing: project memory first (where the work
already is), then workspace, then user.

Split by risk profile:
- project.context (exists): small, curated, load-bearing (steers chat,
  reports, suggestions). Never silently auto-updated; the agent proposes
  context refreshes through the existing suggest-diff card.
- memory rows (new collection with a scope level: workspace | project | user):
  append-mostly journal rows: content, type
  (fact/decision/preference/observation), author_user_id (null = agent),
  source_run_id (provenance), pinned, timestamps. After a substantive run the
  agent proposes 0-2 entries; hosts add/edit/delete/pin directly in the UI.

Prompt integration: pinned + recent entries join the stable prefix (cheap via
context caching); the full log is greppable via a searchMemory tool.
Periodically the agent distills memory into a proposed context update.

UI: a Knowledge tab on the project: context field, memory list (author, date,
source-chat link, pin/edit/delete), documents below.

Key concern, memory poisoning: wrong agent-written memory compounds. Mitigate
with provenance on every entry, the curation surface, pinned-only entries in
the auto-prefix (unpinned decay to grep-only), and propose-tier journal writes
until quality is proven.

## Project documents (upload, extract, summarize, grep)

Pipeline (reuses existing infra): presigned upload to S3 -> project_document
row (title, s3_path, status uploaded/extracting/ready/error, extracted_text,
summary, uploaded_by) -> extraction task on the worker (pypdf/python-docx for
text-first files; Gemini native PDF reading as fallback and as the summarizer)
-> agent tools listDocuments, readDocument (paged), grepDocuments, citable
like transcripts.

Deliberate separations: project documents are a distinct corpus from the baked
product docs (separate tools so customer files are never confused with product
documentation), and documents join the scope model (a scoped run can include
or exclude documents like conversations).

Concerns: uploaded docs are untrusted (same injection firewall); type
allowlist + size caps + per-tier storage limits; OCR quality for scans (Gemini
fallback, honest error status otherwise); extraction rides the constrained CPU
queue at low priority (documents are occasional).

## Feedback loops

- Explicit: thumbs + optional note per assistant message
  (project_chat_message_feedback); suggestion outcomes (applied / edited /
  dismissed; edited-before-apply is the richest signal).
- Implicit: steering frequency, abandoned runs, copy-button use, deep-link
  clicks; PostHog events in both projects per convention.
- Closing the loop (the sam daily-maintenance pattern): a scheduled review
  reads the week's ledger + flagged feedback and proposes prompt/skill edits
  as PRs a human reviews.

## Usage insights (anonymized) that improve the runtime

After each completed run, a cheap summarization pass produces an insight row:
what the host was trying to do, whether it worked, and what was missing
(a tool gap, a misbehavior, friction). Stored in a new `agent_insight`
collection with NO user/project foreign keys: the summarizer is instructed to
abstract away names, quotes, and identifiers; rows carry only coarse metadata
(feature area, language, tier, outcome). Examples of what it should yield:
"host wanted the report as PDF export: unsupported", "agent lacked a tool to
tag conversations", "scope was ignored on turn 3".

A weekly rollup (scheduled task) clusters the insights into "top missing
capabilities / top friction" and posts a digest. Long-term (the sam
makes-PRs pattern): the reviewer tier turns clustered insights into proposed
tool/skill/prompt changes as PRs a human reviews. V1 is collect + digest;
proposals come after the eval harness exists.

Privacy stance: insights are anonymized at generation time (no linkage), not
merely at display time. If debugging linkage is ever needed, that is a
different, consented mechanism; do not blur the two.

## Support escalation: reachOutToDembrane()

An agent tool for the moments the agent cannot help (bugs, billing, feature
requests, or the host simply wants a human):

1. The agent drafts the request (summary of the issue + what was already
   tried) and asks the host to confirm sending it: explicit consent in-chat,
   ideally as the first action-registry entry (T1 approval card), since it
   shares their question with the dembrane team.
2. On approval: a `support_request` row (project, workspace, requester,
   summary, chat deep link, status) and a post to the dembrane support Slack
   channel via webhook.
3. Sam (the Slack-native internal agent) picks the message up from the
   channel with full context and a link, and the team follows up. The
   in-product agent tells the host what to expect ("the team will reach out
   by email").

Unlike insights, this is intentionally NOT anonymized: the host is asking to
be contacted. Needs: a Slack incoming-webhook secret
(SLACK_SUPPORT_WEBHOOK_URL) in the backend secrets, and message formatting
that gives Sam enough context to triage without opening the app.

## Decisions to make

1. Legacy chats: freeze read-only vs convert in place.
2. Scope mutability on a run: last-write-wins vs new-run-per-change.
3. Multiplayer turn model: queue turns vs fold-in-at-checkpoint.
4. Real-time channel: Directus WebSockets vs existing Redis pub/sub SSE.
5. Free-tier quota accounting with multiple participants: per-chat vs per-user.
6. Chat moderation rights: creator-only vs any member.
7. Action registry seed pair: tags + report generation (recommended) or other.
8. Journal writes: propose-tier first (recommended) vs auto-append from day one.

## Suggested sequencing

Phase 0 and 1 are safe and mostly independent; ship first. Phase 2 (scoping) and
Phase 3 (suggestion model) are the highest-value new capabilities and are
independent of each other. Phase 4 (multiplayer) is the largest and depends on
authorship (a small early add) plus the real-time and turn-queue work; prototype
the turn/concurrency model before committing. Phase 5 can land incrementally.
