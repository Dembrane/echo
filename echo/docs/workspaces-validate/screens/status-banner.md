# Screen 2 — Status banner (3 intrusion levels)

**Intent:** tell the user about a state they need to know, at the lightest intrusion level that still works. Three levels, each appropriate to a different urgency.

**Used by:** quota/usage, Pilot hard-block, post-downgrade in-workspace banner, suspension notice (future), workspace soft-delete pending, partner handoff pending, role change first-visit confirmations.

**Reference:** matrix §3 (post-downgrade 7-day banner), §8 (usage meter), brief §"The 7 canonical screen patterns" pattern 6.

---

## The three levels

### Level 1 — Inline indicator (passive)

A chip / dot / sparkline adjacent to the relevant data. User sees it only if they're looking.

Examples:
- "9 / 10 hours used" chip on the workspace usage widget.
- Yellow dot next to a workspace name in the switcher when at 80% hours.

Copy shape: raw numbers or a short label. No CTA. No dismissal — it reappears when state holds.

### Level 2 — Banner (noticed)

Persistent strip under the header, inside a context (workspace, team). Visible on every route within the context until dismissed or until the state clears.

```
┌─────────────────────────────────────────────────────────────┐
│  ⚠  Approaching Pilot limit — 9 / 10 hours used.            │
│                       [See usage]  [Upgrade]    [dismiss ×] │
└─────────────────────────────────────────────────────────────┘
```

- Background: Golden Pollen `#ffd166` for warning; Royal Blue tinted for info; Cotton Candy `#ff9aa2` only for *error* states (tight scope — rarely used here).
- Copy: subject + one-line reason + up to two CTAs (one primary text button, one secondary).
- Dismissible. **Returns on next route load if state still holds for a hard-urgency case** (e.g. downgrade confirmation banner auto-returns when admin attempts a frozen feature — matrix §3).
- Never stacked. If multiple banners compete, show the highest-severity one only (brief §UI Rules).

### Level 3 — Modal (blocks work)

Full overlay with a primary path out. Used only when continuing would be misleading or destructive.

```
┌─ Pilot limit reached ──────────────────────────┐
│                                                │
│  You've used all 10 hours of the pilot.        │
│                                                │
│  Host-side tools (chat, reports, analysis,     │
│  exports) are paused.                          │
│                                                │
│  Recording keeps working — your participants   │
│  are unaffected.                               │
│                                                │
│  [Go to usage]           [Request upgrade]     │
└────────────────────────────────────────────────┘
```

- Only for hard blocks. Pilot 10h cap is the primary one this release.
- Participant-reassurance line is non-negotiable when the block affects host-side only (matrix §8).
- Escape hatch = "Go to usage" (level 2 view), never "Dismiss".
- Appears on host-side routes only. Participant portal routes never render this.

## Picking the level

- Data is true but not urgent → **Level 1**. Default.
- User should change behavior soon → **Level 2**. Quota warnings, post-downgrade notice.
- Continuing would be misleading or lost work → **Level 3**. Hard blocks only.

## Copy rules

- Lead with the state, not the cause. "Approaching Pilot limit" not "Please be aware your usage has reached 90% of the pilot plan."
- Numbers are concrete. "9 / 10 hours" not "nearly full."
- Participant-reassurance line on any host-side block: "Recording keeps working — your participants are unaffected." Same copy every time — users learn to scan for it.
- Never "Successfully upgraded" — post-upgrade state is communicated via L2 banner "Upgraded to {tier}. New limits apply."
- Never "Please" / "Sorry for the inconvenience."

## Email mirrors

Each on-screen banner has an email twin for the same event. Email is always a lower urgency than the in-app surface — emails are asynchronous, so they don't modal. Matrix §3 downgrade email is an L2-equivalent.

## Non-goals

- No animated banner entrance. Layout shift is worse than a static surface.
- No "snooze for 7 days" — dismissal is per-session. Hard-urgency banners auto-return on frozen-feature-attempt (matrix §3).
- No stacked banners. One at a time.
