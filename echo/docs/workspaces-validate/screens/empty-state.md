# Screen 6 — Empty state / first encounter

**Intent:** welcome the user into a space that doesn't have data yet, give them exactly one thing to do next, and make the emptiness feel like an invitation rather than a hole.

**Used by:** new workspace → no projects; new project → no conversations; no members invited yet; no usage data yet; first-time onboarding-solo landing; access requests list with none pending; etc.

**Reference:** brief pattern 3. Brand `STYLE_GUIDE.md` §"UI copy patterns" → Empty states. Matches the Everyman + Explorer archetype — warm, unpretentious.

---

## Shape

```
┌────────────────────────────────────────────┐
│                                            │
│          [illustration, optional]          │
│                                            │
│          No projects yet.                  │
│          Start your first one.             │
│                                            │
│                [New project]               │
│                                            │
└────────────────────────────────────────────┘
```

- Centered vertically within its container. Don't make the user scroll past whitespace to find the CTA.
- Illustration (when used): from `brand/illustrations/` — real, hand-drawn quality per brand. Never stock. Never AI-generated.
- Headline: two lines max. First = state. Second = invitation.
- One primary action. If no action is role-appropriate (member landing on a full-admin-only surface), show a read-only friendly line instead — e.g. "A organisation admin will set this up."

## Copy patterns (brand guide verbatim)

- "No conversations yet. Start your first one." (not "You have not created any conversations")
- "No projects yet. Start your first one."
- "No organisation members here yet. Invite someone."
- "Nothing to see yet — come back once your organisation runs a session."

Never:
- "You haven't…" — focuses on absence, not opportunity.
- "Please create a project." — never "please".
- "Click here to…" — never "click here".

## Role + tier awareness

- **Can do the thing** → primary CTA button.
- **Can't do the thing because of role** → read-only explanatory line: "Only organisation admins can invite members." No CTA. No "ask an admin" link — matrix §11 pattern.
- **Can't do the thing because of tier** → show screen 1 (feature-locked) variant, NOT this screen. Empty + gated is not the same mood as empty + ready.

## Event-driven platform context

Per `brand/STYLE_GUIDE.md` §"Platform context": "ECHO is event-driven, not daily-use software." Empty states should therefore:
- Remind the user where they left off when they return between events.
- Celebrate completed analyses (e.g. "Report ready — {project}") on re-entry rather than a generic "Welcome back".
- Not scold for inactivity.

## Illustrations

Use sparingly. A full empty-state card in a modal doesn't need one. A top-of-page empty state for a fresh workspace might warrant a small illustration.

Principles (brand):
- Warmth over polish.
- Groups over individuals.
- Candid over posed.

## Variants

- **Initial empty:** no data has ever existed. Action-primed.
- **Filtered empty:** data exists but not for current filter. "No projects match '{query}'. [Clear filters]"
- **Loading:** render `DembraneLoadingSpinner alwaysDembrane` instead of the empty state. Not a skeleton. Spinner is fine for short loads; skeleton for >500ms lists.
- **Error empty:** data failed to load. "Can't load projects right now. [Retry]" — no generic "Something went wrong".

## Non-goals

- No "Get started" splashy onboarding with multiple CTAs.
- No tooltip tutorials.
- No "X days since your last session" shame copy.
- No "Why don't you try {feature}?" suggestions — the user asked for this surface; don't divert.
