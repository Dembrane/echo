# Billing account: split commercial terms off the workspace

## Status

Draft for discussion (2026-06-16). Not yet an ADR. The capacity-scope question in "Key decision" below gates almost everything else and needs a product call before this becomes an implementation plan.

## Context

Today billing is welded onto the `workspace` collection. A workspace carries its own `tier`, `tier_expires_at`, `downgraded_at`, `downgraded_from_tier`, `pre_warning_sent`, `percent_discount`, and `type_discount`. Capacity (seats, audio hours) is computed per workspace from `tier` via `tier_capacity.py`, and every gate reads `workspace.tier`:

- Seat caps: `seat_capacity.py` (`assert_can_add_seat`, free/pilot hard-block, pioneer+ overage).
- Hour caps and over-cap stamping: `tier_capacity.py` + `task_stamp_conversation_on_finish` in `tasks.py`, persisting `conversation.is_over_cap` (ADR 0001).
- Feature gating: `policies.py` `has_policy(..., workspace_tier=tier)` against `TIER_REQUIRED_FOR_POLICY`.
- Tier change: user via `workspace_request` (`workspace_requests.py`), staff approval in `admin.py` (`decide_workspace_request`), staff direct in `workspaces.py` (`set_workspace_tier`).
- Expiry and downgrade: hourly crons `task_expire_workspace_tiers`, `task_send_tier_expiry_prewarning`; effects in `tier_downgrade.py`.

There is already a partial step toward decoupling the payer from the consumer: `workspace.billed_to_team_id` (which org pays, FK to `org`) and `workspace.billed_to_workspace_id` (partner billing). Both are descriptive today and not enforced by billing code. The `org` collection itself has no billing fields. Mollie is not wired into the application at all yet; it exists only as an MCP server for research and dev tooling.

We want a standalone `billing_account` entity that holds the commercial relationship, and that can be associated with either an organization or a workspace. The organization membership and invite pattern stays exactly as it is (org_membership, workspace_membership, org_invite, workspace_invite, the unified invite modal, ADR 0003 and 0004 all unchanged).

## Goals

- A `billing_account` entity owns tier, expiry, discounts, billing period, and (later) the Mollie customer and subscription references.
- A billing account can be scoped to an org or to a single workspace.
- Existing behavior is preserved on day one through a 1:1 backfill (every workspace gets its own workspace-scoped account). No user-visible change until we deliberately introduce org-scoped accounts.
- A single resolver becomes the one place that answers "what tier and terms apply to this workspace?", so enforcement code stops reading `workspace.tier` directly.
- Mollie has a natural home: one Mollie customer per billing account.

## Non-goals

- No change to org/workspace membership, roles, or invites. Billing-account access is derived from the existing `billing`/`admin`/`owner` roles on the account's owner.
- No new self-serve checkout in v1. The `workspace_request` approval flow stays the source of tier changes; it just writes to the account.
- We do not redesign the tier matrix. `tier_capacity.py` stays the single source of truth for what each tier includes and costs.

## Decisions so far (2026-06-16)

- Capacity is **pooled at the billing-account level** (Model B below). Seats sum across every workspace the account covers. Hours are no longer a paid-tier lever (see pricing).
- An account covers workspaces from **one org only** in v1. Partner / cross-org billing is deferred, but the workspace-vs-org attach point ships in v1 because it is what enables the partner and handoff model (see "How the association changes").
- **Currency is EUR for all tiers.**
- **Seats are metered, never blocked.** This continues the "no hard limits" principle from the free-tier work. Seat usage is always visible and billed, but invites are never walled. A Mollie subscription drives quantity from the metered count; an offline/invoice sale can additionally provision a committed seat count that the UI shows as used-vs-provisioned. Blocking seat overage goes away.
- **Innovator chat is an integration surface, not an upsell wall.** On Innovator the chat screen becomes "connect your own tool (ChatGPT / Claude / MCP) to analyze your data"; Changemaker bundles EU Gemini instead. Explicit anti-goal: no upsell prompts scattered across the app. The current `FeatureGate` hatched-overlay-everywhere pattern is not the model for this gate.
- **Billable seat = `member` / `admin` / `owner`, plus `external`.** External members consume a paid seat (when added to an artifact within the billing context). There is no "guest" concept; it is only `external`. The `billing` role is unpaid and unlimited: financial-visibility people can be added freely without consuming a seat.
- **Exactly one billing context, always.** Every workspace, and everything beneath it (projects, conversations), must always resolve to exactly one billing account. `workspace.billing_account_id` is NOT NULL, the backfill covers every workspace, and workspace creation always assigns an account. No orphaned entities without a billing context.
- **Offline sales are a first-class payment mode, Mollie-optional.** A billing account carries a `payment_mode` (mollie | offline | none). Offline (invoice) sales must remain fully supported, with or without Mollie ever being involved. Mollie is one payment backend, not a requirement for an account to exist or to be billed. Offline accounts use the provisioned seat count; Mollie ids are populated only in `mollie` mode. This keeps a paid customer on an invoice from ever depending on Mollie.

