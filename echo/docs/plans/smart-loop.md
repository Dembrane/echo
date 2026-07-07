# SMART loop - architecture plan and decision record

Anchor user story: `docs/building/smart-loop.md` (the "live panel wall"). The story is the
acceptance test; this doc records the architecture choices behind it, the risks, and the
build sequence. Decisions marked **[OWNER]** need Sameer's sign-off before build; the rest
are recommendations that can be overturned in review.

Status legend: PROPOSED -> AGREED -> BUILT.

## D1. Headless run executor - PROPOSED

The agentic runtime is reconnect-driven: a turn executes only while a client is attached to
`POST /api/agentic/runs/{id}/stream`. Loops need turns with no browser.

- Option a: drive turns from a Dramatiq actor. Conflicts with the no-asyncio-in-actors rule;
  the runtime is deeply async.
- Option b (RECOMMENDED): an internal, agent-token-gated endpoint
  `POST /api/agentic/runs/{id}/drive` that starts the same asyncio `_runner` used by the
  stream path, in the API process, without a client attached. Events persist to
  `project_agentic_run_event` as today; a host opening the chat later replays history
  exactly like a reconnect. The existing turn lease already makes double-driving safe
  across replicas; a dead replica's lease expires and the loop's next tick retries.
- Risk: long runs occupy the API replica's event loop budget. Mitigate with per-run step
  caps (exists) and loop-level budget caps (D4). If loop volume grows, the same endpoint
  can move to a dedicated deployment of the API image without design change.

## D2. Sandbox runtime - PROPOSED [OWNER]

The agent writes Python that builds artifact HTML. Where does it run?

