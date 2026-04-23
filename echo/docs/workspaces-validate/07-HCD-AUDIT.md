# HCD audit — per-role walkthrough (2026-04-23)

Four subagents dispatched in parallel, each playing two roles. Surfaces audited: workspace settings, team settings, team admin page, home selector, usage card, discovery, access requests, FeatureGate.

**Roles covered:** Workspace Admin, Team Admin, Workspace Member, Team Member, Workspace Billing, Team Billing, Guest, Staff.

Raw output archived in the agent-run logs. Synthesised concerns below.

---

## Concerns clustered by theme

### 1. Tier signalling — every role
- Tier appears as a bare lowercase badge ("pioneer") on workspace header, team drawer, and selector cards.
- Matrix §1 requires a tagline everywhere the tier name appears.
- Only `UsageCard` (settings page) pairs the tier with its tagline. Everywhere else violates contract.

### 2. Engineer-speak leaks into user copy — Admin, Member, Guest
- "Your access" block renders raw policy strings (`member:manage`, `settings:manage`, `workspace:view_invoices`) as badges.
- Violates `STYLE_GUIDE.md` "user-facing copy, no technical strings" rule.

### 3. Disabled-not-hidden controls for non-admins — Member, Billing, Guest
- Privacy & defaults block shows description + logo URL + access radio in a greyed state for members, billing, and guests.
- Users wonder "is this broken?" rather than "this isn't for me."

### 4. Missing "Request upgrade" CTA on admin/billing surfaces — Admin, Billing
- Matrix §11 grants admin + billing the upgrade-request capability.
- UsageCard shows "Next tier" as text only — no CTA.
- No button anywhere else on the page either.

### 5. No invoices / payment method / billing surfaces — Billing (both)
- Policies `workspace:view_invoices`, `workspace:update_payment` granted but zero UI.
- Invite modal description promises "Sees usage, invoices, and payment" — overselling.

### 6. Team admin page misrepresents role model — Team Admin, Team Member
- Matrix cells collapse every role to "admin" or "—" — contract has four roles.
- Footer: "Access shown is derived from team role." Contradicts matrix §5 "Team-level access is direct-only. No derivation."
- Workspace column headers route to `/w/:id/projects` even when caller has no access → 403.
- "Guests" filter + count exposed at team level — matrix §5 says no team-level Guest.

### 7. Team-level rollups absent — Team Admin, Team Billing
- Matrix §8 requires team-level usage rollup.
- Matrix §5 grants team-billing `view_usage + view_invoices + update_payment`. All missing UI.
- Team Billing on `/t/:teamId` sees a people-matrix that's useless to them.

### 8. "Owners" language where matrix says "admins" — Team Admin
- `TeamSettingsRoute.tsx` alert: "Only team admins and owners can change team settings. You're a billing."
- Matrix §5 role model has Admin / Billing / Member — no Owner at team level.
- Also ungrammatical ("You're a billing") for billing role.

### 9. No "Leave workspace" action — Member, Guest
- Users can't remove themselves. No affordance.

### 10. Guest identity disappears inside a workspace — Guest
- Card says "guest of {team}"; settings page says role "Member" (is_external=true mapping is internal).
- UsageCard, privacy, pending invites, "Your access" all render for guests even though they have no handle on any of them.
- Shows them "Guests: 3 / 10" — they're one of those guests.

### 11. Private radio not tier-gated in UI — Admin
- Pioneer admin can click "Private" even though matrix §2 requires Innovator+.
- No inline hint; mutation would fail server-side with a confusing error.

### 12. Staff surfaces have no distinct identity — Staff
- Tier PATCH endpoint exists, no inline UI control.
- Matrix §11 `staff:can_set_tier` policy placeholder but no surface.
- Staff-only controls (when added) risk looking like admin controls.

### 13. Admin list not surfaced for members — Member, Team Member
- Matrix §11 "Ask a team admin" is abstract — no avatars, no names.

### 14. Invite-as-guest path hidden — Admin
- `sendInvite(workspaceId, email, role, true)` — `is_org_member` hardcoded true.
- No UI path to invite an external collaborator even though backend supports it.

### 15. Workspace column dead-clicks — Team Member
- Matrix cells link to routes that 403 for non-members.
- Discovery UI isn't reachable from the matrix — user has to navigate back to `/w`.

---

## Converged fix plan

Two tiers. Tier 1 is pattern-level + universal copy. Tier 2 is action affordances. Tier 3 is new surfaces (deferred).

### Tier 1 — Shipping now (pattern + copy)

| # | Fix | Root concern |
|---|---|---|
| A | Shared `TierBadge` component: `{tier}` + tagline everywhere the tier appears | 1 |
| B | Drop raw policy badges from "Your access"; replace with human sentences (or remove) | 2 |
| C | Hide Privacy & defaults when `!canEdit` (member / billing / guest see nothing instead of disabled fields) | 3, 10 |
| D | TeamSettings alert: "owners" → "team admins"; role fallback copy ("You're a billing") → gracefully labelled | 8 |
| E | TeamRoute: drop "derived from team role" footer, replace with matrix §5/§6 wording | 6 |
| F | TeamRoute: drop team-level "Guests" filter + count — matrix §5 has no team Guest | 6, 10 |

### Tier 2 — Shipping next commit (action affordances)

| # | Fix | Root concern |
|---|---|---|
| G | UsageCard: Admin + Billing see a "Request upgrade" primary button next to the "Next tier" line | 4 |
| H | "Your access": Member + Guest see a "Leave workspace" action | 9 |
| I | Guest persistent "Guest of {team}" chip in workspace header + hide UsageCard for guests | 10 |

### Tier 3 — Deferred / bigger surfaces

| # | Fix | Deferred because |
|---|---|---|
| J | Tier-gate the Private radio in WorkspaceSettingsRoute | Small — bundled with wizard rework when it lands |
| K | Team-level usage + billing rollup | Bigger surface; pairs with TeamRoute 3-view (S7) |
| L | Invoices / payment UI | No backend; matrix explicitly defers self-serve billing to v2 |
| M | Staff "global workspaces" view | Matrix explicitly defers staff audit log UI |
| N | Workspace-column click routing on team matrix | Pairs with S7 team admin 3-view rework |
| O | Invite-as-guest path | Pairs with the invite flow rework when wizard lands |
| P | Admin-chips "Ask these admins" for members | Pairs with deeper team directory rework |
| Q | Silent-rejection UX for members | Matrix locks silent rejection; can add pending-TTL as post-release |

Tier 3 items all land as follow-up sessions. Tier 1 + 2 account for ~80% of the user-visible concerns and can ship in two focused commits today.

---

## Decisions locked in this pass

- **"Your access" raw policy badges are removed** — simpler than writing a translation dict. Role badge alone suffices. Power-users who want detail can read the matrix.
- **Guests do not see UsageCard** at all — matrix §4 "View usage" row is ✗ for Guest. Matches contract.
- **Team-level Guest concept retires from UI** — not from `is_external` data (brief anti-goal). Just hide it in filters/counts.
- **Leave workspace** soft-deletes the caller's direct `workspace_membership`. Existing `DELETE /v2/workspaces/:id/members/:membership_id` should work with the caller's own membership_id, but last-admin protection applies.
