# `free` tier exists in the matrix

## What to build

Add the `free` tier to the canonical tier matrix and supporting helpers. After this slice, every code path that asks "what's tier X's capacity?" or "what's the order of tiers?" returns correct answers for `free`, and `pilot` no longer hard-blocks anywhere. The frontend's Tier union and tier-order constant include `free` too, so tier-aware components render it without errors.

`free` is the permanent floor — 1 seat, 1 hour lifetime cap, no overage, no expiry. It is *never* selectable in any user-facing flow (request wizard, tier picker); it exists for onboarding and for downgraded states.

This slice also adds the two helpers ADR 0001 depends on: `tier_allows_overage(tier) -> bool` and `compute_usage_gates(tier, hours_lifetime, hours_this_month) -> UsageGates`. The legacy `is_hard_blocked()` keeps its signature but now always returns false (deprecated, kept for call-site compat).

## Acceptance criteria

- [ ] `free` is the lowest-ordered tier in the canonical TIER_ORDER (backend and frontend each).
- [ ] Tier lookup for `free` returns 1 included seat, 1 included hour, no overage, hard_block_on_hours=false.
- [ ] `tier_allows_overage()` returns false for `free` and `pilot`, true for `pioneer`/`innovator`/`changemaker`/`guardian`.
- [ ] `is_hard_blocked()` returns false for every tier; pilot no longer rejects host actions at the cap.
- [ ] `compute_usage_gates(tier, hours_lifetime, hours_this_month)` returns `over_cap_active`+`uploads_locked` true exactly when (tier is free/pilot) AND (hours_lifetime >= included_hours).
- [ ] Unit tests exhaustively cover every tier × under/at/over cap × known/unknown tier.
- [ ] Frontend renders the `free` tier label, tagline, and short-capacity string correctly anywhere a tier name appears.

## Blocked by

None — can start immediately.
