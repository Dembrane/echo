# Brief: Wave 22 - the two wave-19 verify residuals

Start: `git fetch origin && git checkout -b sameer/verify-residuals
origin/main` (main includes #821 preview-primer and #822 ambient-memory).
Evidence: echo/docs/plans/smart-loop-briefs/wave19-REPORT.md beats 1b/1c/1d.

## Item 1: the agent asks permission instead of showing the way

Live evidence (beat 1c): asked "where do I find the invite link?", the agent
replied with the locating sentence and the portal link, then ASKED whether
the host wanted a navigation card. Zero agentic-navigation-suggestion nodes
rendered in either portal chat (beats 1b, 1c).

Fix in echo/agent/agent.py prompt (post-#822 tree): when a host asks where
something is, the agent calls navigateTo in the SAME turn as the locating
sentence - never asks permission for a card, never describes it as an option
("Would you like me to show a navigation card?" is the named
counterexample). Verify the navigateTo tool-call path emits the payload
shape the frontend parser expects (agenticToolActivity parse) - if the card
did not render because the agent simply never called the tool, the prompt
fix is the whole fix; if payloads mismatch, fix the mismatch. Agent test for
the prompt rule.

## Item 2: proposal cards do not re-render after chat reload

Live evidence (beat 1d): the canvas update card rendered live, Apply worked
("I applied the canvas." + agent continued), but after a page reload the
thread showed plain messages only - 0 applied-card nodes. Wave-16 added the
BFF chat-messages fallback for browsers with no stored run id; suspicion:
after reload the panel takes the fallback path (or hydrates events but the
card parse/applied-state derivation fails), so tool-event cards
(canvas/goal/navigation/project-update) vanish from history.

Investigate in AgenticChatPanel.tsx + agenticToolActivity.ts with fixtures
built from REAL persisted event payloads (pull from echo-next BFF if
needed, admin@dembrane.com/dembrane2024, chat
d6cad155-d725-4058-917a-0432ba2d4fe1 and the wave-19 beat-1d chat if
reachable). Requirements:
- After reload WITH the run id in localStorage, the full timeline including
  suggestion cards must render, applied-state derived per wave-11 logic.
- After reload WITHOUT the run id (fresh browser), if run events are
  recoverable from the server for that chat, hydrate them (check what the
  BFF exposes: the run id is on project_agentic_run by project_chat_id -
  wave 16 may have stopped at plain messages; extend the fallback to fetch
  the latest run's events so cards render too, if the endpoint allows).
- One malformed payload never blanks the thread (keep the wave-16
  containment).
- Playwright/vitest coverage: a persisted-history fixture with a canvas
  update proposal renders the card after remount.

## QA

Gates: agent uv run pytest -q; frontend tsc, biome lint, lingui
extract+compile; server whole-tree ruff + focused pytest only if server
touched. No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave22-REPORT.md.
