# Brief: Wave 16 - echo-next live regressions from #815 (URGENT)

You are in the solve-queue-issues WORKTREE (a separate checkout; another agent
works in the agentic-chat worktree, do not worry about it). Start by:
`git fetch origin && git checkout -b sameer/echo-next-regressions origin/main`.
Full evidence: echo/docs/plans/smart-loop-briefs/wave14-REPORT.md (fetch it
from origin/main if not present locally after checkout; it IS in main? If not,
the facts you need are below).

The wave-14 live verification on echo-next found three regressions after PR
#815 deployed. Root-cause and fix all three. All were verified live at
08:57-09:06 UTC 2026-07-08.

## A. Persisted chats render as empty Ask state (frontend, CRITICAL)

Live evidence: opening an existing agentic chat route shows the empty "Where
would you like to start?" Ask state even though the network tab shows
`GET /api/v2/bff/chats/{id}` 200, `GET /api/chats/{id}/context` 200 with
messages, and `GET /api/v2/bff/chat-messages?chat_id={id}&limit=500` 200 WITH
the persisted user and assistant messages. Chat id that reproduces:
d6cad155-d725-4058-917a-0432ba2d4fe1 (echo-next).

PR #815 heavily touched AgenticChatPanel.tsx (waves 10+11: navigation card
parsing, canvas update proposals, chatId prop threading). Something in that
churn broke history hydration, most plausibly a runtime error during timeline
assembly (check the new parse* functions against real persisted payloads: a
payload shape they throw on would kill the whole render) or a condition that
gates rendering on run state that old chats do not have. Reproduce locally
against fixtures built from the REAL persisted event shapes (pull the actual
BFF payloads from echo-next with admin@dembrane.com/dembrane2024 if needed),
fix, and add a regression test (a persisted-history fixture must render
messages; a malformed tool payload must degrade to text, never blank the
thread). An ErrorBoundary around card parsing so one bad payload can never
blank a chat again would fit the existing patterns.

## B. getPortalLink returns the PRODUCTION portal on echo-next (agent)

Live evidence: the agent gave
https://portal.dembrane.com/en/41ed3b10-b912-4859-8ec9-a33c38d4a213/start
on echo-next; correct is https://portal.echo-next.dembrane.com/... Cause
found: the echo-next agent pod has ECHO_API_URL=http://echo-api:8000/api (the
INTERNAL cluster URL), so the wave-9 hostname mapping in echo_client.py fell
through to its production fallback.

Fix in echo/agent/echo_client.py (+ settings if needed):
- Derive the portal origin from AGENT_CORS_ORIGINS, which already carries the
  per-environment portal origin (echo-next pod has
  AGENT_CORS_ORIGINS=https://dashboard.echo-next.dembrane.com,
  https://portal.echo-next.dembrane.com,http://localhost:5173,
  http://localhost:5174): pick the origin whose host starts with "portal.".
  Keep the public-API-URL mapping as a secondary source for local dev.
- NEVER fall back to production. If no portal origin can be determined, the
  tool returns portal_link: null with a reason, and the prompt tells the agent
  to point at the Overview page instead of giving a link. A wrong-but-plausible
  link is the worst outcome.
- Update tests: internal-cluster ECHO_API_URL + echo-next CORS origins must
  yield the echo-next portal; no-signal case yields null, never production.

## C. Vertex 400 "must include at least one parts field" kills runs (agent/server)

Live evidence: agent pod log shows google.api_core InvalidArgument 400 "must
include at least one parts field" ~30min window around the verify; beat-6
chats (bab5a18f-9a14-4922-b223-9b1e531374cb, 07154bdc-8dae-49d4-9a57-
aa0cc3e97c88) got NO assistant reply persisted at all: the run died on the
model call.

Hypothesis to verify: a message with EMPTY content reaches Gemini. The known
guard is _with_placeholder_content in echo/agent/agent.py ("(calling tools)"
crutch because Gemini rejects empty parts). Since #815, the server worker
suppresses some assistant contents (status narration, wave 10) at PERSISTENCE
time; check how message history is rebuilt for subsequent turns
(echo/server/dembrane/agentic_worker.py _build_message_history and the agent
side) - a suppressed/emptied assistant turn, or a tool-only turn whose text
was suppressed, may replay as empty content. Find the actual path (reproduce:
seed a run whose assistant turn gets suppressed, then send a follow-up), then
fix at the boundary where history is constructed: never emit an empty-content
message to the model (drop the message or restore the placeholder). Add a
test with the exact suppressed-turn-then-follow-up sequence.

## QA

Gates: server whole-tree ruff + pytest tests/test_agentic_worker.py; agent
uv run pytest -q; frontend tsc, biome lint, lingui extract+compile. Local
Playwright: a fixture chat with persisted history renders its messages after
reload (the item-A regression test).

No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave16-REPORT.md (in THIS worktree).
