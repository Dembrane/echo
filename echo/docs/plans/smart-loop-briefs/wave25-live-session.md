# Brief: Wave 25 - living sessions: per-turn tool budget + direct canvas edits

You are in the solve-queue-issues worktree. Start:
`git fetch origin && git checkout -b sameer/live-session-edits origin/main`.

Owner evidence (echo-next chat 431338d7-0239-4636-b3e4-9e1aea586ef0, run
f35abad0-3b9a-425f-8ae8-050464b726dc): a team ran a LIVE retrospective for ~90
minutes in one chat - goal proposal, canvas creation, six applied updates,
live transcript reads person by person. The mid-run append design kept it all
in ONE run: 31 tool starts accumulated, and when the host asked "can you pls
remove all the dividers and ... can you edit the html directly?" the run hit
MAX_TOOL_CALLS_PER_RUN and answered with the tool-limit safety message - a
dead end to a direct question.

## Item 1: the tool budget is per TURN, not per run lifetime (server)

In echo/server/dembrane/agentic_worker.py: counted_tool_start_count gates the
safety message against MAX_TOOL_CALLS_PER_RUN, but appended user turns keep
the same run alive indefinitely (by design). Change the budget to reset when
a new user message is consumed (the worker already tracks turn boundaries for
the append flow), so every question gets a fresh budget. Keep a much larger
per-run hard ceiling as a runaway backstop (e.g. 10x the per-turn budget)
whose safety message explicitly says to start a new chat. Also improve the
per-turn safety message: it must acknowledge the actual request and say
sending it again will retry fresh, not the current vague "I've gone as far
as I can in one pass". Tests: appended second turn gets a fresh budget; the
backstop still fires.

## Item 2: direct canvas edits from chat (the "edit the html directly" yes)

The hosts wanted two dividers and a footer line removed. Today that means:
propose -> apply -> wait for a full regeneration and hope it honors the note.
Build the surgical path:

- AGENT tool `editCanvas(canvas, instruction)` (name/id resolved via the
  existing resolver): fetches the LATEST generation HTML via the server,
  produces the edited body fragment itself (the agent rewrites the HTML
  applying ONLY the requested change), and submits it.
- SERVER endpoint (agent-auth path like the insight endpoint): validates,
  runs the SAME sanitize pipeline as ticks, stores it as the newest
  generation (tick_kind "edited", detail carries the instruction + chat id),
  publishes the generation nudge. Reuse the wave-20 applied-preview storage.
- STICKINESS: a direct edit must survive the next refresh. Append the edit
  instruction as a standing constraint to the canvas config (a new config
  revision whose brief carries e.g. "Standing edits: no section dividers; no
  'freshly compiled' footer line"), so regenerations preserve it. Keep the
  revision history honest.
- PROMPT: for small presentation/wording edits explicitly requested in chat,
  the agent edits directly and says what changed (no proposal card
  ceremony); for changes of substance (what the canvas gathers/shows,
  cadence, name) the proposal flow stays. The host asked for exactly this;
  cite the divider/footer example in the prompt guidance.
- Chat card/event: the edit shows as tool activity with an "Open in library"
  affordance if cheap; no new card component required.

## Item 3: visible-text hygiene (small)

Same session persisted "确定 (fetching transcript...)" (stray non-English
model token) and "Successfully extracted Cesare's timeline" ("successfully"
is banned brand copy) in host-visible messages. Prompt: never use
"successfully"; write only in the host's language. Worker sanitizer: strip a
leading stray CJK/control token cluster when the rest of the message is the
host's language (conservative regex, test with the exact string).

## QA

Gates: server whole-tree ruff + pytest tests/test_agentic_worker.py + canvas
tests (env bundle from prior reports); agent uv run pytest -q; frontend only
if the tool-activity affordance touches it (then tsc/biome/lingui). curl QA:
local editCanvas round trip -> newest generation is the edited fragment with
tick_kind "edited" and the config carries the standing constraint.

No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave25-REPORT.md (this worktree).
