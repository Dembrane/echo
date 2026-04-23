# Screen 1 — Feature locked (role-aware)

**Intent:** render a gated feature surface or a gated entry point such that the user (a) knows it exists, (b) knows why it's not available to them now, (c) has a path forward appropriate to their role.

**Used by:** any surface where `has_policy(...)` fails due to tier. Tier-gated CTAs (export, API tokens, whitelabel, webhooks, private-workspace toggle, private-project toggle).

**Reference:** matrix §11 + designer Ask 4 (4B overlay + 4C modal).

**In code today:** `frontend/src/components/workspace/FeatureGate.tsx` + `UpgradeModal`. Live — reverse-documenting here.

---

## Anatomy

Two variants, used together:

### 4B — Hatched overlay (full-surface gate)

```
┌───────────────────────────────────────┐
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
│  ▓  🔒  Data export                  ▓ │
│  ▓                                   ▓ │
│  ▓  Available on innovator and up.   ▓ │
│  ▓  [Request upgrade]     [dismiss]  ▓ │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
└───────────────────────────────────────┘
```

- Do NOT mount the gated subtree underneath. Pure placeholder. Keyboard / focus traps inside gated UI are real bugs (round-2 audit H3).
- Whole surface is the click target → opens 4C.

### 4C — Upgrade modal (single feature)

```
┌─ Data export ────────────────────────────────┐
│                                              │
│  Download transcripts and report data.       │
│                                              │
│  Available on innovator and up.              │
│  [capacity matrix row here — matrix §1]      │
│                                              │
│  (admin-role)                                │
│  ┌─ Tell us what you need (optional) ──────┐ │
│  │                                         │ │
│  └─────────────────────────────────────────┘ │
│  [Cancel]                [Request upgrade]   │
│                                              │
│  (member-role)                               │
│  Ask one of your team admins to upgrade.     │
│  [Close]                                     │
└──────────────────────────────────────────────┘
```

## Copy

- Title: the feature name in sentence case, e.g. "Data export", "Whitelabel branding", "API access", "Webhooks", "Private workspace", "Private project".
- Benefit: one sentence, concrete. Not aspirational. "Download transcripts and report data." (not "Unlock powerful export capabilities.")
- Availability: "Available on {tier} and up." — **tier name lowercase**, per matrix taglines.
- Matrix reference row: inline tier-capacity row from matrix §1 pairs a name with a tagline.
- Admin CTA: "Request upgrade" (primary). Optional free-text textarea labeled "Tell us what you need" — submitted with the request.
- Member CTA: **no button**. Body copy reads "Ask one of your team admins to upgrade." Only a close affordance.
- Never "Successfully requested" — toast reads "Upgrade request sent." on admin submission.

## Role awareness

Role is resolved once at the gate, from `useV2Me` + workspace membership. Single boolean `canRequestUpgrade` (true for admin / owner / billing, false for member and guest). Billing sees the admin CTA per matrix §11.

## Variants

- **Already-met tier:** render children unchanged. No wrapper.
- **Tier unknown / loading:** render children (fail-open for UX); server-side gate still protects on action.
- **Send-in-progress:** disable the primary button + show `DembraneLoadingSpinner` with `alwaysDembrane`.
- **Send-success:** close modal, toast "Upgrade request sent.", in-app notification `UPGRADE_REQUEST_SENT` fires.
- **Send-fail:** toast the error; textarea state preserved so the user can retry.

## Accessibility

- Overlay is `role="button"` with `aria-label="Locked feature: {featureName}. Request upgrade."`.
- Modal is a focus-trap via Mantine's `<Modal/>`.
- `Esc` closes the modal.

## Non-goals

- No mailto on the member view — matrix §11 locks this.
- No "Ask admin" button — matrix is explicit the friction is the gate.
- No upgrade matrix comparison *inside* the modal beyond the single-row capacity line. The full tier-compare surface lives on the billing tab (screen 7 readonly-data + flow `admin-workspace-settings`).
- No hover tooltip version — tooltips read as marketing pressure (Ask 4 D9).