## How the association changes (workspace tier -> billing context)

Today the **workspace** is the unit that holds a tier: capabilities are read straight off `workspace.tier`, and two workspaces in the same org are two unrelated subscriptions.

After this change the **billing account** holds the tier and commercial terms. A workspace no longer owns a tier; it points at a billing account via `workspace.billing_account_id`, and the account carries the tier. The question "what can this workspace do?" is answered by resolving `workspace -> billing_account -> tier` through one resolver.

The billing account attaches to either an org or a single workspace:

- **Workspace-scoped**: funds exactly one workspace. This is today's 1:1 world, unchanged.
- **Org-scoped**: funds many workspaces in that org. Their seats pool into one count, one invoice, one tier.

Why the attach point is the load-bearing v1 feature: because billing is now a separate, attachable thing, a partner can run a workspace on their own account with a clean ledger of what the subscription covers, and at handoff the workspace is re-pointed to the client's new org account with no data movement. The existing `workspace.handoff_status` / `handoff_target_team_id` fields slot into this. Pooling is a consequence; the attachable billing context is the point.

Membership and invites are untouched. Who can see and manage an account derives from the existing `billing` / `admin` / `owner` roles on the account's owner.

## Key decision: what does an org-scoped billing account mean for capacity?

This is the fork that changes the size of the project. A billing account holds a single `tier`. When that account is scoped to an org covering several workspaces, capacity (seats, hours) can be interpreted two ways:

### Model A: tier inheritance, capacity stays per workspace (recommended for v1)

The account is the subscription holder. Each workspace it covers resolves its tier from the account, but seat and hour capacity are still computed and enforced per workspace, exactly as today. An org account at `innovator` gives every covered workspace its own independent innovator allotment.

- Pros: enforcement code barely changes. `seat_capacity.py`, `tier_capacity.py`, over-cap stamping, and `has_policy` keep operating per workspace, only swapping `workspace.tier` for `resolve_tier(workspace)`. The 1:1 backfill is a literal no-op behaviorally. Lowest risk.
- Cons: commercially generous. One subscription grants N workspaces full capacity each. That may be fine ("buy innovator for the whole org") or may undercut per-seat pricing, depending on the sales model.

### Model B: pooled capacity across the account

Seats and hours are pooled at the account level. Usage aggregates across every workspace the account covers, and gates fire on the sum.

- Pros: matches a "buy one subscription, share the pool" commercial model. Cleaner mapping to a single Mollie subscription with metered overage.
- Cons: large enforcement refactor. Every per-workspace check becomes a per-account aggregate (seat counts summed across workspaces, hour usage summed, over-cap recomputed against a shared budget). `conversation.is_over_cap` semantics change. Migration and caching get harder.

### Recommendation

Ship Model A first. It lets us extract the entity, move the writes, and wire Mollie without changing a single enforcement semantic. Treat Model B (pooling) as an explicit Phase 3 decision once the entity exists and we know which orgs actually want a shared pool. If we know now that pooling is the commercial intent, that changes the schema (we would track usage at the account level) and should be settled before Phase 1.

## Pricing strategy (new direction, 2026-06-16)

### Why it is changing

The current matrix splits by compliance context. Customer research says the valued things are: EU hosting and the security that implies, reduced admin burden (we help them run events, produce trainings, use the tool well, reach their goals), and that the product is a genuine time-saver. The pricing pain points: getting started was expensive (a usable single-user setup on Pioneer was about €200/mo), and every tier capped hours. The hour cap was originally a proxy for chat/analysis context cost, not for recording or transcription, which are cheap. Combined with EU AI Act high-risk concerns across much of the customer base, the model was hard to start with. The new direction simplifies and lowers the entry price.

### New tiers (all prices billed yearly; monthly is 20% more)

