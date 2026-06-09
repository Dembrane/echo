# `tier_expires_at` + expiry cron + `TIER_EXPIRED`

## What to build

Add a `tier_expires_at` (nullable timestamp) field to the workspace collection. Staff can set this at approval time (via the dialog from Slice 10) to time-bound a tier grant — most often used to bound pilot to 1 month, occasionally to bound a paid-tier promo.

An hourly Dramatiq cron actor finds workspaces where `tier_expires_at IS NOT NULL AND tier_expires_at < now() AND tier != 'free'`. For each match, in a single transaction:

1. Set `tier = 'free'`.
2. Populate `downgraded_at = now()` and `downgraded_from_tier = <previous tier>` (the existing fields the 7-day downgrade banner reads).
3. Clear `tier_expires_at`.
4. Call the existing downgrade-effects helper so policies (whitelabel, api_access, webhooks, etc.) revert.
5. Emit `TIER_EXPIRED` (in-app + email) to workspace admins + billing.

Existing pilot workspaces with `tier_expires_at IS NULL` are skipped (grandfathered) — only newly-granted pilots set the date. Re-running the actor on already-downgraded rows is a no-op.

A new email template for `TIER_EXPIRED` extends the existing layout and follows the `tier_downgraded` template's pattern.

## Acceptance criteria

- [ ] Workspace collection has a new `tier_expires_at` field (nullable timestamp), staff-writable.
- [ ] The approve dialog from Slice 10 writes `granted_tier_expires_at` into the resulting workspace's `tier_expires_at`.
- [ ] An hourly cron downgrades expired workspaces in a single transaction with the steps above.
- [ ] The cron skips workspaces where `tier_expires_at IS NULL`.
- [ ] `TIER_EXPIRED` emits to workspace admins + billing (in-app + email).
- [ ] The email template for `TIER_EXPIRED` exists (HTML + TXT) and renders with the previous tier name.
- [ ] Re-running the cron after a successful downgrade is idempotent (no duplicate notifications).
- [ ] Pilot → free downgrade does NOT re-stamp `is_over_cap` on existing conversations (paid-trial content stays readable).

## Blocked by

- Slice 1 (`free` tier exists)
- Slice 12 (`TIER_EXPIRED` event code was pre-registered)
