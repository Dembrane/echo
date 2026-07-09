# Wave 31 Report: canvas UX

## Summary

- Added frontend support for `?prefill=` on `/chats/new` and existing chat routes. The value is sanitized to plain text, capped at 500 characters, placed in the composer only, and consumed from the URL so reloads do not reapply it.
- Updated canvas “new chat about this canvas” actions to use the prefill deep link instead of router state that auto-sends in agentic chat.
- Expanded canvas version access from a fixed latest-only strip to an initial 10 versions with “Show more versions” loading 25 more at a time. Versions are sorted newest first and labeled with date plus time.
- Unified the canvas frame, empty/error states, iframe surface, and generated document logo band/root background on the parchment ground token.

## Validation

- `cd echo/frontend && ./node_modules/.bin/tsc --noEmit`
- `cd echo/frontend && ./node_modules/.bin/biome lint . --diagnostic-level=error`
- `cd echo/frontend && ./node_modules/.bin/lingui extract`
- `cd echo/frontend && ./node_modules/.bin/lingui compile --typescript`
- `cd echo/frontend && ./node_modules/.bin/vitest run src/components/chat/prefill.test.ts`

All passed.

## Notes

- `pnpm` was not directly on PATH in this terminal, and `corepack pnpm exec` attempted an install that was blocked by approved-build policy. I used the existing checked-out `node_modules/.bin` tools instead.
- The server still determines how many generations are returned for a larger `limit`; the frontend now keeps increasing that limit until fewer than requested are returned.
