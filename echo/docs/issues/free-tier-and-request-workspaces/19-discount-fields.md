# Discount fields (staff edit + member chip + CSV)

## What to build

Two new fields on the workspace collection:

- `type_discount` (enum: `scholarship` | `staff_discount`, nullable) — categorical label for the discount, used by finance + reporting.
- `percent_discount` (integer 0-100, nullable) — the percentage applied at the tier subscription price.

Both are nullable; null = no discount. Field-level Directus permissions: staff write, all workspace members read.

The approve dialog from Slice 10 already accepts these as optional inputs and writes them to the resulting workspace; this slice extends the staff surface so they can also be edited *outside* the approve flow, on a workspace's admin detail view (for adjusting discount terms on an existing workspace).

Workspace members see read-only chips on the workspace settings page when either field is set — transparency about their commercial terms.

The staff CSV export gains four columns at minimum: `tier`, `tier_expires_at`, `type_discount`, `percent_discount`.

**The discount fields are purely descriptive metadata.** No code path multiplies tier price by `(1 - percent_discount/100)` or otherwise enforces the discount. Finance applies the discount manually on invoices today. Future automated billing will likely own its own discount source of truth and the directus fields become a mirror.

## Acceptance criteria

- [ ] Workspace collection has `type_discount` and `percent_discount` fields with correct field-level permissions (staff write, members read).
- [ ] `type_discount` accepts only `scholarship` | `staff_discount` | null.
- [ ] `percent_discount` accepts integers 0-100 inclusive or null.
- [ ] The approve dialog writes both fields to the resulting workspace.
- [ ] A staff-only admin detail view allows editing both fields on an existing workspace outside the approve flow.
- [ ] Workspace settings page shows read-only chips for `type_discount` and `percent_discount` when set; nothing shown when null.
- [ ] CSV export includes `tier`, `tier_expires_at`, `type_discount`, `percent_discount` columns.
- [ ] No code path computes a price using the discount fields (verified by grep: tier subscription price and overage rate are not multiplied by these values anywhere).

## Blocked by

- Slice 10 (approve dialog exists as the primary write surface for discount fields).
