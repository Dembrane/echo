# External as a first-class workspace role

## Status
accepted (2026-05-20)

## Context
Workspace membership has historically modelled two orthogonal axes on every `workspace_membership` row: `role` (`owner`/`admin`/`member`/`billing`) and `is_external` (boolean). A "guest" was the pair `is_external=true` + `role='member'`, with policy lookups routed through an `effective_workspace_role()` helper that swapped `is_external=true` to a dedicated `guest` preset at read time. The flag was a denormalised statement of "this user has no `org_membership` row in this org."

That shape produced four real defects:

1. **Display drift.** The members page rendered the disk role (`member`) next to a separate `Guest` badge, so admins saw "Member" as the role for someone the system was treating as a guest in every policy check.
2. **Seat-count misreporting.** The `/v2/workspaces/{id}/usage` response field `seat_count` was computed as members-only (excluded `is_external=true` rows). The progress bar numerator therefore underreported by `guest_count`. A repro with admin + member + guest on Pioneer showed `2 of 5` instead of `3 of 5`, and a parenthetical "1 member + 1 guest" string that implied the buckets were unrelated. The unified-seat-pool work shipped in May 2026 had fixed the *enforcement* path (`assert_can_add_seat`) but not the *reporting* path.
3. **Role-clamp logic scattered.** The invite endpoint had a literal `if not body.is_org_member and role in ("admin","owner","billing"): 400` branch with a string-formatted error. Every future read site had to remember to consult `effective_workspace_role()` or risk leaking member-level capabilities to guests.
4. **API ambiguity.** `POST /v2/workspaces/{id}/invite` accepted both `role` and `is_org_member`, which could disagree. The endpoint had to coerce one to match the other and surface a domain error for combinations the schema couldn't catch.

We considered three reshape options:

- **Path B — Relabel only.** Keep the flag, change every "Guest" string to "External," lock the dropdown, fix the usage-endpoint count. Smallest blast radius, no schema migration. Rejected because the root cause (two fields encoding the same fact) stays in place — every future feature is one more chance to re-introduce the drift.
- **Path A with strict coupling.** Promote `external` to a stored role and treat `org_membership` presence as the source of truth (or vice versa), with triggers/hooks keeping the two in sync. Rejected because Directus has no native hook mechanism for this and the cascade would let a workspace-page dropdown delete an `org_membership` row affecting all of that user's other workspaces in the org — a footgun disproportionate to the rarity of the transition.
- **Path A with loose coupling.** Promote `external` to a stored role; drop `is_external` entirely; maintain the invariant (`role='external'` ⟺ no `org_membership` row) only at write-time at each explicit endpoint; no read-time derivation, no reconciler. Chosen.

The repo is pre-production for this surface area, so the migration cost of dropping a column and renaming response fields is acceptable.

## Decision

- **`workspace_membership.role` enum gains `external`.** Final set: `{owner, admin, member, billing, external}`. The `is_external` column is dropped. Every read site that previously consulted the flag (or the `effective_workspace_role()` helper) reads `role` directly. The helper is deleted.

- **Role hierarchy places external at the bottom.** `external < member < billing < admin < owner` in `ROLE_HIERARCHY`. Externals cannot invite anyone (preset has no `member:invite`). An admin can invite externals; an external can only ever be assigned `role='external'`.

- **Invariant is maintained at write-time only.** `role='external'` ⟺ no `org_membership` row for the user in this org. The invite endpoint, the accept endpoint, and the org-membership endpoints each enforce this when they write. There is no read-time fallback derivation, no startup reconciler, and no Directus trigger. If state drifts in a degenerate scenario the fix is manual.

- **The role dropdown is not a cross-boundary lever.** On a non-external row the dropdown shows `Admin / Billing / Member` (no `External` option). On an external row the dropdown is locked, showing `External` only. To convert an external into an org member the admin goes to the org settings page, adds them to the org, returns to the workspace, removes the external row, and re-invites as `member`. The workspace UI never has a single button that mutates `org_membership`.

