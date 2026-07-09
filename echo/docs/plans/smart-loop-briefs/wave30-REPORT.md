# Wave 30 Canvas Speaks Back Report

## Summary

- Added a compact canvas activity context path for agent runs. When a chat has linked canvas activity, the agent fetches recent canvas run details and injects a `## Canvas activity since last turn` system block.
- Added prompt rules that allow at most one pointed question only at a real fork, with the requested examples and counterexamples. The rule explicitly forbids invented canvas activity and questions when there is no fork.
- Added an Echo client fetch for chat canvas activity and tests for the client path, context rendering, no-canvas silence, prompt rule coverage, and graph-level system prompt injection.

## Files Changed

- `echo/agent/agent.py`
- `echo/agent/echo_client.py`
- `echo/agent/tests/test_agent_graph.py`
- `echo/agent/tests/test_echo_client.py`

## QA Gates

- `cd echo/agent && uv run pytest -q`: passed, `102 passed, 4 warnings`.
- Focused checks also passed for:
  - `tests/test_agent_graph.py::test_canvas_activity_section_renders_run_details_and_truncates_detail`
  - `tests/test_agent_graph.py::test_canvas_activity_is_injected_into_first_model_invocation`
  - `tests/test_echo_client.py::test_list_chat_canvas_activity_uses_expected_path_and_limit`

## Notes

- Server and frontend were left untouched per the brief.
- `uv run ruff ...` was attempted for local formatting/checking, but `ruff` is not an `echo/agent` dependency, so the required pytest gate is the authoritative QA result.
- The activity block is omitted on empty or failed activity fetches. That keeps silence as the default when there is no real linked canvas signal.
