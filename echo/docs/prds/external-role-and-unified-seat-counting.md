# External as a workspace role, and unified seat counting that actually counts

## Problem Statement

Workspace hosts who invite outside collaborators (consultants, partners, interviewees, anyone not in their organisation) hit four user-visible defects today:

1. **The role label lies.** A person invited as a "guest" appears on the members page with their role shown as `Member`, next to a small `Guest` badge. Hosts read the role column and assume the person has full member capabilities; the policy engine actually treats them as a guest. The mismatch breeds mistrust ("did this work?") and operational errors ("I thought they could publish reports").

2. **The seat counter is wrong.** A workspace on Pioneer with one admin + one member + one guest shows `2 of 5 seats used` and the parenthetical `(1 member + 1 guest)`. The actual unified seat pool is 3 of 5. Hosts looking at this display either (a) think guests don't consume seats — the original concern that triggered this work — or (b) plan headcount against a number that's silently wrong. When they hit the cap they hit it earlier than they predicted.

3. **The invite mental model is two-axes for no reason.** The invite wizard asks the host to choose between "add an org member" and "add a guest." That's two flows for what is actually one decision: *what role does this person get*. The two-axes model leaks into every downstream surface — the dropdown options, the badge, the seat breakdown, the localized strings — and every one of them is a chance for the two axes to disagree.

4. **The guest preset has no name in the data.** Guests have `role='member'` on disk and the actual guest permission preset is swapped in at read time by a helper function. A future write path that forgets to call that helper silently grants member-level capabilities to a guest. The bug is one missing function call away at all times.

The first three are host-visible. The fourth is a developer footgun that costs us every time we touch this area.

## Solution

Promote the concept of "external collaborator" to a first-class workspace role and remove the parallel `is_external` flag. One role enum, one source of truth, one breakdown shown honestly.

**For hosts:**

- Externals show up on the members page with their role displayed as **External** (not Member with a Guest badge). The filter chips include an **Externals** group.
- The invite wizard still has two conceptual steps (pick org colleagues vs. invite outside collaborators) because that maps to two different lookup flows, but the second step's output is simply `role='external'` — the wizard no longer carries a separate is_org_member toggle.
- The billing card shows a single seats-used progress bar over the cap, with a small breakdown beneath it: **Members**, **Externals**, **Pending invites** — each row only appearing when its count is non-zero. The misleading "1 member + 1 guest" parenthetical is gone.
- Externals consume seats. A Pioneer workspace with admin + member + external shows `3 of 5 seats used` — the number any host would have expected.
- The role dropdown for an external row is locked to External. The role dropdown for any non-external row offers Admin / Billing / Member only (no External option). Promoting an external to a full org member happens by adding them to the org on the org settings page, then re-inviting them to the workspace as Member.

**For developers:**

- A single field — `workspace_membership.role` — answers every question about a row's identity and capabilities. The `is_external` flag, the `effective_workspace_role()` helper, and the parallel `assert_can_add_guest` / `assert_can_add_member` capacity aliases are removed.
- The `external` role preset is identical in content to today's `guest` preset (no project creation, no report publishing, no usage visibility, no invite, no conversation deletion — only read access to projects/conversations/reports, the ability to update projects shared with them, the ability to use chat, and the ability to generate reports). The rename happens in `policies.py`.
- ADR-0003 documents the trade-offs (strict vs loose coupling between role and `org_membership`; why we kept invariant enforcement at write-time only and rejected a cross-table reconciler).

The seat-count bug fix and the role rename ship together. They are technically separable but conceptually the same problem — both come from "guests are a flag, not a role."

## User Stories

