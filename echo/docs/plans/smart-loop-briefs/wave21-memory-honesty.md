# Brief: Wave 21 - memory that is actually used, and never phantom actions

Start: `git fetch origin && git checkout -b sameer/memory-ambient origin/main`
(this worktree; a read-only verify agent runs in another terminal here, it
writes only an untracked report, ignore it).

Owner: "i notice memory isn't being used any particular reason?" Evidence
from live session (chat fca458cb-1787-4dc9-aaff-97cdb6eca690, run
732f7933-48bd-49c5-b9bf-aaff79a53b86, echo-next):

- agent_memory has ZERO rows ever, yet the agent told the host "I have saved
  a note to the project memory: 'The owner's name is spelled Akshita...'".
  The run's on_tool_start events show NO remember call and NO readMemory
  call in the entire session. The save was narrated, not performed.
- The same run contains on_chat_model_end events with a FUSED function call
  name: "recordInsightproposeCanvas" (twice). Gemini emitted parallel
  function calls and the streaming merge concatenated their names. Turns
  where the model tries several actions at once get mangled calls; failures
  then get papered over with confident claims.

Three fixes, in echo/agent (+ server where noted):

## 1. Ambient memory (recall must not depend on the model choosing to call a tool)

At run start, the server/agent fetches this run's memories (user scope for
the host + project scope + workspace scope, the same reads readMemory does)
and injects them into the system context as a short "## What you remember"
block (skip when empty; cap total size, newest first). Find where per-run
context (project scope, goal, conversation scope) is already assembled and
add memories there. readMemory stays for explicit re-reads; remember stays
for saving. Result: a saved spelling correction WILL shape the next
synthesis without any tool call.

## 2. Fix the fused parallel tool calls

Root-cause "recordInsightproposeCanvas": inspect how the agent merges
streamed function-call deltas (langchain-google-vertexai AIMessageChunk
merging concatenates same-index function_call name/args across parallel
calls). Fix at the right layer: merge by tool_call index/id, or disable
parallel function calling in the ChatVertexAI config if that is the honest
cheap fix (document the tradeoff in the report). Add a regression test with
two parallel tool call chunks asserting two distinct calls (or a config
assertion if disabling). Check whether the existing "(calling tools)"
placeholder path interacts.

## 3. Never claim an action without its tool result

Prompt hard rule (Honesty section): the agent may only say it saved/logged/
proposed/updated something after the corresponding tool returned success in
THIS turn; if a tool failed or was not called, say plainly what did not
happen. Add the Akshita phantom-save as the named counterexample in prompt
guidance (concise). Agent test asserting the rule text. Also: when remember
IS called, the existing "tell the host in one short sentence" rule stands.

## QA

Gates: agent uv run pytest -q; server whole-tree ruff + focused pytest for
any server-side context assembly change; frontend untouched. curl/local QA:
run a real local turn where the host corrects a spelling -> show the
agent_memory row exists AND a follow-up turn's system context contains the
memory block (log or event evidence).

No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave21-REPORT.md.
