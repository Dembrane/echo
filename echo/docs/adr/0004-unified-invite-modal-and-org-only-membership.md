# Unified invite modal and org-only membership

## Status
accepted (2026-06-01)

## Context

Workspaces shipped with two separate invite surfaces. `OrganisationInviteWizard` (multi-step, multi-workspace, per-workspace role assignment, seat awareness) launched from the org members page. `WorkspaceInviteWizard` (single-workspace, simpler) launched from the workspace members page. Both surfaces called the same backend endpoint (`POST /v2/workspaces/:id/invite`), which auto-creates an `org_membership` row when the invitee is not yet in the org (except for `role='external'`, per ADR 0003).

A dry run with the team surfaced three connected complaints:

1. **The two modals look and feel different even though they do the same thing under the hood.** Workspace admins assume the workspace modal is "less powerful" and that they need to escalate to an org admin to add someone, even though the endpoint already handles the org_membership side effect transparently. The mental model "this invite is to the workspace" makes the auto-org-creation invisible.

2. **There is no way to invite someone as a plain org member.** Every invite path requires picking at least one workspace. A user who should "just be in the org" (and discover workspaces themselves) cannot be created. The closest existing path is to invite them to a sacrificial workspace and have them ignore it, which is wrong on the data and confusing in the UI.

3. **Org-only membership has no landing surface.** Even if such a user were created, they would log in to an empty sidebar under the org node, with no way to find the workspaces the rest of their team is using. The `access_request` flow (Matrix v1.1 §6) exists in the backend but has no discovery UI driving traffic to it.

The CTO referenced Slack's invite modal as the target pattern: one modal, the team is the subject, channels (workspaces) are an optional secondary selection. We adopt that framing with adaptations for our role model and seat constraints.

Three reshape paths were considered:

- **Path 1. Make the two existing wizards look identical, but keep them as separate components.** Smallest diff. Rejected because the two-surface mental split is the root cause of the confusion. Cosmetic alignment leaves every future feature one chance to drift again.
- **Path 2. Allow org-only invites by making `workspace_id` nullable on `workspace_invite`.** Smallest schema change for the new capability. Rejected because the semantics of an org-only invite (no workspace context, no seat charge, no per-workspace role) genuinely differ from a workspace invite. A nullable column would force every read site to branch on null, and the role field's enum overlap (`member` is a valid value in both contexts but means different things) would silently mislead.
- **Path 3. One unified modal, one conceptual subject (the organisation), workspaces as optional access, a dedicated `org_invite` table.** Largest surface area but each piece is independently justifiable. Chosen.

## Decision

- **The organisation is the subject of every invite.** Modal title is always "Invite people to {OrgName}". Entry-point button labels are always "Invite people". The workspace is presented as an optional secondary selection inside the modal, never as the framing of the operation. This is the conceptual shift that resolves the dry-run complaint.

- **One unified `<InviteModal>` component replaces both `OrganisationInviteWizard` and `WorkspaceInviteWizard`.** Both old components are deleted in the same PR. Entry points remain the org members page and the workspace members page (no new entry points are added). Launching from a workspace pre-checks that workspace in the modal's "Add to workspaces" section; launching from the org members page leaves the section unchecked.

- **The "Add to workspaces" list is filtered to workspaces where the inviter has `member:invite`.** Org admins and owners see every workspace in the org. Workspace admins see only the workspaces they administer. There is no cross-boundary selection, and the case "I can see WS-B but cannot invite to it" never appears in the modal.

- **Org-level invite power gates the zero-workspace submit.** A submit with zero workspaces selected creates a plain `org_membership` (role `member` by default). Only users with org-level invite power (org admin or owner) can submit with zero workspaces. Workspace admins must select at least one workspace; the Send button stays disabled with inline helper text until they do. Org membership for non-org-admins is only ever a side effect of a workspace invite, never a primary act.

- **A single role applies to all selected workspaces.** Default `member`. The dropdown is filtered by the existing role-escalation guard in `policies.py` (`ROLE_HIERARCHY`). `external` is a value in the same dropdown, with inline helper text appearing when selected: "Externals are NOT added to your organisation. They can only see the workspaces you select here." Per-workspace role assignment is not exposed; mixed-role cases are handled by editing the role after acceptance from the workspace members page.

