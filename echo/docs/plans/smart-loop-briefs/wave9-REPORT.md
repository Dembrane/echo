# Wave 9 Report: Portal Link Grounding

## Summary

Implemented a dedicated `getPortalLink` agent tool so hosts receive the actual
project participant portal link instead of invented dashboard navigation. The
tool reads the project language from existing project settings, falls back to
`en` for unset or `default`, and builds the link from the agent's configured
`ECHO_API_URL` without adding a required environment variable.

## Implementation Notes

- Added `portal_base_url_for_api_url`, `normalize_portal_language`, and
  `build_project_portal_link` in `echo/agent/echo_client.py`.
- Covered known environments in code:
  - `https://api.echo-next.dembrane.com/api` to
    `https://portal.echo-next.dembrane.com`
  - `https://api.dembrane.com/api` to `https://portal.dembrane.com`
  - `https://api.echo-testing.dembrane.com/api` to
    `https://portal.echo-testing.dembrane.com`
  - local API URLs to `http://localhost:5174`
- Kept this as a separate `getPortalLink` tool rather than adding
  `portal_link` to `getProjectSettings`. This keeps project settings focused on
  editable configuration, while the portal link is derived runtime context that
  depends on the deployment environment.
- Added a `## The dashboard` prompt section listing the real dashboard surfaces:
  Overview, Chats, Monitor, Library, Host guide, Report, Conversations, and
  Settings.
- Updated the prompt rule so portal-sharing answers must call `getPortalLink`,
  paste the actual link, and point hosts to Overview and Host guide as the
  durable home of the link and QR code.
- Updated `project-onboarding.md` step 5 so setup follow-up shares the actual
  portal link via `getPortalLink`.

## Verification

- Ran `cd echo/agent && uv run pytest -q`.
- Result: `79 passed, 4 warnings in 4.12s`.
- Added tests for:
  - environment-specific portal base URL mapping
  - portal link language fallback from `default`, empty, or missing language to
    `en`
  - `getPortalLink` tool output for a fake project
  - prompt assertions for the new dashboard section and anti-invention rule
  - tool availability in the agent graph

## Limitations

- `uv run ruff check .` could not run because `ruff` is not installed in the
  agent environment.
- Live echo-next verification is still pending deployment, as expected by the
  brief.
