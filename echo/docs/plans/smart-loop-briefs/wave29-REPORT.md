# Wave 29 Drive-By Insight Sweep Report

## Summary

- Added a transcript scroll-to-bottom affordance on the conversation transcript view. The shared scroll button now uses a Phosphor icon, while existing project chat scroll controls keep their current behavior.
- Replaced hardcoded canvas cadence copy with labels derived from actual cadence config. Static canvases now say they do not update on their own, and active loops show the configured cadence.
- Added `?chunk=<id>` support alongside existing `#chunk-<id>` anchors, moved chunk scrolling into a tested hook, and updated chat reference/source links to emit chunk anchors only when chunk-level data is present.
- Made canvas fullscreen use the full dynamic viewport with a 100dvh/100dvw wrapper and iframe, removing the previous padded/dead-band layout.
- Added a participant portal "ready to record" confirmation step after name/details entry. `skipOnboarding=1` still starts recording directly.

## Files Changed

- `echo/frontend/package.json`
- `echo/frontend/pnpm-lock.yaml`
- `echo/frontend/src/components/canvas/CanvasFrame.tsx`
- `echo/frontend/src/components/canvas/cadenceLabel.ts`
- `echo/frontend/src/components/canvas/cadenceLabel.test.ts`
- `echo/frontend/src/components/chat/CanvasSuggestionCard.tsx`
- `echo/frontend/src/components/chat/References.tsx`
- `echo/frontend/src/components/chat/Sources.tsx`
- `echo/frontend/src/components/chat/conversationReferenceLinks.ts`
- `echo/frontend/src/components/common/ScrollToBottom.tsx`
- `echo/frontend/src/components/conversation/ConversationTranscriptSection.tsx`
- `echo/frontend/src/components/conversation/useChunkAnchorScroll.ts`
- `echo/frontend/src/components/conversation/useChunkAnchorScroll.test.tsx`
- `echo/frontend/src/components/participant/ParticipantInitiateForm.tsx`
- `echo/frontend/src/locales/*.po`
- `echo/frontend/src/locales/*.ts`
- `echo/frontend/src/routes/project/canvas/CanvasRoute.tsx`

## QA Gates

- `cd echo/frontend && npx tsc --noEmit`: passed.
- `cd echo/frontend && ./node_modules/.bin/biome lint . --diagnostic-level=error`: passed, `Checked 447 files`.
- `cd echo/frontend && ./node_modules/.bin/lingui extract`: passed.
- `cd echo/frontend && ./node_modules/.bin/lingui compile --typescript`: passed.
- `cd echo/frontend && ./node_modules/.bin/vitest run src/components/canvas/cadenceLabel.test.ts src/components/conversation/useChunkAnchorScroll.test.tsx --environment jsdom`: passed, `2 passed`, `5 tests passed`.
- `git diff --check`: passed.

## Screenshots

No screenshots were captured. The changed views depend on live BFF/participant portal data and the brief said not to block on the full podman stack.

## Notes

- Scope stayed within `echo/frontend` plus this report. No `echo/server`, `echo/agent`, or `echo/directus` files were changed.
- `pnpm` is not directly on PATH in this shell; dependencies were added through `corepack pnpm`. The install completed package/lock updates but returned pnpm's ignored-build-scripts warning, so QA commands were run through local binaries and `npx`.
