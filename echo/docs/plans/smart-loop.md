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

## D4a. Two-layer artifact refresh: skeleton vs data - PROPOSED

Owner review insight (2026-07-07): a "live" artifact has two kinds of update, and only one
needs a language model.

- SKELETON: the artifact's program - what data it fetches, how it aggregates and renders.
  Built and revised ONLY by agentic runs (initial build, host feedback, agent-noticed
  structural change like a new theme layout). Each revision = a skeleton VERSION
  (append-only, host-visible, few and meaningful).
- DATA TICK: the loop's routine beat. The sandbox re-executes the SAVED skeleton script
  against fresh data via the scoped token and renders a new snapshot. NO agent turn, no LLM
  call - cheap, deterministic, frequent. Snapshots are kept (scrub through the day) but are
  not "versions" in the host-facing sense.
- Consequence for D1: the headless executor has two entry points - a data tick (sandbox
  exec only) and a skeleton revision (full agentic run). Ticks that detect a structural
  trigger (e.g. "nothing renders sensibly anymore") may ENQUEUE a skeleton revision, never
  perform one inline.
- User language: hosts are never shown "polling" or intervals up front. The proposal card
  says "stays up to date until <expiry>"; refresh cadence and skeleton-revision policy live
  in an advanced setting. Default data tick: every few minutes while the loop is active.
- Freshness classes, not one interval: a skeleton declares each data source's class and the
  system picks the mechanism - `live` (rides the existing monitor SSE / Redis snapshot
  stream, no polling at all - already built), `fast` (~2 min tick), `normal` (~5-10 min
  tick), `on-demand` (only on view/preview). One artifact can mix classes (a wall's
  presence counter is live; its theme tiles are normal). Tick type is also declared:
  `data-only` (pure fetch+render, no LLM) or `data+summarize` (a bounded, cheap LLM step
  inside the tick - e.g. pulse needs one; a monitor widget doesn't).

## D14. Client-side artifact runtime: common skeleton + generated fetchers - PROPOSED

Owner refinement (2026-07-07): refresh lives CLIENT-SIDE. A common, dembrane-shipped
skeleton runtime renders artifacts in the dashboard (layout, full-screen view, refresh
scheduling in JS); the artifact itself is essentially A BUNCH OF FETCHERS. Fetchers use the
SSE event stream or the data APIs, scoped to the user - i.e. the VIEWER'S OWN session
cookie, which is literally "the user's access to the same API the client uses". Agent-
generated fetchers are the core generated unit.

Three-layer security model (non-negotiable):

1. TRUSTED SHELL (ours): the skeleton runtime. Executes fetchers with the viewer's
   credentials. Fetchers are DECLARATIVE descriptors (which endpoint/SSE channel, params,
   field mapping, freshness class) - data, not code - so nothing generated ever runs with
   ambient credentials.
2. UNTRUSTED RENDER (generated, when descriptors + our block library aren't enough): runs
   credential-less in a sandboxed iframe; the trusted shell fetches and POSTS DATA IN.
   Generated code sees data, never cookies, never the API.
3. SERVER LOOP (D4a, retained for what the client cannot do):
   - data PRODUCTS that need compute or a model - e.g. the pulse summary. A server tick
     (data+summarize) produces the product; a client fetcher merely reads it. Loops become
     producers of data products, not re-renderers of HTML.
   - PUBLISHED artifacts - the venue screen has NO session. Anonymous viewers get
     server-rendered snapshots refreshed by ticks at the loop's cadence (reusing D4a
     machinery), NOT a capability URL with live data access. This is the one place the
     server tick still renders.

Consequences: D3's minted token shrinks to server-side contexts (ticks, sandbox, published
snapshot renders) - in-dashboard viewing needs no new auth at all. D6's "structured blocks"
becomes the fetcher/block descriptor schema, and the widget endgame (pinnable/embeddable)
is this same runtime rendering one fetcher-set in a small frame - the monitor widget (D13)
is the first proof. In-chat "Try it" previews (D12) run in this runtime too, with the
sample dataset injected at the shell.

Open risk to watch: descriptor expressiveness. If real recipes keep needing generated
render code (layer 2), the sandboxed-iframe path must be as ergonomic as the descriptor
path or the agent will fight the abstraction. Decide after building pulse + wall.

## D13. First-class loop recipes: curated before generated - PROPOSED

Ship a small set of dembrane-maintained recipes as seeded skeletons with known-good
fetchers - no LLM-written code in their tick path:

- *Monitor widget* - a compact live view of the project's sessions (data-only, `live`
  class; reuses gather_project_monitor).
