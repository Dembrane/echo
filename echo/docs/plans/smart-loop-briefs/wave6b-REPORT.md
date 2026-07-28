# Wave 6b Methodology UI Report

## What changed

- Added BFF methodology write/detail endpoints in `echo/server/dembrane/api/v2/bff/goals.py`:
  - `POST /api/v2/bff/methodologies`
  - `GET /api/v2/bff/methodologies/{id}`
  - `POST /api/v2/bff/methodologies/{id}/versions`
- Extended methodology row shaping in `echo/server/dembrane/methodologies.py` with full detail/history support and an additive `versions_count` field on list items.
- Added server coverage for methodology create, detail, owner edit, workspace-admin edit, and the seeded read-only `403 {"detail": "The dembrane methodology is read-only"}` gate.
- Added frontend methodology hooks under `echo/frontend/src/components/methodology/hooks`, including local fixture fallback.
- Added project settings methodology selection near the project goal. It lists visible methodologies, defaults to dembrane, shows framing text, and patches `methodology_version_id`.
- Added a workspace General tab Methodologies card below Assistant memory. It lists name/framing/history count, marks dembrane as built in/read-only, supports creating methodologies, and edits metadata/content/history note through the versions endpoint.
- Added Playwright coverage in `echo/frontend/e2e/methodology-settings.spec.ts` for project selection patching, workspace create/edit, and hiding edit on the seeded row. The spec requires `E2E_EMAIL`, `E2E_PASSWORD`, `E2E_WORKSPACE_ID`, and `E2E_PROJECT_ID`.
- Ran Lingui extract/compile so the new strings are in the catalogs.

## QA evidence

- `cd echo/server && uv run pytest tests/api/test_bff_goals.py -q`: 8 passed.
- `cd echo/server && uv run ruff check dembrane/api/v2/bff/goals.py dembrane/methodologies.py tests/api/test_bff_goals.py`: passed.
- `cd echo/server && uv run pytest tests/api/test_bff_goals.py tests/api/test_agentic_api.py tests/test_canvas_gather.py tests/test_agentic_worker.py -q`: 56 passed.
- `cd echo/server && uv run ruff check .`: passed.
- `cd echo/server && uv run pytest tests/api tests/agentic -q`: 104 passed, 4 failed. Failures match the known pre-existing failures from the brief:
  - `tests/api/test_chat_agentic_mode.py::test_initialize_chat_mode_supports_agentic`
  - `tests/api/test_conversation.py::test_summarize_conversation`
  - `tests/api/test_conversation_e2e.py::test_delete_conversation_endpoint`
  - `tests/api/test_tier_capacities_api.py::test_tier_capacities_pricing_shape_per_kind`
- `cd echo/frontend && ./node_modules/.bin/tsc --noEmit`: passed.
- `cd echo/frontend && ./node_modules/.bin/biome lint . --diagnostic-level=error`: passed.
- `cd echo/frontend && ./node_modules/.bin/lingui extract`: passed.
- `cd echo/frontend && ./node_modules/.bin/lingui compile --typescript`: passed.
- `cd echo/frontend && ./node_modules/.bin/playwright test e2e/methodology-settings.spec.ts`: 2 skipped because e2e credentials and scoped IDs are not set in this worker environment.

## Notes

- `pnpm` was not available directly in this shell. `corepack pnpm` attempted an interactive `node_modules` purge, so frontend gates used the checked-out `node_modules/.bin` tools to avoid package-manager writes.
- No git write commands were run.
- Did not touch the forbidden frontend areas: `src/routes/project/library/`, `src/components/canvas/`, or `src/components/chat/`.
