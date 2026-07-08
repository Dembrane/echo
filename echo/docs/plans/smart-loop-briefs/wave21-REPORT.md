# Wave 21 Report: Memory Honesty

## Summary

Implemented the agent-side fixes for memory recall, fused Gemini tool calls, and action-claim honesty.

- Ambient memory now loads once per agent graph run from the existing scoped memory endpoint and is injected into the model system context as a bounded `## What you remember` section, newest first.
- The memory prompt now tells the model to use ambient memories without waiting for a `readMemory` call, while keeping `readMemory` available for explicit rereads.
- The honesty prompt now forbids saying an action was saved, logged, proposed, updated, paused, resumed, stopped, or sent unless the matching action succeeded in the same turn, with the Akshita phantom-save as the named counterexample.
- Added a defensive fused-tool-call normalizer at the agent boundary. If a malformed tool call name is an exact concatenation of known tool names and its args are concatenated JSON objects, the response is recovered into distinct tool calls before LangGraph decides whether to execute tools.
- The fused-call fix handles both `tool_calls` and `invalid_tool_calls`. If args cannot be split exactly, the malformed call is not executed as a guessed action.

## Files Changed

- `echo/agent/agent.py`
- `echo/agent/tests/test_agent_graph.py`

## Tool-Call Tradeoff

I did not disable parallel function calling in `ChatVertexAI`: the installed `langchain-google-vertexai` `bind_tools` surface exposes tool mode and allowed function names, but not an explicit parallel-tool-call disable switch. The implemented fix is therefore a defensive recovery layer after model invocation. It only splits names that exactly decompose into registered tool names, and only when the args split into the same number of JSON objects, so it avoids inventing partial actions.

## Verification

Passed:

```bash
cd echo/agent && uv run pytest -q tests/test_agent_graph.py tests/test_agent_tools.py
cd echo/agent && uv run pytest -q
```

Result: `92 passed`.

Attempted:

```bash
cd echo/agent && uv run ruff check .
```

Result: failed because `ruff` is not installed in the agent environment.

Not run:

- Server ruff and server pytest, because no server-side code changed.
- Real local curl/Directus QA turn, because this worker did not have a running local app stack and memory database session to create a live `agent_memory` row. The unit coverage verifies the same agent behavior: memory payload from `list_memory` appears in the first model invocation system context, and malformed fused tool calls are recovered before tool execution.