- **Free** (unchanged): 1 hour of recording, single user, open registration.
- **Innovator** (coming soon): $20 per seat / month. No built-in analysis. Chat and analysis are bring-your-own: connect ChatGPT or Claude through an MCP we will release.
- **Changemaker**: €75 per seat / month. Batteries included: EU-hosted Gemini 3.5 Flash for in-product analysis.
- **Guardian** (coming soon): CLOUD Act safe. No American cloud technology; the whole stack runs on EU cloud providers (for example OVHcloud) with EU-sovereign LLMs hosted, and ideally built, in the EU. For the most sensitive buyers: municipalities and large enterprises. Price to be set.
- **Bespoke**: bespoke compliance requirements are a conversation. Self-hosting is also available.

### What changes structurally

- **Pricing is per seat, not a flat tier price.** This fits the pooled account model directly: the pool is seats. The account's seat count sums across its covered workspaces, and billing is seat_count times the tier's per-seat price.
- **Hours stop being a paid-tier lever.** All paid tiers have unlimited recording and transcription under fair use (fair use = a legitimate purpose). Only Free keeps an hour cap (1 hour). The over-cap machinery (ADR 0001, `is_over_cap` stamping, hour overage in `tier_capacity.py`) collapses to a Free-tier-only check.
- **Tier now encodes analysis capability and compliance level, not capacity.** Innovator has no built-in analysis. Changemaker includes EU Gemini analysis. Guardian is the sovereign EU stack. This introduces an analysis/chat feature gate keyed on tier (changemaker and above) in `policies.py`.
- **Monthly premium is 20%** (`MONTHLY_BILLING_PREMIUM_PCT` was 10 per ADR 0002, becomes 20).
- **Pilot and Pioneer are removed.** The `tier` enum and all copy shrink to free / innovator / changemaker / guardian.

### Migration

All existing paying customers move to **Changemaker with unlimited hours** until their subscription renewal date. Free stays free.

### Out of scope here (separate epic)

Simplified trainings, to lower the getting-started barrier. We will need a way to identify whether a user has completed training, and later an auditing system to ensure users in high-risk environments complete it. Not built now, but the data model should leave room for a per-user training flag.

### Pricing decisions and remaining questions

Resolved:

- Currency: **EUR for all** tiers.
- Seat mechanic: **both, and never blocking.** Always meter actual seats from membership across the account's workspaces (visible, billed). A Mollie subscription drives quantity from the metered count. An offline/invoice sale can also provision a committed seat count, shown as used-vs-provisioned. No seat wall, so blocking seat overage is removed.
- Innovator analysis: **in-app chat becomes a bring-your-own-tool integration** (ChatGPT / Claude / MCP); Changemaker bundles EU Gemini. No upsell prompts scattered across the app.

Still open:

1. Innovator EUR price (USD figure was $20; confirm the EUR number, likely €20).
2. Guardian price: a number, or "conversation" like Bespoke?
3. Mollie subscription shape for metered seats: subscription quantity synced to the live metered count (and on what cadence), versus fixed quantity from provisioned seats. The provisioned path is straightforward; the metered-sync path needs a sync trigger defined.

