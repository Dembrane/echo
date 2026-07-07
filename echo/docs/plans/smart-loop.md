# SMART loop - architecture plan and decision record

Anchor user story: `docs/building/smart-loop.md` (the "live panel wall"). The story is the
acceptance test; this doc records the architecture choices, risks, and build sequence.
Decisions marked **[OWNER]** need Sameer's sign-off; the rest are recommendations that can
be overturned in review. Rewritten 2026-07-07 (evening) after the dynamic-canvas pivot -
see "Consistency pass" at the end for what changed and what's re-opened.

Status legend: PROPOSED -> AGREED -> BUILT. Superseded material is folded into the
decision that replaced it, not preserved as archaeology.

## D15. The dynamic canvas - what v1 IS - PROPOSED [OWNER-STATED]

Owner directive (2026-07-07): the surface is called the **dynamic canvas**. On a canvas
you PLACE elements: the monitor widget, text items, and - the star - **generated HTML
frames**. v1 is: *the LLM generates HTML every N minutes, server-side, and it renders on
the canvas in an iframe.* Skeletons, declarative fetchers, and reusable primitives are
secondary and come later. People will ask for exactly this - "every five minutes I want
this answer on the screen" - and the generation shorthand (our theme, Tailwind, chart
libraries) makes the output good.

Canvas element types (v1):

- `html_frame` - gather spec + brief -> LLM generates a full HTML document each tick ->
  rendered in a sandboxed iframe. Charts (d3), layout, styling: the generator uses a
  bundled kit (theme tokens, Tailwind, d3) - see D6.
- `text_item` - gather spec + question -> plain text answer each tick (the D14a item
  model, unchanged; the trivial sibling of html_frame).
- `monitor_embed` - the existing live monitor in a frame (SSE, truly live, no AI step,
  not tick-driven). The one raw-data display, deliberately outside the generation model.

Future (explicitly later, owner-stated): generated elements generalize into reusable
primitives; methodologies bundle their own element sets (some dembrane-made); mix and
match. The generator gains tools/primitives to CONNECT things (pulse products etc.) -
"first the HTML".

## D16. The tick pipeline - bounded generation, not an agent loop - PROPOSED [OWNER Q1]

"The LLM generates HTML every five minutes" needs one precision: WHAT runs at the tick?

- RECOMMENDED: a bounded pipeline per due element - (1) execute the element's gather spec
  (declarative, deterministic: window / tags / filters, project-scoped, via the D3 token),
  (2) ONE constrained LLM call: data + the element's brief + the previous frame (for
  visual continuity - "keep the layout stable, update the content") + the kit's shorthand
  guide, (3) sanitize (D6), (4) store the generation (D5). No tool loop, no agent
  personality, bounded tokens, predictable cost and latency.
- The FULL agent participates at AUTHORING time only: in chat it drafts/edits the element
  (gather spec + brief) with Try-it previews (D12). Ticks then run that config
  mechanically.
- Rejected for v1: a full agentic run per tick (tool loop deciding what to fetch each
  time) - unpredictable cost, slower, and unnecessary when the gather spec is explicit.
  Revisit for elements that genuinely need per-tick judgement.
- Frame-to-frame continuity matters on a big screen: passing the previous frame plus a
  stability instruction prevents a redesign every 5 minutes. [OWNER Q4: confirm the
  generator should see the previous frame; skip it and every tick is a fresh design.]
- Model tier: fast-class (Flash) for generation ticks, not Pro - this is not chat; the
  AGENTS.md "don't downgrade chat" rule doesn't apply. Escalate per-element only if
  quality demands. [OWNER Q3]

## D1. Headless agentic executor - RE-SCOPED, not v1-critical

Original problem: the agentic runtime is reconnect-driven (turns execute only while a
client is attached to the stream). With D16, v1 ticks are bounded jobs, NOT agentic runs -
they don't need the agentic runtime at all. Authoring happens in chat where a client IS
attached.

