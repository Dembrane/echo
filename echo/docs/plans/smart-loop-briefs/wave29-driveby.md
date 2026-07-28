# Brief: Wave 29 — drive-by insight sweep (frontend/portal only)

Start: you are already on branch sameer/driveby-insights (tracking
origin/main) in this worktree. Do NOT run any git write commands.

Scope guard: echo/frontend only. Do not touch echo/server, echo/agent, or
echo/directus. If a fix truly requires a server change, document it in the
report instead of making it.

Five small, independent fixes from the live agent_insight backlog. Each is
participant- or host-visible tomorrow morning; polish matters.

## 1. Scroll-to-bottom button

Long participant response lists (conversation view) force manual scrolling
to reach the newest content ("really annoying" — said live). Add a small
floating scroll-to-bottom affordance that appears only when scrolled away
from the bottom, on the conversation transcript/responses view (and the
project chat panel if it lacks one). Subtle variant, Phosphor icon, brand
rules (no bold, lowercase dembrane).

## 2. Honest cadence label on canvas cards

CanvasSuggestionCard (echo/frontend/src/components/chat/) shows a hardcoded
"updates every few minutes" style label even when the proposed canvas is
static / non-looping. Derive the label from the actual proposal config:
real cadence when it loops, a clear quiet "does not update on its own"
state when it does not. Same honesty on the canvas route freshness cluster
if it shows a cadence that does not match the loop config.

## 3. Conversation links land on the moment

Chat references and canvas links currently land at the top of a
conversation. Add support on the conversation route for a chunk anchor
(e.g. ?chunk=<id> or #chunk-<id>): scroll to and briefly highlight that
chunk on load. Then, wherever the frontend renders references that already
carry chunk-level data, emit the deep link. Do NOT invent chunk ids where
the data lacks them — conversation-level links stay as they are.

## 4. Full-viewport fullscreen

Canvas presentation/fullscreen mode: the container stops abruptly and does
not scale to full viewport height (host friction, in_progress). Make the
fullscreen wrapper truly 100dvh/100dvw, iframe filling it, no dead bands.
Check both the dashboard canvas route and any standalone present mode.

## 5. Ready-to-record portal step

Participant portal: after entering a name, recording starts immediately.
The team asked for an intermediate "ready to start" state during live QR
testing. Add a lightweight confirmation step between name entry and active
recording: name confirmed -> a calm "ready to record — start when you are"
screen with a single primary start action. Must not regress the funnel
beacons (scanned/onboarding stages report via existing hooks — see
ParticipantOnboardingCards/ParticipantStart) or the skipOnboarding QR
parameter (skip flows keep skipping straight to recording).

## QA gates

- cd echo/frontend && npx tsc --noEmit
- biome lint (repo convention)
- lingui extract + compile after ANY user-facing string change (raw
  message-id hashes in the UI is the named failure)
- vitest for the cadence-label derivation and the chunk-anchor scroll hook
- Report -> echo/docs/plans/smart-loop-briefs/wave29-REPORT.md with a
  file list, gate output summary, and screenshots if a local run is
  feasible (do not block on the full podman stack).
