# Brief: Wave 10 - "take me there": the agent navigates hosts to the right page

Owner feedback from real usage, verbatim: "we should have a tool or something to
navigate them to the correct page using i18nnavigate or something! maintaining
the back state ... this is just hard." Context: the agent kept DESCRIBING where
the portal link lives ("go to your main project page, look right at the top")
and the host still could not find it. Describing navigation in prose does not
work. Branch: sameer/agent-portal-link (continue on it; wave-9 grounding is
committed at 22349175). Read echo/agent/agent.py ("## The dashboard" section),
echo/frontend/AGENTS.md, and echo/AGENTS.md first.

## The experience

Host: "where do I find the invite link?" Agent: "It's at the top of your
project overview. I can take you there." and the chat shows a small card with
one primary button ("Go to overview"). One click navigates the dashboard
client-side to that page, and the browser Back button returns them to the chat
exactly where they were. No more prose treasure hunts.

## Item 1: navigation tool + chat card

1. AGENT (echo/agent/agent.py): add a `navigateTo` tool. Input: a page key from
   a FIXED enum matching the real surfaces in "## The dashboard" (overview,
   chats, monitor, library, host-guide, report, conversations, settings,
   portal-editor) plus optional entity id where it makes sense (a specific
   canvas in library, a specific conversation). The tool does NOT call any API:
   it returns a structured payload that becomes a tool event in the run stream
   (same pattern as the proposal tools - find how proposeGoal's payload reaches
   the frontend and mirror it). Reject unknown pages in the tool so the model
   cannot invent destinations. Prompt: when a host asks WHERE something is,
   offer to take them there via navigateTo alongside one short locating
   sentence; never a multi-step prose route.
2. FRONTEND (AgenticChatPanel + a new small NavigationSuggestionCard): render
   the tool event as a compact card in the thread: one line of label text and
   ONE primary button ("Go to overview" etc., sentence case, lingui). Clicking
   navigates with useI18nNavigate (echo/frontend/src/hooks/useI18nNavigate.ts)
   to the project-scoped path (same `/w/{workspaceId}/projects/{projectId}/...`
   paths the sidebar NavItems use in
   features/sidebar/views/project/ProjectHomeView.tsx) - client-side router
   navigation, NEVER window.location, so back state is preserved. The card must
   be dumb-safe on remount and in old chats: navigation is stateless, so no
   applied-state logic, the button always works. Map every enum page key to its
   path in one place; unknown keys render nothing (no crash).
3. Do NOT auto-navigate without a click. The host is mid-conversation; yanking
   the view is worse than the prose problem. The button IS the navigation.

## Item 2: first-turn status prose (wave-8 verify strict-fail)

Evidence (wave8-verify-REPORT.md beat 2): the first persisted assistant message
in a fresh setup chat was "I am looking at your current settings and project
context... Reviewing the onboarding playbook project context...". The wave-8
worker guard only suppresses LONE PARENTHETICAL planning prose; this leak is
unparenthesized status narration as a whole turn.

Fix at the same worker boundary (_sanitize_host_visible_assistant_content in
echo/server/dembrane/agentic_worker.py): suppress an assistant message that
consists ENTIRELY of first-person status narration ("I am looking at...",
"Reviewing...", "Checking...", "Let me look at...") with no question, no
options, and no substantive content for the host. Be conservative: if any
sentence in the message is not status narration, keep the whole message. Add
worker tests with the exact persisted string from the report plus negative
cases (a real answer that merely STARTS with "I looked at your settings" must
survive). Also tighten the prompt: the first visible message of a setup chat
must contain the first real question, not narration.

## QA

- Gates: server whole-tree ruff + focused pytest (worker tests); agent
  uv run pytest -q; frontend tsc, biome lint, lingui extract+compile.
- Playwright locally with fixtures: render a navigateTo tool event, click the
  button, assert the router path changed and history length grew (back
  returns). Screenshot the card to wave10-shots/ (no git-add).
- No git write commands. Report ->
  echo/docs/plans/smart-loop-briefs/wave10-REPORT.md.