- v1: the tick executor is a plain async job path (scheduled_task -> gather -> generate ->
  store -> narrate into the loop's chat thread via the service layer). Respect the
  no-asyncio-in-Dramatiq rule: run ticks in the API process via an internal endpoint (the
  lease pattern still prevents double-processing) or via `run_async_in_new_loop`.
- LATER (when loops run full agent turns - skeleton revisions by loop, autonomous goal
  refinement): the internal `POST /api/agentic/runs/{id}/drive` endpoint that starts the
  same asyncio `_runner` the stream path uses, without a client. Events persist as today;
  a host opening the chat replays history like a reconnect; the existing turn lease makes
  double-driving safe.

## D2. Python sandbox service - DEFERRED past v1

v1 generation is prompt -> HTML: no server-side code execution needed. Interactive charts
run as JS inside the client-side sandboxed iframe (D6), credential-less. The Python
sandbox returns to the path when server-side COMPUTATION enters (heavy aggregation,
skeleton execution per D4a-v2). Decision parked with its shape intact: dedicated
in-cluster service, fresh-workdir subprocess with rlimits, non-root, no persistent disk,
NetworkPolicy egress ONLY to the API, called with the D3 token. MicroVM isolation only
if/when we execute user-supplied code.

## D3. Scoped run credentials - PROPOSED [OWNER]

"The user's access" must not mean "the user's session token". Ticks run headless and need
to read project data (gather specs) and write generations.

- Mint a short-TTL (minutes) token server-side per tick/run:
  {directus_user_id, project_id, scopes, exp}, validated in `dependency_auth` alongside
  the existing JWT path. Log every mint with loop/element id.
- Scopes: READ endpoints the user could read anyway, plus generation-WRITE for the one
  element being computed. Explicitly NO destructive routes (delete conversation, settings
  writes, member management) regardless of the user's real role.
- Why: transcripts are untrusted input feeding a generator (prompt injection). With a
  read+element-write token, the worst injected output is a bad frame - visible,
  versioned, revertible. In-dashboard VIEWING needs no new auth: the canvas fetches
  generations with the viewer's own session (D14).

## D4. Loop object model - PROPOSED

One loop per canvas by default. New collection `agent_loop`: project_id, canvas
(artifact) id, name, expires_at (REQUIRED - the agent always sets one and states it),
status (active | paused | expired | stopped), created_from_chat_id, chat_id (the loop's
dedicated thread), caps, failure_count. Plus `agent_loop_run` rows for tick history.

- ACTIVE means exactly "it is running" (owner-stated). Paused/expired/stopped: elements
  stop computing, histories freeze. Publish is fully decoupled and deferred (D5).
- Cadence is PER ELEMENT (element config carries cadence_minutes); the loop's scheduler
  computes whichever elements are due each tick. Default 5 minutes; floor 2 minutes
  [OWNER Q3]; "continuous" exists only as the monitor embed (SSE), never as a generation
  cadence.
- Scheduling: reuse the durable `scheduled_task` queue (processor ticks every minute); a
  completed tick enqueues the next occurrence; expiry checked every tick. NO new
  APScheduler jobs (backlog decision stands).
- Guardrails: mandatory expiry; auto-pause after 3 consecutive failures; honest no-op
  ticks (quiet delta -> no generation, tick recorded); lifecycle changes narrated in the
  loop's chat thread.
- Chat lifecycle tools: proposeLoop (proposal card - hosts apply; the agent never
  self-starts a loop), listLoops, pauseLoop, resumeLoop, stopLoop, updateLoop (cadence and
  expiry changes also via proposal).
- User language: hosts are never shown "polling" or intervals up front. The card says
  "stays up to date until <expiry>"; cadence lives in an advanced setting.

## D4a. Skeleton/data split - RETAINED AS THE v2 OPTIMIZATION

The earlier design (ticks re-execute a saved skeleton with NO LLM; only skeleton
revisions use a model) is inverted for v1 by owner directive: v1 ticks ARE generations.
The split returns as the cost/stability optimization once real usage shows which frames
stabilize: a settled html_frame can graduate to a saved skeleton + cheap data refresh.
Cost control in v1 comes from D16 (bounded single call, fast model), D4 (expiry, cadence
floor, per-element cadence), and caps. Freshness classes survive in miniature: monitor
embed = live; generated elements = their cadence; previews = on-demand.

## D5. Canvas on the report primitives; generations + config revisions - PROPOSED [OWNER]

- The CANVAS is the artifact: reuse `project_report` machinery (sidebar list per project,
  open/regenerate, creator recorded) with kind ('report' | 'canvas'), source ('host' |
  'loop' | 'chat'). PDF/publish machinery exists there but publish is DEFERRED (owner:
  "forget the publish part") - the venue-screen story beat is the north star, not v1.
  When publish returns, published canvases are server-rendered snapshots (no session, no
  capability URLs with live data access).
- Two append-only levels, nothing overwritten:
  - element CONFIG REVISIONS (gather spec, brief/question, cadence) - the host-facing
    version history, created via chat proposals;
  - GENERATIONS (`element_generation`: element_id, config_revision, content html|text,
    created_at) - the per-tick outputs, the scrub-through-the-day timeline, keyed to the
    revision that produced them so history stays honest when a brief changes mid-session;
    prunable after loop expiry if volume demands.
- Schema: `canvas_element` rows (canvas_id, type html_frame|text_item|monitor_embed,
  gather_spec, brief/question, cadence_minutes, window delta|current-state,
  config_revision, layout/sort) + `element_generation` as above.
- Feedback-by-chat: the canvas links to a chat scoped to it; agent tools readCanvas /
  proposeElementChange write config revisions. First-use coaching line. This flow gets its
  own docs page.
- Naming [OWNER]: sidebar surface name ("Canvas"?) and the old Library
  (views/aspects) collision - decide before the sidebar item ships; canvases can sit
  alongside Reports initially.

## D6. Generated HTML: the iframe posture - REDEFINED [OWNER Q2]

Charts (d3) and layout require SCRIPTS, so "sanitize by stripping scripts" (the earlier
stance) is dead. The boundary moves from "no scripts" to "scripts in a locked room":

- Each html_frame renders in a SANDBOXED, NULL-ORIGIN iframe: no credentials, no storage,
  no top-navigation, postMessage-only channel to the shell.
- Strict CSP: scripts and styles ONLY from our bundled kit (theme tokens, Tailwind build,
  d3, chart helpers - served from our origin, versioned) plus the frame's own inline
  code; NO external network at all (no CDN, no fetch/XHR targets). Data is embedded in
  the generated document at generation time - a frame is self-contained and static
  between ticks.
- Server-side sanitation still runs at store time for non-script vectors and size caps;
  the iframe + CSP are the real boundary.
- Generated content paraphrases participant voice: the project's anonymization stance
  applies at generation, same as reports.

## D7. Insight enrichment + reach-back - PROPOSED (unchanged)

- Thread chat identity server->agent: chat_id + triggering message_id + app_user_id in
  the run context (closes the deferred reach-out linkage). `usage_insight` and
  `support_request` gain those columns.
- Consent-first, always: the agent ASKS before informing the team ("Would you like to let
  the dembrane team know...?") - feature gaps AND the pre-event heads-up. Never silent.
- Reach-back channel: a staff/system-authored message type appended into the original
  chat, visually distinct from the assistant.

## D8. Interview skill (one muscle, two uses) - PROPOSED (unchanged)

Agent skill used for (a) goal-setting at project creation ("Help me figure it out") and
(b) feature-gap capture. Convergent options (2-4 concrete choices), <=5 questions,
confirm-understanding close, always escapable. Output: goal revision proposal (a) or
detailed insight (b) with requirement, job-to-be-done, accepted workaround, verbatim
quotes, reach-back ids.

## D9. Goal = versioned context, an instance of the methodology - PROPOSED (unchanged)

`project_goal_revision`: content, set_by (host-edit | interview | loop), created_at,
chat_id. Current goal = latest revision; empty -> default report prompt unchanged. Goal
feeds report/canvas briefs. Meta-goal behavior: when no goal exists, gently offer the
interview. The METHODOLOGY is the template; the GOAL is this project's instance.

## D10. Docs lead the build - AGREED (process, unchanged)

Every feature here gets a story page under `docs/building/` BEFORE build; graduates into
`features/` + the dembrane-next table on ship, via the code-to-docs process.

## D11. Methodology - the reusable way-of-working - PROPOSED [OWNER]

As agreed earlier today, plus one canvas addition. `methodology` (name, description,
user-facing framing, owner, visibility private|workspace|public) + `methodology_version`
(content blocks, created_by, note; evidence links later). `project.methodology_version_id`
selects one; DEFAULT = seeded "dembrane" methodology v1 (= the meta-goal interview).
Project creation opens directly into the setup chat with escape hatches (skip / come back
/ read the docs); existing user/workspace methodologies are OFFERED in the conversation.
Extraction skill proposes methodologies from real projects (nudge on repetition, never
automatic, everything host-editable). NEW (owner, 2026-07-07): methodology versions will
BUNDLE canvas element sets - "each methodology comes with its own set of things, some
dembrane-made; mix and match" - future phase, recorded so the content-block schema leaves
room. Explorer, publishing, evidence: later phases. MVP: schema + seeded default +
creation-as-chat + selection-in-conversation + extraction suggestion.

## D12. Draft, preview, and the test contract - PROPOSED (re-anchored)

- Every element config change (new element, edited brief/gather spec) lands as a DRAFT
  revision with a "Try it" preview IN the chat: one generation run now, against real
  project data when any exists, else the BUNDLED sample dataset - unmissably watermarked,
  never persisted, never model-invented (fabricated participant quotes are an honesty
  hazard). Apply promotes; nothing computes on a live canvas unseen.
- Test contract per generation: the element's brief must produce a sane frame against the
  sample set AND the empty set (graceful "no data yet" state) before Apply. That is the
  canvas CI.
- Full-journey rehearsal: coached 2-minute real test recording (record-then-delete). NO
  seed-data inserter (DB pollution across monitor/reports/library/insights; "mark as
  test" is the upgrade path if needed).

## D13. First-class canvas elements & future primitives - REWRITTEN

- v1 ships with the three element types (D15) and ONE curated flow: "set up a pulse"
  composes a canvas of text_items tracking the questions you care about (the tracked-
  question model from D14a) - one tap from chat, no setup knowledge.
- The earlier "curated recipes BEFORE generated code" sequencing is superseded by owner
  directive: generated html_frames ARE v1. What survives of the intent: generation is
  BOUNDED (D16), previewed (D12), versioned (D5), and sandboxed (D6) - the de-risking
  moved from "avoid generation" to "constrain generation".
- Later: generated elements generalize into reusable primitives the generator can
  reference ("connect a pulse product into this frame"), and methodologies bundle element
  sets (D11).

## D14. The canvas runtime (client) - REWRITTEN

- The dynamic canvas is the dembrane-shipped shell: layout, full-screen view, element
  frames, and client-side refresh in JS - it polls for NEW GENERATIONS on each element's
  cadence with the VIEWER'S OWN session (reading computed products only; raw project data
  is never fetched by canvas code), and hosts the monitor embed's SSE.
- html_frame content renders in the D6 sandboxed iframe; text_items render as native
  typed components; monitor_embed is the existing monitor component.
- Widget endgame (draggable / pinnable / embeddable, clean primitives): this same shell
  rendering one element in a small frame - a renderer evolution, not a content migration,
  because generations are stored per element.
- In-chat "Try it" previews render through this same shell.

## D14a. text_item: the tracked-question element - PROPOSED (narrowed)

The gather->AI->answer workflow model, now scoped to the text_item element type (the AI
step stays mandatory across ALL generated elements - html_frames have it by
construction). ITEM = {gather spec (window like "last 5 minutes", tags, filters,
project-scoped), question (required, free text), answer shape TEXT, per-element cadence,
window semantics delta | current-state}. Quiet delta tick -> no answer; resume -> one
catch-up; never a cumulative re-summary where the window says delta. Answers are
generations (D5), keyed to config revision. Marieke's wall recomposed as a canvas:
html_frame (theme tiles + what's-happening, one frame) or html_frame + text_items, plus a
monitor_embed for live presence - author's choice per layout.

## Build phases (rewritten for the canvas pivot)

- Phase 0 (serial, small): D3 token mint/validate + D7 chat-identity threading.
- Track A: D4 loop object + scheduled_task recurrence + chat lifecycle tools + D16 tick
  pipeline (gather -> generate -> sanitize -> store -> narrate).
- Track B: D5 canvas schema on report primitives + D14 canvas shell + D6 iframe/kit
  (theme, Tailwind, d3 bundle) + D12 Try-it previews.
- Track C: D8 interview skill + D9 goal revisions + D11 methodology MVP
  (creation-as-chat included).
- v1 acceptance: a host asks in chat for "X on the screen, updated every few minutes" ->
  proposal -> Try it -> apply -> canvas in the sidebar, generations flowing, pause/stop
  by chat, expiry honoured. The full live-panel-wall story (minus publish) is the test.
- v2+: D4a skeleton graduation for stabilized frames; D2 Python sandbox when server-side
  compute enters; publish/venue screens; primitives + methodology element bundles;
  library uploads (documents); D1 full headless agentic runs for self-revising loops.

## Consistency pass (2026-07-07, after the dynamic-canvas directive)

Contradictions found and resolved in this rewrite:

1. D13 "curated before generated" vs owner's "generated HTML IS v1" -> superseded;
   de-risking reframed as constrain-generation (D16/D6/D12) instead of avoid-generation.
2. D4a "ticks never call an LLM" vs v1 ticks = generations -> D4a demoted to the v2
   optimization path.
3. D14 "loops produce data products, not re-rendered HTML" -> wrong for v1; runtime
   rewritten around generations.
4. D6 "strip scripts" vs d3/interactive charts -> replaced with the locked-iframe
   posture (null-origin, bundled kit, zero network).
5. D2 Python sandbox was v1-critical -> v1 needs no code execution; deferred with shape
   intact.
6. D1 headless AGENTIC executor was the "core new piece" -> v1 ticks are bounded jobs;
   the agentic drive endpoint moves to v2 (self-revising loops). v1 got cheaper.

Open questions needing owner answers (numbered for reply):

- Q1 (D16): confirm ticks are bounded single-call generations (agent only at authoring),
  not full agent runs per tick.
- Q2 (D6): confirm the iframe posture - scripts ALLOWED inside null-origin sandboxed
  iframes with our bundled kit and zero network (this replaces "strip scripts").
- Q3 (D16/D4): generation model tier (fast-class recommended) and the cadence floor
  (2 minutes recommended; "continuous" reserved for the monitor embed).
- Q4 (D16): should the generator see the PREVIOUS frame for visual continuity
  (recommended), or regenerate from scratch each tick?
- Q5 (D5): canvas surface naming in the sidebar + the old Library collision.
- Q6 (D3): the read+element-write token scope - unchanged from this morning but now the
  only [OWNER] security decision left in v1 (D2 deferred took the sandbox-tier question
  with it).
