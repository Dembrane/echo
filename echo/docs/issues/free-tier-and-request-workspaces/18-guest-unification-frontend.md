# Guest unification — frontend

## What to build

Frontend components display one unified seat banner instead of separate seat + guest banners. The seat-cap banner reads "X / Y seats used" — one number, one cap, no parallel guest line.

The usage card may show a small "(N members + M guests)" breakdown chip below the seat bar — the breakdown is informational only and is NOT a separate cap. The unified cap is the only enforcement.

Other surfaces — organisation usage rollup, tier capacity matrix, admin settings page (including its CSV export), workspace settings page — drop their guest_cap columns, probes, and hit-state flags. Anywhere the UI previously rendered "X of Y guests used", it now folds into the unified seat count.

## Acceptance criteria

- [ ] The seat-cap banner shows a single number regardless of guest count.
- [ ] The usage card shows a "(N members + M guests)" breakdown chip below the seat bar.
- [ ] The seat-cap banner does not appear in two variants ("seats" + "guests") any more.
- [ ] Organisation usage rollup drops guest_cap columns.
- [ ] Tier capacity matrix drops the guest-cap row.
- [ ] Admin settings page drops guest_cap and guest_cap_hit columns from the table and CSV export.
- [ ] Workspace settings page drops the local guest-cap probe; it relies on the unified seats check.

## Blocked by

- Slice 17 (backend has unified the seat pool).