- **Bulk emails are accepted in a single invite.** Comma, space, or newline separated. Each email is parsed into an inline chip with per-email validation. Submission fans out from the frontend to N parallel calls of the existing `POST /v2/workspaces/:id/invite` endpoint (one call per email per selected workspace, or one call per email to the org-only endpoint when no workspaces are selected). Per-email status rows appear in the modal. No new batch endpoint is introduced; the 20-invites-per-hour rate limit on the existing endpoint covers abuse.

- **Per-workspace seat capacity is surfaced inline in the workspace list.** Each workspace row shows `used/cap`. Behaviour on overage depends on the workspace's seat-cap mode:
  - **Hard-block tiers** (the row's `seat_invite_blocked` is true): the row self-disables if selecting it would push the seat count past the cap given the current email count. The user cannot pick it.
  - **Soft-cap tiers** (overage billing applies): the row stays clickable but shows an inline "Overage billing applies" warning. Picking it is allowed; the workspace is charged for the additional seats per the tier contract.

  Soft-cap allows overage billing rather than blocking the invite. Originally the ADR specified a uniform hard disable; the soft-cap branch was added during issue 02 implementation to match how soft-cap tiers behave elsewhere in the product (the user has already agreed to overage by being on that tier). The aggregate seat banner is not used; per-workspace visibility was identified as business-critical during the grilling session.

- **A new `org_invite` collection holds pending org-only invitations.** Fields: `id` (uuid), `org_id` (m2o), `email` (text), `role` (enum: member, admin, billing, owner), `invited_by` (user m2o), `expires_at` (timestamp, default now + 7 days), `accepted_at` (timestamp, nullable), `deleted_at` (timestamp, nullable). `workspace_invite` gains one new column, `deleted_at` (timestamp, nullable), so revoke can soft-delete and so the idempotency rule "soft-deleted rows are reactivated by clearing `deleted_at`" applies to both tables symmetrically. `workspace_id` does NOT become nullable; the two tables still encode genuinely different operations.

- **A single acceptance endpoint serves both invite types.** `POST /v2/me/invites/accept-by-hash` takes a hash and the route discriminates by matching the hash against `workspace_invite` first, then `org_invite`. Shared pre-checks (hash validation, email match, expiry, revocation, rate limit) happen once. The response carries a `type: "workspace" | "org"` field so the frontend can route. The URL still carries `?ws=...` xor `?org=...` for display/pre-fill purposes but the backend ignores it — the HMAC hash is the authoritative discriminator. Two distinct endpoints were rejected because the post-acceptance side effects do not diverge and the duplicated pre-checks would drift.

  **Implementation diverged from the original ADR text** (`POST /v2/invites/accept` with `org_id xor workspace_id` body) because the hash-only discriminator is strictly stronger: a leaked id without the matching hash can't accept anything, and the per-table fallback already had to read both tables for the existence check. Carrying the discriminator in the body added a verification path that contributed nothing.

- **First acceptance for an email in an org consumes all pending invites for that email in that org.** If `bob@x.com` has both a pending `org_invite` and a pending `workspace_invite` in the same org, accepting either marks both as accepted and applies the union of memberships. The sweep also applies to role: if two pending `org_invite` rows request different roles (member + admin), the user lands at the higher of the two. This avoids a race where one invite is consumed and the other is left as stale pending state.

  **Implementation deviation: not transactional.** The original ADR text said "in one transaction." The Directus SDK has no transaction primitive, so the sweep is best-effort per-item with try/except. A failure mid-loop logs and continues; the originating accept remains successful regardless. The trade-off is acceptable because the sweep is idempotent (a future accept of the same row retries), seat-cap and workspace-deleted are the only realistic failure modes (both recoverable from the admin's Pending Invites view), and the alternative would be rolling back the originating accept on a peripheral failure — worse UX.

- **The `already_member` fast paths also clean up stale pending state.** A re-invite of an active member silently marks any pending `workspace_invite` rows for the same (email, workspace) as accepted, so admin pending-invites lists don't accumulate orphan rows after the user joins via another path. Best-effort: failures here are logged but do not change the user-facing idempotent response.

- **Idempotency rules are explicit at the invite endpoint.** New user, no Directus row: create token, send email. Existing user, not in org: create `org_membership` plus selected `workspace_membership`s, send "you've been added" email. Existing user, in org, missing some selected workspaces: create only the missing rows, leave `org_membership` alone. Existing user, in all selected workspaces: silent no-op, no email sent, per-email row in modal reads "Already a member." External-to-member promotion: create `org_membership`, add new workspace memberships, leave existing `external` rows in other workspaces alone (do not silently change a role the user already has somewhere). Soft-deleted rows are reactivated by clearing `deleted_at`, not duplicated. Self-invite is blocked at validation.

- **Org-only members land on the workspace selector at `/w` with workspace discovery surfaced inline.** Originally specced as a dedicated "Org home" route under `/o/:organisationId`. Reversed during implementation when it became apparent that `WorkspaceSelectorRoute` (`/w`) already mounts `<DiscoverableWorkspaces>` per-org, so the dedicated page would have duplicated the affordance. Both invite types' acceptance routes redirect to `/w`. The component lists all `visibility='open_to_organisation'` workspaces with a "Request access" button per row; private workspaces are excluded; already-requested rows show "Requested" with a disabled button. The sidebar under the org node shows nothing for org-only members; discovery is the selector's job, not the sidebar's.

- **Pending invites surface on members pages.** The org members page shows a "Pending invites" section below the members list, drawing from both `org_invite` and `workspace_invite` (org-only invites only show here). Each row exposes "Resend" and "Revoke". The workspace members page shows only workspace-scoped pending invites. The existing stub `GET /v2/orgs/:id/pending-invites` is fully implemented to merge both tables.

- **Access-request notifications keep current behavior.** Per-request emails to all eligible approvers (workspace admins, org admins, org owners). Silent rejection per Matrix v1.1 §6. Both workspace admins and org admin/owner can approve, unchanged.

- **Three telemetry events are added.** `invite_sent` (props: count, workspace_count, role; `workspace_count=0` discriminates org-only). `workspace_access_requested` (props: workspace_id, org_id). `workspace_access_actioned` (props: action, request_id, actioned_by_role). Acceptance, revoke, and resend are not tracked from the frontend (Directus user creation already signals acceptance; the other two are low-signal).

- **Personalized message, copy-invite-link, and Google Workspace suggestions from the Slack reference are dropped for v1.** Personalized message requires email-template work in six locales. Copy-invite-link is a multi-week design effort (expiry, revocation, single vs multi-use). Google directory has no integration in our stack. None block the unified-modal goal.

## Consequences

- **The "two surfaces" mental model is gone.** Future readers see one modal component, one acceptance endpoint, one mental model: invite to the org, workspaces are optional. This is the resolution that the dry-run feedback was asking for.

- **Two distinct invite tables coexist.** `workspace_invite` and `org_invite` are not unified. Reads that want "all pending invites in this org" must union the two. This is the cost of refusing to make `workspace_id` nullable on `workspace_invite`. The merge happens in `GET /v2/orgs/:id/pending-invites` and is the only place the union is materialised; per-workspace reads still hit `workspace_invite` directly.

- **Org-only members are first-class.** The data model (zero `workspace_membership` rows is now a valid state for an org member) and the UI (the workspace selector at `/w` surfaces `<DiscoverableWorkspaces>` per-org) both treat this as expected. Other code that iterates membership now needs to handle the empty-workspace case. The places that need to be checked are the sidebar render, any "your workspaces" hooks (`useMyWorkspaces` and similar), and any analytics or seat-counting code that previously assumed every org member has at least one workspace.

- **Workspace admins cannot mint org members directly.** The zero-workspace submit is gated to org-level invite power. A workspace admin who needs to add someone "just to the org" must ask an org admin. This is intentional: a workspace admin's invite power is scoped to the workspaces they own, and the existing org-membership side effect from a workspace invite is enough for the cases they care about.

- **Per-workspace role assignment in one invite is no longer possible.** The current `OrganisationInviteWizard` supports it; the new modal does not. Mixed-role invites become two flows: invite as the lower role, then change the higher one from the members page after acceptance. This is a deliberate simplification per the dry-run feedback and Slack's pattern. Reintroducing per-row roles in the future would be a UI-only change; the backend already accepts per-call role.

- **The "promote external to member" path is asymmetric and intentional.** A re-invite of an existing external as `member` creates the `org_membership` but leaves their existing `external` workspace rows alone. The admin must explicitly upgrade those workspace rows from the workspace members page if they want member-level access there. This matches the ADR 0003 invariant ("`role='external'` ⟺ no `org_membership` row") in spirit: changing org membership and changing workspace role are two distinct authorised actions and we do not coalesce them into one button.

- **i18n footprint grows by the new modal plus the inline workspace-discovery copy on `/w`.** All strings in en, nl, de, fr, es, it. `pnpm messages:extract` is on the critical path for any deploy that ships this change.

- **The acceptance URL surface changes.** New shape `?h=...&iss=...&org=...&email=...&role=...` for org-only invites, existing `?ws=...` shape for workspace invites. Both go to the same `AcceptInviteRoute`. Email templates need to emit the right shape per invite type. Previously-issued workspace-invite URLs continue to work unchanged.

- **The decision to keep current access-request email behavior is deliberate, not lazy.** Per-request emails to all approvers can get noisy as org-only membership scales. We accept this for v1 because (a) it preserves current behavior and avoids retraining users, (b) the volume in the dry-run population is low, and (c) digesting can be added later without a model change if signal turns into noise.

## Post-implementation retrofits

Documented after the second adversarial review pass. These are not new design decisions; they patch correctness gaps the original spec didn't anticipate.

- **`org_deleted` status is distinct from `workspace_deleted`.** Both the public probe (`GET /v2/auth/invite-status`) and the authenticated inspect (`GET /v2/me/invites/by-hash`) return `org_deleted` when an `org_invite`'s parent org no longer exists, mirroring `workspace_deleted` for workspace invites. The frontend renders type-specific copy. The original implementation reused `workspace_deleted` for both, which read wrong when the subject was an organisation. Old clients treating unknown statuses as `not_found` fail safe.

- **Self-heal fallback exists for both invite types.** If `accepted_at` is set but the corresponding membership row creation failed (partial-write, network blip), a retry of the same link self-heals by creating the missing membership. The HMAC + email-match is strong enough proof. Both branches filter by `deleted_at IS NULL` at the query level AND re-check per-row before granting access — a revoked invite must never reach a heal write.

- **Resend and revoke require live `org_membership`, not just `invited_by`.** A user removed from the org should not retain the ability to drive branded invite emails on the org's behalf. The check pairs `is_inviter` with a current-membership probe; an admin always passes regardless of `invited_by`.

- **Revoke is idempotent.** A second `DELETE /v2/invites/:id` on an already-soft-deleted row returns `{"status": "already_revoked"}` (200) instead of 404. The frontend's optimistic update treats revoke as idempotent; the 404 was surfacing as a stray toast error after the cache invalidated.

- **Migration script mirrors only the Administrator policy.** The original "mirror every policy attached to `workspace_invite`" pattern was tightened to look up the Administrator policy by name and clone only that one. A future migration that adds a Public/Session policy to `workspace_invite` (for unauth probes) would otherwise silently expose `org_invite` to the same audience and leak pending-invite emails.

- **Postgres-level invariants live in raw SQL (`scripts/add_org_invite_collection.py`).** Directus does not manage partial indexes, CHECK constraints, or column defaults. The migration script applies (a) the partial unique index on `(org_id, lower(email))` where pending, (b) a 7-day default on `expires_at`, and (c) a `CHECK (email = lower(email))` constraint as defense in depth against the convention-only lowercasing the application layer enforces. Must be re-run per environment; documented in `docs/database_migrations.md`.

- **`seats_used_including_pending` is the canonical seat-count field.** Surfaced per workspace in `GET /v2/orgs/:id/workspaces` (added by ADR-0004). The name is explicit about including pending `workspace_invite` rows so the modal can preview overage correctly. Both hard-block and soft-cap tiers populate it (the previously-considered "only compute for hard-block tiers" optimisation was rejected because the modal needs accurate counts on soft-cap tiers to display "x/y seats" honestly).
