# Workspace `usage_gates` exposed in API + hook

## What to build

The workspace usage endpoint returns a `usage_gates` block describing whether the workspace's host upload section should be locked and whether it is currently in an over-cap state. Pioneer+ never sets the gates because they allow overage; free + pilot set them when lifetime hours meet or exceed the included cap. The frontend's workspace usage hook surfaces these flags so the upload section, banners, and CTA components can react.

The two cap regimes split here:
- **Free + pilot:** lifetime cap, bucket never refills. The gate compares `audio_hours` (all-time).
- **Pioneer+:** monthly cap, bucket resets on the 1st. The gate never fires here regardless of monthly usage.

## Acceptance criteria

- [ ] Workspace usage response includes `usage_gates: { uploads_locked, over_cap_active, upgrade_cta_tier }`.
- [ ] For free + pilot: both flags are true exactly when lifetime audio hours meet or exceed the included cap.
- [ ] For pioneer+: both flags are always false regardless of monthly or lifetime usage.
- [ ] `upgrade_cta_tier` names the next tier up from the current one (e.g. free → pilot? or → pioneer? — implementer chooses based on what the upgrade prompt should actually offer).
- [ ] Frontend workspace usage hook exposes these flags to consumers.
- [ ] Unit tests cover the matrix (each tier × under/at/over cap).

## Blocked by

- Slice 1 (`compute_usage_gates` helper must exist).