This is a tier-matrix overhaul that reaches well beyond the billing-account entity (`tier_capacity.py`, `policies.py`, the enum migration, ADR 0002's premium constant, and a lot of frontend copy). It likely deserves its own ADR that this plan depends on.

## User flows by persona

Three personas touch this, and only three: staff, host, participant.

### Staff (dembrane internal)

The only persona that creates and configures billing accounts. Flows:

- Create a billing account and attach it to an org or a workspace; choose `payment_mode` (mollie | offline | none).
- Approve or deny `workspace_request` rows; set tier directly; apply discounts (`percent_discount`, `type_discount`).
- For offline/invoice sales: provision a committed seat count on the account, no Mollie required.
- Re-point workspaces between accounts (the partner handoff).
- View billing rollups (MRR, per-account usage), as the admin surface does today.

### Host (the customer: owner / admin / billing / member / external)

Uses the product and, depending on role, manages billing visibility. Flows:

- owner / admin: see metered usage (seats used, never blocked), request a tier upgrade via `workspace_request`, manage members and invites (unchanged, ADR 0003 and 0004), initiate partner handoff.
- billing role: financial visibility only (invoices, payment method), unpaid and unlimited, no seat consumed. Pays via Mollie when the account is in `mollie` mode.
- member / external: use the product. An external consumes a billable seat when added to an artifact in the billing context; a member is a billable seat. Neither is ever walled by seat count.

### Participant (portal)

Never sees billing and is never blocked. Flows:

- Contributes conversations by QR code or audio upload. Recording never fails (ADR 0001), regardless of the account's seat or payment state.
- Their recording counts toward the account's usage but never gates them. The only billing-adjacent effect anywhere in the product is the Free-tier hour cap, which hides new content behind an upgrade prompt for the host, never an error for the participant.

## Proposed schema

New collection `billing_account` (created via an idempotent Directus REST script, per the project's Directus rules, then snapshot pulled and committed):

- `id` (uuid, pk)
- `label` (string) for staff/admin display, for example "Acme org billing"
- `org_id` (uuid, nullable, FK to `org`)
- `workspace_id` (uuid, nullable, FK to `workspace`)
  - Exactly one of `org_id` / `workspace_id` is set. This is the "scoped to an org or a workspace" association. Enforced in app code (Directus has no cross-column check), validated in the create/update service.
- `tier` (string enum, moved from workspace): free | pilot | pioneer | innovator | changemaker | guardian
- `tier_expires_at` (timestamp, nullable, moved)
- `downgraded_at` (timestamp, nullable, moved)
- `downgraded_from_tier` (string, nullable, moved)
- `pre_warning_sent` (boolean, moved)
- `percent_discount` (integer 0-100, nullable, moved)
- `type_discount` (string enum scholarship | staff_discount, nullable, moved)
- `billing_period` (string enum annual | monthly, nullable) finally gets a home here. ADR 0002 deferred `workspace.billing_period` to "the automated-billing workstream"; this is it. Backfill from the most-recent approved `workspace_request` via the existing `billing_period.py` resolver.
- `payment_mode` (string enum mollie | offline | none, default none): how the account is paid. Offline is first-class and never depends on Mollie.
- `provisioned_seats` (integer, nullable): committed seat count for offline/invoice sales. Metered usage is always computed from membership regardless; this is the contracted number shown as used-vs-provisioned.
- Future (Mollie, Phase 3): `mollie_customer_id`, `mollie_subscription_id`, `status` (active | past_due | canceled). Populated only when `payment_mode = mollie`.
- `created_at`, `created_by`, `updated_at`, `deleted_at`

Change to `workspace`:

- Add `billing_account_id` (uuid, FK to `billing_account`). This is the account that funds the workspace.
- The authoritative tier and commercial fields move to the account. To avoid breaking the many readers of `workspace.tier` and the frontend summary contract, the API keeps returning a computed `tier` on workspace responses (resolved through the account). Internally, enforcement reads the resolver, never the column.
- `billed_to_team_id` and `billed_to_workspace_id` are subsumed by account ownership and the `billing_account_id` pointer. They become migration inputs (see below) and are then retired.

New module `billing_account.py` (server):

- `get_billing_account(workspace_id | workspace) -> BillingAccount` follows `workspace.billing_account_id`.
- `resolve_tier(workspace) -> Tier`, `resolve_terms(workspace)` for discounts/period/expiry.
- `accessible_billing_accounts(user)` for the frontend, derived from existing roles.
- Single seam that every gate calls instead of touching `workspace.tier`.

## Migration and defaults

1. Backfill 1:1. For every existing workspace, create a workspace-scoped `billing_account` (`workspace_id` set, `org_id` null), copy `tier`, `tier_expires_at`, `downgraded_*`, `pre_warning_sent`, `percent_discount`, `type_discount`, and the resolved `billing_period`. Set `workspace.billing_account_id`. This is behavior-preserving.
2. `billed_to_team_id`: where a workspace pointed at an org as payer, that is a hint that it belongs on an org-scoped account. Do not auto-consolidate in v1. Record the intent and let staff merge workspaces onto an org account as an explicit Phase 3 action, so we never silently change someone's capacity or invoice.
3. New workspace creation: if the workspace's org already has a default org-scoped billing account, attach the new workspace to it. Otherwise create a fresh workspace-scoped free account. This is what makes org-level billing feel natural without forcing it.

## Flow-by-flow impact

- Tier reads and feature gating: `has_policy(..., workspace_tier=resolve_tier(ws))`. Mechanical swap at the call sites in `project_sharing.py`, `projects.py`, `workspace_settings.py`.
- Seat enforcement: Model A keeps `seat_capacity.py` per workspace, reading tier from the account. Model B aggregates across the account's workspaces (larger change).
- Over-cap stamping: Model A unchanged; the stamp still lives on `conversation.is_over_cap`, computed from the workspace's resolved tier. Model B computes against a pooled hour budget.
- `workspace_request`: still the change channel. On approval, the granted tier and terms write to the workspace's `billing_account`, not the workspace. Add `resulting_billing_account_id` alongside the existing `resulting_workspace_id`. For an org-scoped account, a single request can target the account directly.
- Staff direct change `set_workspace_tier`: becomes `set_billing_account_tier`, operating on the account; downgrade and over-cap recalculation iterate the account's covered workspaces.
- Downgrade effects (`tier_downgrade.py`): revert effects like clearing the whitelabel `logo_url` are per workspace, so an account-level downgrade must fan out across every workspace the account covers. Flag this explicitly; it is the one place pooling-vs-not leaks into Model A.
- Expiry crons: iterate `billing_account` rows instead of `workspace` rows. Notifications and emails target the billing-role members of the account's owner (org or workspace).
- Mollie (Phase 4): the billing account is the Mollie customer. Tier maps to a subscription; webhooks update `billing_account.tier`/`status`; overage (pioneer+) maps to metered or one-off charges. Webhook endpoint lands new; no existing handler to reconcile with.

## Frontend impact

- The billing settings surface follows the account. Workspace-scoped account: render in the workspace settings billing tab as today. Org-scoped account: render under org settings; the workspace billing tab shows a read-only "billed via {org account}" pointer.
- Keep surfacing a resolved `tier` on the workspace summary so `TierBadge`, `FeatureGate`, `UsageCard`, and most UI need no change.
- `UpgradeModal` already routes member requests to org admins; for an org-scoped account that is exactly the right audience, so the existing admin-chips path fits.
- `OrganisationUsageRollup` becomes the natural place to show an org account's covered workspaces and (if Model B) the shared pool.
- Billing roles (`workspace:view_invoices`, `org:view_invoices`, and the `update_payment` pair) map to who can see and manage the account. No membership change.

## Phased rollout

The work order is deliberate: build the billing-account entity first, then its UX, then payments. Mollie is explicitly last because "who pays, how they pay, admin overrides, who can see what" only matter once the entity and its flows exist.

- **Phase 1: the billing-account entity (data model).** New `billing_account` collection plus `workspace.billing_account_id` (NOT NULL). 1:1 backfill so every existing workspace gets a workspace-scoped account with its current tier and terms copied over (the "exactly one billing context, always" invariant). New `billing_account.py` resolver; switch all enforcement reads (`seat_capacity.py`, `policies.py`, over-cap, tier-change paths) to resolve tier through the account while keeping `workspace.tier` dual-written. No behavior change. Existing `test_tier_capacity`, `test_tier_expiry`, `test_tier_upgrade_kind`, `test_is_org_billing_only` should pass unchanged. Move the write paths (tier change, requests, expiry, downgrade) onto the account; `workspace.tier` becomes a computed API field only.
- **Phase 2: UX flows for the billing account.** Attach a billing account to an org or a workspace, re-point workspaces (the partner/handoff flow), org-scoped pooled seat metering and usage views, billing surfaces that follow the account's scope. Seats metered and shown, never blocked.
- **Phase 3: Mollie and payments.** Customer per account, subscription per tier with seat quantity, webhook endpoint, payment-method and invoice surfaces. This is where we settle who pays, how, the admin overrides (for example provisioning seats on an offline/invoice sale), and the visibility rules (who sees invoices and payment, via the existing `billing`/`admin`/`owner` roles).

The pricing overhaul (new tiers, EUR per-seat, +20% monthly, drop Pilot/Pioneer, hours-to-fair-use, analysis-as-integration, migrate existing customers to Changemaker) is a parallel track that lands on top of the account once Phase 1 exists. It is large enough to warrant its own ADR; this plan depends on it but does not block on it for Phase 1, since Phase 1 preserves the current tiers.

## Open questions

Resolved: capacity is pooled at the account level; same-org only in v1; currency EUR; seats metered not blocked; billable seat = member/admin/owner + external, billing role free; exactly one billing context per workspace (NOT NULL).

Still open:

1. Multiple accounts per org: one org account, or several (cost centers / departments) with each workspace pointing at exactly one? Proposed: allow several, workspace points at exactly one.
2. Org-scoped downgrade: when an org account downgrades, do all covered workspaces' frozen features revert together? Proposed: yes, fan out.
3. Innovator EUR price (USD figure was $20; confirm the EUR number).
4. Guardian price: a number, or "conversation" like Bespoke?
5. Mollie shape (Phase 3): one customer per account, subscription quantity from metered seats vs provisioned seats, and the sync trigger for metered quantity.