- **The invite endpoint takes `role` directly.** `POST /v2/workspaces/{id}/invite` body becomes `{ email, role }`. `is_org_member` is dropped. The endpoint branches on `role == 'external'` to decide whether to write `org_membership`. The `workspace_invite` table's `include_org_membership` column is replaced with `role`; the accept path reads it.

- **The policy preset `guest` is renamed to `external`.** Content is unchanged from the existing `guest` preset: `project:read`, `project:update`, `conversation:read`, `chat:use`, `report:view`, `report:generate`. Explicit denials (anything outside that allowlist) are preserved by being absent from the preset.

- **Seat counting is unified by role.** `_SEAT_ROLES` in `seat_capacity.py` becomes `{owner, admin, member, billing, external}`. `compute_effective_seat_state` returns `(seats_used, member_count, external_count)` keyed on role only. The `assert_can_add_guest` and `assert_can_add_member` aliases are removed — call sites call `assert_can_add_seat` directly.

- **Usage response field semantics are corrected, not preserved.** `WorkspaceUsageResponse.seat_count` is repurposed to mean `members + externals` (the bar numerator). New fields `member_count`, `external_count`, and `pending_count` carry the breakdown. `guest_count` is removed. The same rename propagates to `admin.py` workspace rollups and `orgs.py` org rollups so the names align across the codebase.

- **The billing card displays the unified pool truthfully.** A single progress bar above three sub-rows (`Members`, `Externals`, `Pending invites`). Rows with count zero are hidden. The "1 member + 1 guest" parenthetical is removed.

## Consequences

- **`role='external'` is the single source of truth for "outside the org."** A future reader looking at a `workspace_membership` row no longer has to consult a second column or a helper function to know how the user is treated by the policy engine. The cost is that every existing read site that referenced `is_external` had to be touched in one pass — covered by the rename PR, but the grep needs to be exhaustive (`is_external`, `effective_workspace_role`, `guest_count`, `guest`, `Guest`).

- **The "user is in our org but external to this workspace" case is unrepresentable by design.** With Path A loose-coupled, the invariant says you can't have both. If product ever wants "limited access for an org colleague," that's a separate role (e.g., `viewer`) — it is not a use of `external`. This is intentional; conflating the two was part of the original confusion.

- **Promoting external → member requires a re-invite, losing per-row state.** An external who is later added to the org keeps `role='external'` until an admin removes them and re-invites as member. Any per-row state on `workspace_membership` (custom_policies extras, future fields) is lost in the re-invite. We accept this because (a) the transition is rare, (b) it forces the cross-boundary action to be deliberate, and (c) building a non-destructive "convert" endpoint would have to handle the cross-table transaction we explicitly chose to avoid putting behind a dropdown.

- **The `seat_count` field name now means something different than it did in older API consumers.** Pre-prod for this surface, so backward compatibility is not a concern. Anyone reading `seat_count` after this change gets the unified total (members + externals); they previously got members-only. The Pydantic schema change forces TypeScript consumers to recompile, so silent breakage is bounded.

- **The 400 "Guests can't be admins…" error path is removed.** `POST /v2/workspaces/{id}/invite` now rejects out-of-enum roles at the schema layer (422). The domain-level error message disappears; callers that were parsing it for branching logic need to handle the 422 instead. No known internal callers do this.

- **The role enum is bigger; some role-aware switch/if statements need an `external` arm.** Backend (`policies.py`, role-hierarchy maps, `_SEAT_ROLES`, `inheritance.get_effective_members`) and frontend (`roles.ts` `displayRole`/`roleColor`, role-select components, badge logic). The compiler/type-check catches most but not all; a deliberate sweep is needed at implementation time.

- **i18n surface grows by one term per locale.** Every "Guest"/"Guests" string is replaced with "External"/"Externals" in en, nl, de, fr, es, it. `pnpm messages:extract` → translate → `pnpm messages:compile` is on the critical path for any deploy that ships this change.
