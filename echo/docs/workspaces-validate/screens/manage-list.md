# Screen 5 — Manage entity list

**Intent:** a table / list of things the admin manages, with inline actions per row and bulk actions on selection. Scan-first, act-on-row.

**Used by:** members (workspace + organisation), invites, workspace settings rows, projects on the organisation page, access requests, referral ledger entries.

**Reference:** brief pattern 1. Matrix doesn't spell out list shape — convention from `designer-return.html` Ask 1.

---

## Shape

```
┌─ Members ─────────────────────────────────────────────────────────┐
│                                                                    │
│  [Search…________________]        [+ Invite member]                │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ ◯ Anna Bakker       anna@… [hover]   Admin    Joined Apr 12 ⋯│ │
│  │ ◯ Ben Cortez       [hover for email] Member   Joined Apr 14 ⋯│ │
│  │ ◯ Cora Dubois      [hover for email] Billing  Joined Apr 15 ⋯│ │
│  │ ◯ Dan Eriksen      [hover for email] Guest    Invited Apr 17 ⋯│ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  Showing 4 of 4                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Row shape

- Checkbox (bulk select).
- Primary identifier — display name.
- Email shown only on hover (brand rule). Mobile: long-press or dedicated "Show details" action.
- Role chip — `Admin` / `Billing` / `Member` / `Guest` for workspace; `Organisation admin` / `Organisation billing` / `Organisation member` at organisation scope.
- Scope metadata — joined/invited date, source pill when informative (`direct` / `external`; derivation retires per matrix §6 so `inherited` pill goes away after walkback).
- Row menu `⋯` — change role, view workspaces (organisation page), remove / cancel invite.

## Affordances

- **Per-row menu (`⋯`):** opens a dropdown with the actions. Destructive items open screen 4.
- **Bulk actions bar:** appears at the top when rows are selected. Actions limited to idempotent ones — "Change role to Member" OK; "Delete" needs per-row confirm and belongs in row menu.
- **Click row:** opens a drawer with full detail (organisation page only — matrix view needs this for workspace access breakdown).

## Filter + sort

- Search: name + email substring match. Debounced.
- Filter chips: role, source, invited-vs-joined state.
- Sort: name (default), date, role. Single-column sort; remember selection via URL param (?sort=…).

## Empty states

- No rows at all: screen 6 empty-state embedded.
- No rows matching search: "No members match '{query}'. [Clear]" in the body where rows would be.

## Role awareness

- Admin / billing see role chips + full affordances.
- Member sees the list read-only (no bulk, no row menu, no invite button).
- Guest doesn't see this surface at all — navigation never leads there.

## Copy

- Header: noun in plural, not "Manage X". "Members", "Invites", "Projects".
- Action buttons: verb + noun, not noun alone. "Invite member", "Cancel invite", "Change role".
- Row menu items: short verb phrase. "Remove", "Change role", "Cancel invite", "View projects".
- Empty states: one-sentence invitation (pattern 6).

## Responsive

- Desktop: full table layout with all columns.
- Tablet: collapse email into hover + show role chip only.
- Mobile (<768): card-per-row layout. Matrix view degrades to list with a toast per `designer-return.html` Ask 1.

## Non-goals

- No drag-to-reorder — rows have a natural sort.
- No inline editing of role (opens row menu → screen 4 if destructive, otherwise straight switch via dropdown within the menu).
- No export-from-row — export is a full-list action (screen 7 readonly-data).
