# 3-day pre-warning email + `TIER_EXPIRING_SOON`

## What to build

A workspace admin receives a pre-warning email 3 days before their workspace's `tier_expires_at` so the downgrade is never a surprise. Add a new `TIER_EXPIRING_SOON` event code (audience: workspace admins + billing) and a new `pre_warning_sent` boolean field on the workspace (default false) to deduplicate.

An hourly Dramatiq cron actor finds workspaces where `tier_expires_at IS NOT NULL AND tier_expires_at BETWEEN now() AND now() + interval '3 days' AND tier != 'free' AND pre_warning_sent = false`. For each:

1. Emit `TIER_EXPIRING_SOON` to admins + billing (in-app + email) with the expiry date and an upgrade-prompt CTA.
2. Set `pre_warning_sent = true`.

If staff later extends or clears `tier_expires_at`, the workspace's `pre_warning_sent` is reset to false so a future shortening can re-warn. (Land this as a small hook on workspace tier updates.)

A new email template for `TIER_EXPIRING_SOON` extends the existing layout, includes the formatted expiry date, and surfaces the path to upgrade.

## Acceptance criteria

- [ ] Workspace collection has a new `pre_warning_sent` boolean field, default false.
- [ ] `TIER_EXPIRING_SOON` event code is registered (audience: workspace admins + billing).
- [ ] An hourly cron emits the event exactly once per workspace when it enters the 3-day window.
- [ ] After emitting, `pre_warning_sent` is set to true; the same workspace does not re-warn unless the date changes.
- [ ] Setting `tier_expires_at` to null or extending it past 3 days resets `pre_warning_sent` to false.
- [ ] The email template exists (HTML + TXT) and renders with the expiry date and upgrade CTA.

## Blocked by

- Slice 15 (`tier_expires_at` field and expiry infrastructure exist).