- Option a: subprocess inside the agent container. Cheapest; weakest isolation (shares the
  agent's filesystem, env, and network identity - the agent token lives there).
- Option b (RECOMMENDED): a small dedicated sandbox service in-cluster (own image, own
  deployment). Executes one script per request in a fresh workdir subprocess with rlimits
  (CPU seconds, memory, wall clock, output size), non-root, no persistent disk.
  Kubernetes NetworkPolicy: egress ONLY to the API service. No other network. The agent
  calls it over HTTP with {script, artifact context, scoped token}.
- Option c: microVM isolation (gVisor/Firecracker or a hosted sandbox). Strongest; heavy
  operationally; revisit if/when we execute user-supplied (not agent-supplied) code.
- Risk posture for (b): a sandbox escape lands in a pod whose only egress is the API called
  with a token no stronger than the user's browser session (D3). Container escape to the
  node is out of scope at this tier - accepted until we host third-party code.

## D3. Sandbox credentials: scoped, short-lived, read-mostly - PROPOSED [OWNER]

"The user's access" must not mean "the user's session token".

- Mint a short-TTL (minutes) token server-side per run, carrying
  {directus_user_id, project_id, scopes, exp}, validated in `dependency_auth` alongside the
  existing JWT path.
- Scopes: READ endpoints the user could read anyway, plus artifact-version WRITE for the one
  artifact the run is building. Explicitly NO destructive routes (delete conversation,
  settings writes, member management) regardless of the user's real role.
- Why: transcripts are untrusted input; they influence the code the agent writes (prompt
  injection). With a read+artifact-write token, the worst injected script can do is read
  what the host can read and write a bad artifact version - visible, versioned, revertible.
- Risk: a second auth path to maintain. Keep issuance + validation in one module; log every
  mint with run id.

## D4. Loop object model - PROPOSED

New collection `agent_loop`: project_id, name, recipe (instruction text), interval_minutes,
expires_at (REQUIRED - the agent always sets one and states it), status
(active|paused|expired|stopped), created_from_chat_id, chat_id (the loop's dedicated
thread), artifact_id, caps (max steps/run), failure_count. Plus `agent_loop_run` linking to
`project_agentic_run` for history.

- Scheduling: reuse the durable `scheduled_task` queue (processor ticks every minute); a
  completed run enqueues the next occurrence; expiry check on every tick. NO new APScheduler
  jobs (backlog decision stands).
- Guardrails: mandatory expiry; auto-pause after 3 consecutive failures; honest no-op runs
  ("nothing new" skips the rebuild but records the run); all lifecycle changes narrated in
  the loop's chat thread.
- Chat lifecycle tools: proposeLoop (renders a proposal card - hosts apply, the agent never
  self-starts a loop), listLoops, pauseLoop, resumeLoop, stopLoop, updateLoop (cadence
  changes also via proposal).

## D5. Artifacts on the report primitives, versions first-class - PROPOSED [OWNER]

- Reuse `project_report` machinery (sidebar, publish, PDF where applicable) rather than a
  parallel system: add kind ('report' | 'artifact'), source ('host' | 'loop' | 'chat'), and
  optional source_conversation_id.
- Versions: append-only `artifact_version` rows (content, created_by_run_id, note). Every
  regeneration and every chat edit is a new version; nothing is overwritten; the UI gets a
  version timeline ("scrub through the day"). The report body points at the current
  version.
- Feedback-by-chat: an artifact links to a chat scoped to it; agent tools
  readArtifact/proposeArtifactChange write new versions. First-use coaching line in the
  artifact chat. This flow gets its own docs page (the assistant cites it when teaching).
- Naming [OWNER]: the sidebar surface collides with the existing Library (views/aspects).
  Options: absorb, rename new surface ("Artifacts"), or rename old. Not blocking phase 1
  (artifacts can sit in the Reports sidebar initially, which the story already leans on).

## D6. Generated HTML safety - PROPOSED

Artifact HTML is model-generated from untrusted transcripts and may be published to a
public URL.

- Sanitize server-side on version write (allowlist tags/attrs, strip scripts/handlers/
  external loads), serve published artifacts with a strict CSP, render in-dashboard inside a
  sandboxed iframe. Publishing stays an explicit host action (reused from reports).
- Store artifacts as structured blocks + rendered HTML from day one, so the later widget UI
  (draggable/pinnable primitives) is a renderer swap, not content regeneration.

## D7. Insight enrichment + reach-back - PROPOSED

- Thread chat identity server->agent: pass chat_id + triggering message_id + app_user_id in
  the run context (closes the deferred reach-out linkage). `usage_insight` and
  `support_request` gain those columns.
- Consent-first, always: the agent ASKS before informing the team ("Would you like to let
  the dembrane team know...?") - for feature gaps AND for the pre-event heads-up from the
  setup interview. Never silent. Phrasing lives in the interview skill.
- Reach-back channel: a staff/system-authored message type appended into the original chat
  ("Theme images shipped"). Small new primitive; needs its own visual treatment so it's
  clearly from the team, not the assistant.

## D8. Interview skill (one muscle, two uses) - PROPOSED

An agent skill (existing echo/agent/skills + readSkill mechanism) used for (a) goal-setting
at project creation ("Help me figure it out" template) and (b) feature-gap capture.
Convergent options (2-4 concrete choices per question), <=5 questions, confirm-understanding
close, always escapable. Output: goal revision proposal (a) or detailed insight (b) with
requirement, job-to-be-done, accepted workaround, verbatim quotes, reach-back ids.

## D9. Goal = versioned context, an instance of the methodology - PROPOSED

`project_goal_revision` (or generalise to context revisions): content, set_by (host-edit |
interview | loop), created_at, chat_id. Current goal = latest revision; empty -> default
report prompt unchanged. Goal feeds report/artifact prompts. Meta-goal behavior in the
system prompt: when no goal exists, gently offer the interview.

Relationship to D11: the METHODOLOGY is the template (how projects like this are run); the
GOAL is this project's instance of it. The default dembrane methodology's opening move IS
the meta-goal interview.

## D11. Methodology - the reusable way-of-working - PROPOSED [OWNER]

The transferable layer above goal: a named, versioned playbook for how a kind of project is
run (setup interview shape, goal template, loop recipes, artifact/report structures,
rationale). Long-term this is the platform's compounding asset: hosts refine their own,
partners publish theirs, evidence (projects/artifacts) attaches to versions.

- Object model: `methodology` (name, description, user-facing framing "what this does for
  your project", owner, visibility private|workspace|public) + `methodology_version`
  (content blocks, created_by, note, evidence links later). `project.methodology_version_id`
  selects one; DEFAULT = seeded "dembrane" methodology v1 (= the meta-goal interview).
- Project creation opens directly into the setup chat (the selected methodology's opening
  move), with explicit escape hatches: skip, come back in any chat, or read the docs. The
  creation flow itself routes to the chat - this is a frontend flow change, not just prompt.
- Extraction skill ("extract methodology"): after an artifact/report lands, the agent
  reviews the decisions + rationale in the chats and proposes a methodology (or a new
  version of the one in use) via the proposal-card pattern. Everything host-editable. The
  agent SUGGESTS extraction when it notices repetition ("you're doing this again - want to
  extract it?") - a nudge, never automatic.
- Methodology explorer (browse/select, user-facing framing, versions) and
  publishing/evidence: LATER phases - explicitly out of MVP.
- MVP scope (v1): schema + seeded default + project-creation-as-chat + selection at
  creation + the extraction suggestion writing a draft methodology. No explorer UI, no
  publishing, no partner surface yet.
- Docs: a methodology page under docs/building (what one is, why use one) so the assistant
  can explain and suggest it.

## D10. Docs lead the build - AGREED (process)

Each feature in this plan gets a human-readable story page under `docs/building/` BEFORE
build (the assistant grounds "that's being built" answers in them), and graduates into
`features/` + dembrane-next table on ship, via the code-to-docs process.

## Build phases (parallelizable tracks after phase 0)

- Phase 0 (serial, small): D3 token mint/validate + D7 chat-identity threading (both touch
  auth/run-context plumbing).
- Track A: D1 headless executor + D4 loop object/scheduling/chat tools.
- Track B: D2 sandbox service.
- Track C: D5 artifacts + versions + feedback-by-chat surface (+ D6 sanitization).
- Track D: D8 interview skill + D9 goal revisions + D11 methodology MVP (schema, seeded
  default, project-creation-as-chat, extraction suggestion).
- Integration: the story, end to end, as the acceptance test; then docs graduation (D10).
- Later phases (post-story): methodology explorer + publishing + evidence; library uploads
  (documents); widget UI primitives.