- *Pulse* - the reference recipe, spec'd 2026-07-07 (owner-corrected: GENERIC, not
  hardcoded flavors). A pulse is a TRACKED QUESTION; a pulse artifact holds one or more of
  them.
  - Pulse = {question (free text: "What are the themes right now?", "What are people
    talking about?", "How is sentiment on the garage plan shifting?"), answer-shape hints
    (target length, format: prose | list | labelled themes), window (new-since-last-tick
    delta | current-state), cadence class}. The question is the configurable heart - it can
    change over time, or never.
  - The tick (data+summarize, default 5 min, advanced-tunable, mandatory expiry) answers
    ALL of the artifact's active pulses in one structured LLM call against the project's
    fresh/current chunks, appending one timestamped ANSWER per pulse. A pulse's answer
    history is its feed; a state-shaped answer's latest entry renders as a board. Quiet
    tick on a delta pulse -> no entry; resume after pause -> one catch-up entry; never a
    cumulative re-summary where the window says delta.
  - Editing is first-class and generic: adding, removing, or REPHRASING a pulse question
    goes through the standard skeleton flow - agent proposes, D12 preview ("Try it"
    renders the new question answered against current/sample data), host applies, new
    artifact VERSION. Answers are keyed to the question revision that produced them, so
    history stays honest when a question evolves mid-session.
  - Answers are data products, never versions. Rendering: the D14 runtime lays out the
    artifact's pulses (each = latest answer + expandable history; full-screen mode);
    logged-in = client runtime, PUBLISHED big screen = server-rendered snapshots per tick
    (no session, no live data access). Answer generation follows the project's
    anonymization stance - publishing a pulse is publishing paraphrased participant voice,
    same responsibility as publishing a report.
  - Ownership: project-owned artifact rows (kind=artifact, recipe=pulse), creator
    recorded; view = report:view, configure/pause = chat lifecycle, publish = explicit
    host action. After expiry the answer histories freeze into the session record - prime
    seed material for the closing report.

"Set up a pulse for this project" is then a one-tap proposal in chat - configurable
(scope, tone, cadence class within bounds) and editable by chat like any artifact, but its
skeleton is ours, versioned by us. Hosts who know nothing about software get something
that always works and is always previewable.

Sequencing consequence (deliberate): v1 ships the ENTIRE loop machinery (D1, D4, D4a,
D12 preview) on curated recipes only; agent-GENERATED skeletons (the sandbox writing
custom walls) become v1.5. This de-risks the sandbox path - the riskiest component
(LLM-written code) is the last one in, on top of infrastructure proven by curated code.

## D12. Draft, preview, and the artifact test contract - PROPOSED

How a host tests changes before applying, with zero software knowledge:

- Every skeleton change (initial build, chat feedback, agent proposal) lands as a DRAFT
  version with a preview snapshot rendered INSIDE the chat thread - the proposal card gains
  a live "Try it" render. Apply promotes it; nothing goes live unseen.
- Preview data source, picked automatically: real project data when any exists (a tick
  against the draft); otherwise a BUNDLED sample dataset switched in at the fetch layer -
  unmissably watermarked "sample data", never persisted, never model-invented (fabricated
  participant quotes are an honesty hazard in this product).
- The sample dataset doubles as the test fixture: a skeleton version must render cleanly
  against the sample set AND an empty set before it can be applied. That is the artifact
  CI.
- Full-journey rehearsal: the assistant coaches a real 2-minute test recording
  (record-then-delete). NO seed-data inserter - fake rows in the DB leak into monitor
  counts, reports, library, and insights unless every consumer filters a test flag;
  codebase-wide tax rejected for v1 ("mark as test" is the upgrade path if record-then-
  delete proves clunky).

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
- Versions, two levels (per D4a): `artifact_version` = skeleton revisions (append-only,
  host-facing, from chat feedback or agent proposals) and `artifact_snapshot` = rendered
  data ticks (append-only, lightweight, the "scrub through the day" timeline; prunable
  after loop expiry if volume demands). The report body points at the latest snapshot of
  the current version. Nothing is overwritten at either level.
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
  When the user or workspace already has methodologies, the setup chat OFFERS them first
  ("start from Panel day v3, or figure this one out from scratch?") - selection happens in
  the conversation, not a separate picker (the explorer comes later).
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
- Track A: D1 headless executor + D4/D4a loop object, ticks (data products + published
  snapshots), scheduling, chat tools.
- Track B: D14 client runtime - trusted shell, declarative fetchers, sandboxed render
  iframe; D2 sandbox service shrinks to server-side ticks + snapshot renders (curated
  first; generated code lands v1.5).
- Track C: D5 artifacts + versions/snapshots + D12 draft/preview/test contract + feedback-
  by-chat surface (+ D6 sanitization, now the descriptor/block schema).
- Track D: D8 interview skill + D9 goal revisions + D11 methodology MVP (schema, seeded
  default, project-creation-as-chat, extraction suggestion).
- v1 = the whole machinery on D13's CURATED recipes (monitor widget, pulse). v1.5 = agent-
  GENERATED skeletons (the full live-panel-wall story).
- Integration: the story, end to end, as the acceptance test; then docs graduation (D10).
- Later phases (post-story): methodology explorer + publishing + evidence; library uploads
  (documents); widget UI primitives.
