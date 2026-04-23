# Screen 7 — Read-only data view

**Intent:** surface data-dense information for the user to scan, filter, and optionally export. No edit affordances in the primary surface — editing happens via a row drill-in that opens screen 5 or an inline form.

**Used by:** usage rollup (project / workspace / team), referral ledger, member list in view-only contexts, audit log (post-release), tier capacity matrix in billing tab + upgrade modal, access request history.

**Reference:** matrix §1 (capacity matrix visible in product), §8 (usage rollups at project / workspace / team), §10 (referral ledger), brief pattern 7.

---

## Shape

Depends on the data. Three sub-variants:

### Variant A — Scalar rollup

```
┌─ Usage · {workspace} · April ─────────────────┐
│                                                │
│  Audio hours      9.1 / 10                     │
│  Seats            4                             │
│  Guests           1 / 2                         │
│  Projects         3                             │
│                                                │
│  (admin/billing only)                           │
│  Overage forecast at current rate: €0          │
│  Next tier:    pioneer (€200/mo · 25 hours)    │
│                                                │
│  [Export CSV] (innovator+)                      │
└────────────────────────────────────────────────┘
```

- Raw numbers for everyone (matrix §8: members see raw).
- €-forecasts + tier recommendations: admin + billing only.
- Export gated per tier (screen 1 when gated).

### Variant B — Table

Column headers, row-per-entity. Filter chips above. Page footer with count + export.

Used by: referral ledger, member list (read-only), access request history.

### Variant C — Matrix

Users × workspaces × (role). Filter on role, source (direct vs derivation retires post-walkback). Click cell → drawer with detail + row-menu actions (if admin).

Used by: team admin page (Ask 1). Hidden ≤768px with toast "Switch to list view" (`designer-return.html`).

## Rollup levels (matrix §8)

The same data shape renders at three scopes. Pick by route:

| Scope | Route pattern | Data shown |
|---|---|---|
| Project | `/w/:wsId/projects/:pid` overview tab | Hours consumed by conversations in this project, current cycle. |
| Workspace | `/w/:wsId/settings?tab=billing` | Total hours + seat count + guest count, current cycle + per-project breakdown. |
| Team | `/t/:orgId/usage` | Aggregate across workspaces. Table: ws_name / tier / hours / status / aggregate spend. |

## Role differentiation (matrix §8)

| Field | Member | Admin | Billing | Guest |
|---|:-:|:-:|:-:|:-:|
| Raw hours / seats / projects | ✓ | ✓ | ✓ | — |
| Cycle start date | ✓ | ✓ | ✓ | — |
| Overage forecast (€) | — | ✓ | ✓ | — |
| Next-tier recommendation | — | ✓ | ✓ | — |
| Request upgrade CTA | — | ✓ | ✓ | — |
| Export CSV (innovator+) | — | ✓ | ✓ | — |

## Tier capacity matrix surface

Same component rendered in two places:
- Workspace billing tab (`?tab=billing`) — full matrix with current tier highlighted (brand: Royal Blue border, not bold).
- Upgrade modal (screen 1 4C) — the single row for the requested tier, linked to the full matrix on the billing tab.

Source of truth: matrix §1. Render from a single i18n-tableable component so taglines + price + seats + hours + guests all pull from one file. No duplication in copy.

## Export

- CSV export button in the card header, right-aligned.
- Tier-gated via screen 1 if below innovator.
- File naming: `{scope}-usage-{yyyymm}.csv` / `members-{workspace}-{date}.csv`.
- No XLSX. No PDF. CSV is the interop contract.

## Copy

- Header: noun ± scope. "Usage · {workspace} · April". "Members".
- Units spelled out on first occurrence: "9.1 hours" not "9.1". Abbreviate on repeats in the same card.
- Currency: symbol-prefix (`€200`) per European convention.
- Date format: `Apr 12` / `2026-04-12` depending on locale. Never `04/12/26`.

## Accessibility

- Tables have `<caption>` elements or an equivalent `aria-label`.
- Sort state announced via `aria-sort`.
- Cells linking to another view use actual `<a>` tags, not clickable `<tr>`.

## Non-goals

- No inline editing. Open a drawer or route to edit.
- No charts (`@mantine/charts` banned per CLAUDE.md). If a chart is truly useful, pick a better library when it's worth the lift.
- No pagination on rollup views this release — scales fine to hundreds of projects; paginate when it doesn't.