1. As a workspace admin, I want externals to appear on the members page with their role shown as "External", so I never confuse them with full members.
2. As a workspace admin, I want a filter chip labelled "Externals" on the members page, so I can scope the list to outside collaborators.
3. As a workspace admin, I want the badge wording to be "External" (singular) on a row and "Externals" (plural) on the filter, so the language matches whether I'm looking at one person or a group.
4. As a workspace admin, I want the role dropdown on an external row to be locked and to display "External" only, so I cannot accidentally grant them admin, billing, or member capabilities.
5. As a workspace admin, I want the role dropdown on a non-external row to offer Admin / Billing / Member only (no External option), so I cannot accidentally demote a colleague across the org-membership boundary from a single dropdown change.
6. As a workspace admin, I want to invite an external collaborator by entering their email in the invite wizard's second step, so the flow matches my mental model of "add outsiders."
7. As a workspace admin, I want the invite wizard's second step titled "Invite externals", so the language is consistent with the role name everywhere else.
8. As a workspace admin on a Pioneer or higher tier, I want every external I invite to consume a seat against my tier cap, so my seat usage matches what I planned for.
9. As a workspace admin on a free or pilot tier, I want the seat cap to hard-block at the unified count (members + externals), so I don't get an unexpected 402 at the 3rd invite when I thought I had 5 seats.
10. As a workspace admin, I want the billing card's seat bar to show the unified total (members + externals) over the cap, so the number I see matches the number my actions are gated against.
11. As a workspace admin, I want a small breakdown beneath the seat bar showing Members, Externals, and Pending invites as separate rows, so I can see where each seat goes without the bar lying about the total.
12. As a workspace admin, I want breakdown rows with a count of zero to be hidden, so the card doesn't clutter with empty information.
13. As a workspace admin, I want pending invites to count toward the seat bar and appear as their own breakdown row, so the cap behaviour matches what I see — no surprise 402 on the next invite.
14. As a workspace admin on Pioneer or higher, I want externals to bill as seat overage just like extra members do, so my invoice matches my actual headcount usage.
15. As a workspace admin, I want the misleading "1 member + 1 guest" parenthetical removed from the billing card, so the card is no longer ambiguous about whether the buckets are independent.
16. As a workspace admin, I want to promote an external to a full member by adding them to the org first and then re-inviting them to the workspace as a member, so the cross-boundary action is deliberate and the workspace UI never silently mutates org-level data.
17. As a workspace admin, I want the system to refuse promoting an external to admin, billing, or member directly via the role dropdown, so I'm forced to take the cross-boundary action through the org settings page.
18. As a workspace admin, I want the system to refuse demoting a member, admin, or billing user to external directly via the role dropdown, so I cannot delete someone's org membership from a workspace-page dropdown change.
19. As a workspace admin, I want the invite wizard to reject role escalation (an admin can only invite up to admin level, no owner), so role escalation rules continue to apply with the new enum.
20. As an external collaborator, I want my role to display as "External" everywhere I see it (settings pages, members page, my own profile if shown), so my position in the workspace is clear.
21. As an external collaborator, I want to be unable to create new projects, so my limited access is enforced and I don't see broken or denied UI on actions I'm not allowed to take.
22. As an external collaborator, I want to be unable to publish reports, so my draft outputs don't reach a broader audience than the host intended.
23. As an external collaborator, I want to be unable to delete conversations, so I cannot destroy data I don't own.
24. As an external collaborator, I want to be unable to invite anyone to the workspace, so I cannot expand the workspace's membership without the host's involvement.
25. As an external collaborator, I want to be unable to view workspace usage or invoices, so I don't see commercial information I have no reason to see.
26. As an external collaborator, I want to be able to read projects shared with me, update them (within the host's permission grant), read conversations, use chat, view reports, and generate reports, so I can do the collaborative work I was invited for.
27. As a workspace member, I want to keep all my existing capabilities (project create, conversation delete, report publish, usage visibility, chat) unchanged, so the introduction of the external role doesn't affect my day-to-day.
28. As a workspace admin or billing role, I want the seat overage forecast on the billing card to be computed against the unified seats-used number, so the forecasted euro figure matches the bar I see above it.
29. As a Dutch-speaking host, I want all "Guest" / "Guests" strings translated to the Dutch equivalent of External / Externals, so my UI is consistent in my language.
30. As a German-speaking host, I want the same translation work to ship in German, so the rollout is uniform across locales.
31. As a French-, Spanish-, and Italian-speaking host, I want the same translation work to ship in my locale, so no locale is left with the old "Guest" wording.
32. As a future developer reading the codebase, I want a single field on `workspace_membership` to tell me whether a user is external, so I don't have to remember to consult a helper function or risk granting member-level capabilities by accident.
33. As a future developer, I want ADR-0003 to document why we made `external` a stored role rather than a flag, and why we accepted loose coupling between role and `org_membership` rather than a write-side cascade, so I don't re-litigate the decision when I touch this area.
34. As a future developer, I want every place in the backend that previously read `is_external` to be updated in one sweep, so there is no half-migrated state where some checks consult `role` and others consult the dropped flag.
35. As a future developer, I want the schema migration script to follow the established `scripts/create_schema.py` Directus pattern (idempotent REST calls, `field_exists()` / `collection_exists()` guards), so the migration aligns with the rest of the project's schema-evolution practices.
36. As an org admin who needs to add an existing external to my organisation, I want to do that on the org settings page (adding them to `org_membership`), then return to the workspace and re-invite them as Member, so the action is explicit and the workspace UI doesn't carry a footgun for cross-table mutations.
37. As a workspace admin, I want the per-row badge that previously read "Guest" to read "External" with no tooltip or subtitle explaining what External means, so the UI stays clean and the wording does the explaining.
38. As a workspace admin, I want the 400 error message "Guests can't be admins, owners, or billing" to no longer fire, so the invite endpoint's input validation happens cleanly at the schema layer (422 on out-of-enum role) instead of a domain-level error message that conflates two things.
39. As a workspace admin, I want the `is_external` column dropped from the schema entirely, so the data model has exactly one field encoding this fact and there is no opportunity for the flag and the role to disagree.
40. As a workspace admin, I want any existing `workspace_membership` row with `is_external=true` to be migrated to `role='external'` in a one-shot script before the column is dropped, so no existing data is lost in the schema change.
41. As a workspace admin, I want the `workspace_invite.include_org_membership` column replaced by a `role` column, so the invite row carries the same single-field semantics as the eventual membership.
42. As a workspace admin, I want the accept path (`onboarding.py` invite-acceptance) to read `role` from the invite and branch the `org_membership` write on `role == 'external'`, so the accept-time logic mirrors the send-time logic exactly.
43. As a workspace admin, I want the unified seat cap to still hard-block at the cap on free and pilot tiers and still allow overage on Pioneer and above, so the existing tier policy (already correct in `seat_capacity.py`) carries through unchanged.
44. As a workspace admin, I want pending invite counts to be returned from the usage endpoint (not hidden client-side), so the breakdown row can render without a separate API call.
45. As a workspace admin, I want the org-level rollup in admin UIs (the staff `/admin` view of all workspaces and the org settings page's per-workspace summary) to use the same renamed field names (`seat_count` = unified total, `member_count`, `external_count`, `pending_count`), so internal staff tools agree with the host-facing card.
46. As a workspace admin viewing the usage card, I want a row count of zero on any breakdown sub-row to hide that row entirely, so a workspace with only members (no externals, no pending) sees a clean "Members: N" row and nothing else.
47. As a workspace admin, I want the analytics events that record role-aware properties (if any) to use `external` instead of `guest` in their payload, so downstream dashboards reflect the new vocabulary.

## Implementation Decisions

**Schema**

- `workspace_membership.role` enum is extended to `{owner, admin, member, billing, external}`. A one-shot Python migration script following the `scripts/create_schema.py` pattern: idempotent REST calls against the Directus admin API, `field_exists()` / `collection_exists()` guards, run step-by-step.
- The migration: (a) add `external` to the role choices via field-update REST calls, (b) `UPDATE workspace_membership SET role='external' WHERE is_external=true`, (c) drop the `is_external` column, (d) on `workspace_invite`, add a `role` column, copy from `include_org_membership` (true → "member", false → "external"), drop `include_org_membership`. Verify each step manually before proceeding.
- Pull the schema afterwards (`cd directus && bash sync.sh ... pull`) and commit the snapshot JSON. Do not hand-write the snapshot.
- Pre-production for this surface area, so the migration is one-shot — no compat shim, no rollback consideration beyond the script being idempotent.

**Backend — `policies` module**

- Rename the preset key `guest` to `external`. Content unchanged: `project:read`, `project:update`, `conversation:read`, `chat:use`, `report:view`, `report:generate`. Explicit denials remain implicit (anything not in the preset is denied).
- Delete the `effective_workspace_role()` helper. Every read site now uses `role` directly.
- `ROLE_HIERARCHY` in the invite endpoint gains `external` at the bottom: `{external: 0, member: 1, billing: 2, admin: 3, owner: 4}`. An admin can grant up to admin; no role can grant `owner`. Externals cannot be granted any role higher than external.

**Backend — `seat_capacity` module**

- `_SEAT_ROLES` becomes `{owner, admin, member, billing, external}`.
- `compute_effective_seat_state` returns `(seats_used, member_count, external_count)` keyed on role only (no `is_external` consultation).
- The `assert_can_add_guest` and `assert_can_add_member` aliases are removed. Call sites call `assert_can_add_seat` directly.
- `count_pending_invites` now buckets by the new `role` column on `workspace_invite`. Return shape stays a two-tuple of `(pending_member_invites, pending_external_invites)` — same structure, renamed semantics.
- Hard-block tiers (free, pilot) and overage tiers (Pioneer+) are unchanged. The existing tier policy already routes through `assert_can_add_seat`.

**Backend — `inheritance.get_effective_members`**

- Stop emitting `is_external` in the per-row dict. Only `role`, `user_id`, `source`, and existing fields flow through.

**Backend — invite endpoint (`POST /v2/workspaces/{id}/invite`)**

- Request body becomes `{ email: str, role: "admin"|"member"|"billing"|"external" }`. Drop `is_org_member`.
- Branch logic: if `role == "external"`, write `workspace_membership` only, skip `org_membership` write. If `role` is anything else, ensure an `org_membership` row exists for the user in this org (create if absent), then write `workspace_membership`.
- Inline enforcement of the invariant `role='external'` ⟺ no `org_membership` row, with a comment referencing ADR-0003. (Not extracted into a service layer — two call sites, three lines each, premature abstraction.)
- Remove the 400 "Guests can't be admins, owners, or billing" branch — replaced by enum validation at the Pydantic schema layer (out-of-enum role → 422).
- Role-escalation check (an inviter can only grant roles at or below their own level) continues to apply against the new hierarchy.

**Backend — accept path (`onboarding.py`)**

- Read `role` from the `workspace_invite` row. Mirror the invite endpoint's branch on `role == "external"` to decide whether to write `org_membership`.
- Continue to call `assert_can_add_seat` at accept time (race protection) — the cap may have shrunk between send and accept.

**Backend — usage response (`/v2/workspaces/{id}/usage`)**

- Response field semantics:
  - `seat_count` (repurposed): unified total = members + externals. This is the progress-bar numerator.
  - `member_count` (new): users with role in {owner, admin, member, billing}.
  - `external_count` (new): users with role = "external".
  - `pending_count` (new): pending invites (members + externals combined). The single combined count is sufficient for the row in the card; no need to split for the host-facing display.
  - `guest_count`: removed.
- The same rename propagates to `admin.py` workspace rollups and `orgs.py` org rollups so internal staff tools agree with the host card.

**Backend — `WorkspaceInviteRequest` schema**

- Drop `is_org_member`. The `role` enum gains `"external"`. Pydantic enum validation handles the 422 case.

**Frontend — `lib/roles`**

- `displayRole` returns "External" for `role === "external"`.
- `roleColor` returns gray for `external` (matches today's guest badge color).
- `isAdminRole` unchanged. `external` is never admin-level.

**Frontend — Workspace settings members section**

- Per-row badge: replace `<Badge>Guest</Badge>` with `<Badge>External</Badge>` (singular, gray).
- Filter chips: rename "Guests" to "Externals" (plural).
- Role dropdown: on an external row, lock the control and show "External" only. On a non-external row, the existing `Admin / Billing / Member` options remain — no new "External" option (per the decision that the dropdown is not a cross-boundary lever).
- No tooltip on the badge or row — the wording does the explaining.

**Frontend — `UsageCard`**

- Single progress bar at the top: `seat_count / seat_count_included` (now the unified total).
- Beneath the bar, three sub-rows in this order: **Members** (count), **Externals** (count), **Pending invites** (count). Each row is hidden when its count is zero.
- Remove the "(1 member + 1 guest)" parenthetical inline string entirely.

**Frontend — `WorkspaceInviteWizard`**

- Step 2 submits `role: "external"` for each email. The `is_org_member` field is removed from the request payload.
- Step title: "Invite externals."

**Frontend — Lingui**

- Replace every `"Guest"` / `"Guests"` string with `"External"` / `"Externals"`. Run `pnpm messages:extract`, translate the new keys in `.po` for en, nl, de, fr, es, it (Dutch uses informal je/jij; Italian uses informal tu, A2 reading level — per `brand/STYLE_GUIDE.md`), then `pnpm messages:compile`.

**Analytics**

- Any PostHog event payload that included `{role: "guest"}` now sends `{role: "external"}`. No new events are added; this is a property-value rename only.

## Testing Decisions

A good test for this surface tests **external behaviour through the module's public interface** — not the implementation. For `seat_capacity`, that means asserting on the return values of `compute_effective_seat_state` and on whether `assert_can_add_seat` raises, not on internal set construction. For `policies`, that means asserting on `has_policy(role='external', ...)` answers, not on the contents of the preset dict.

**Two modules get unit tests:**

1. **`seat_capacity` — the bug repro and the unified-pool behaviour.**
   - Given a workspace with `[admin, member, external]` rows, `compute_effective_seat_state` returns `(3, 2, 1)`.
   - Given a workspace with `[admin, member, external]` rows on a free tier with `included_seats=3`, `assert_can_add_seat` raises 402.
   - Given a workspace with `[admin, member]` rows on a free tier with `included_seats=3`, `assert_can_add_seat` succeeds (room for one more, either member or external).
   - Given a workspace on Pioneer with overage allowed, `assert_can_add_seat` never raises regardless of count.
   - Given `include_pending=True` and 2 pending invites against a cap of 3 with 2 used, `assert_can_add_seat` raises (2 + 2 ≥ 3).
   - Derived org admins (from `get_effective_members`) count as seats just like direct members.

2. **`policies` — preset content and `has_policy` answers.**
   - `external` role does NOT have: `project:create`, `report:publish`, `conversation:delete`, `workspace:view_usage`, `member:invite`, `member:manage`, `settings:manage`, `workspace:view_invoices`.
   - `external` role DOES have: `project:read`, `project:update`, `conversation:read`, `chat:use`, `report:view`, `report:generate`.
   - `member` role retains all its current policies (regression guard against accidental removal).
   - `has_policy("external", custom_policies=None, "project:create")` is `False`. `has_policy("external", custom_policies=None, "project:read")` is `True`.
   - The role hierarchy: `external < member < billing < admin < owner`.

**Prior art:** the existing test suite under `server/dembrane/tests/` (or wherever `policies` and `seat_capacity` tests currently live — grep for `test_policies` and `test_seat_capacity` to locate). Match style: pytest, async fixtures where Directus is involved, plain unit tests where the function is pure.

**Not tested via unit tests** (verified by manual click-through and existing integration tests):

- Frontend role dropdown lock / filter chip rename / badge text — covered by the existing pattern of running `pnpm dev` and clicking through the members page in en + one non-en locale.
- The invite wizard's step 2 payload — covered by manually inviting an external and observing the network request body and the resulting row in Directus.
- The `UsageCard` layout — covered by visual inspection at common (and edge) count combinations (0 externals; 0 pending; both non-zero; both zero).
- The schema migration script — run step-by-step against a dev Directus and verified row-by-row before proceeding.

## Out of Scope

- **A "Convert external to member" UI action on the workspace members page.** The single-click conversion was rejected: promotion happens by going to the org settings page, adding the user to the org, returning to the workspace, removing the external row, and re-inviting as member. The cross-table side effect is intentionally not a single-click workspace action.
- **Auto-promotion when an external is independently added to the org.** If an admin adds an external user to the org via the org settings page, the user's existing `workspace_membership` rows stay at `role='external'` until manually changed by re-invite. No background reconciler, no trigger, no derived role lookup.
- **A background reconciler for the invariant `role='external'` ⟺ no `org_membership` row.** Enforcement is write-time only. If state drifts in a degenerate scenario (manual SQL, partial deploy), the fix is manual.
- **Multi-workspace external (Slack-style multi-channel guest).** An external is external to a single workspace per row. If the same person needs external access to two workspaces, that's two `workspace_membership` rows. No new collection or shared cross-workspace identity for externals.
- **A "viewer" or other limited-but-internal role for users who ARE in the org but should have restricted workspace access.** Externals are strictly "not in the org" by invariant. If product later wants "limited access for an org colleague," that's a new role — not a use of `external`.
- **External-facing communications about the rename.** Internal docs are updated as part of this work, but help-center articles, marketing copy, and release notes are out of scope until a separate communications pass.
- **Backwards compatibility for the `WorkspaceUsageResponse` field rename.** Pre-prod for this surface, so consumers are updated in lockstep with the backend change. No legacy field aliases, no deprecation period.

## Further Notes

- **Respect ADR-0003** (`docs/adr/0003-external-as-role.md`) — that document records the full chain of decisions (Path A with loose coupling, the role-vs-flag trade-off, why we kept invariant enforcement at write-time only, why a service-layer extraction was rejected, the unified seat-pool repro and root cause).
- **The seat-counting bug is the highest-value fix in this PRD.** Even though the bulk of the work is the role rename, the bar showing the wrong number is the host-visible regression that motivated the work. The fix lives in repurposing the `seat_count` field semantics in the usage response and is testable in `seat_capacity`.
- **The schema migration script is single-use and lives in `scripts/`.** Once run against staging and the schema snapshot is pulled and committed, the script can stay in the repo as a record of the migration but is not re-run.
- **Lingui translation work is on the critical path.** Don't ship the frontend rename without compiling the message catalog in all six locales — partial translation leaves the UI mixing "Guest" (untranslated locale) and "External" (translated locale).
- **The `is_external` flag is one of two fields that were carrying the same fact.** The other was `workspace_invite.include_org_membership`. Both are dropped in this PRD. If any third field encoding the same fact is discovered during implementation (grep for `external`, `guest`, `is_external`), drop it too — the goal is exactly one source of truth.
- **No new policies are introduced.** The `external` preset is a rename of the existing `guest` preset with identical content. The PRD does not change *what* externals can do — only how they appear and how they are counted.
- **No new tier behaviour.** Free and pilot continue to hard-block; Pioneer+ continue to bill overage; Guardian remains unlimited. The unified pool is already enforced in `assert_can_add_seat`; this PRD makes the reporting agree with the enforcement.
