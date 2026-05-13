# Host upload section gating

## What to build

The host upload section reads `usage_gates.uploads_locked`. When true, its dropzone subtree is replaced with an upgrade-prompt card (not a disabled-button-with-tooltip — full replacement). The card explains that the workspace has reached its cap and offers a path to upgrade.

Enforcement is purely UI. The backend upload endpoints stay open because they're shared with the participant portal recording path, and recording must never fail.

## Acceptance criteria

- [ ] When `uploads_locked` is true, the host upload section renders an upgrade-prompt card.
- [ ] When `uploads_locked` is false, the host upload section renders the dropzone as today.
- [ ] The upgrade card's CTA leads to the workspace's upgrade request flow.
- [ ] Participant portal recording and participant text upload remain unaffected.
- [ ] Pioneer+ workspaces never render the upgrade card regardless of monthly usage.

## Blocked by

- Slice 3 (frontend reads `uploads_locked` from the workspace usage hook).
