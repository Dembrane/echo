# Per-seat tier overhaul

## Status

proposed (2026-06-16)

Depends on the billing-account split (`docs/plans/billing-account-split.md`). Supersedes parts of ADR 0001 and ADR 0002 (see Consequences). ADR 0003 and ADR 0004 are unaffected in substance.

## Context

The current matrix (free, pilot, pioneer, innovator, changemaker, guardian) splits buyers by compliance context, prices each tier as a flat per-month figure, and caps audio hours per tier. Customer research found that the valued things are EU hosting and the security it implies, reduced admin burden (we help them run events, produce trainings, use the tool well), and that the product is a genuine time-saver. The pricing pain points were that getting started was expensive (a usable single-user setup on Pioneer was about €200/mo) and that every tier capped hours. The hour cap was a proxy for analysis/chat context cost, not for recording or transcription, which are cheap. Combined with EU AI Act high-risk concerns across much of the customer base, the model was hard to start with.

We are simplifying to per-seat pricing, removing hour caps on paid tiers, and re-cutting the tiers around analysis capability and compliance level rather than capacity.

## Decision

- **Tiers become: Free, Innovator, Changemaker, Guardian.** Pilot and Pioneer are removed. Innovator and Changemaker are redefined.
  - **Free** (unchanged): 1 hour of recording, single user, open registration.
  - **Innovator** (coming soon): per seat / month, no built-in analysis. In-app chat becomes a bring-your-own-tool integration: connect ChatGPT or Claude through an MCP we will release. EUR figure to be confirmed (quoted as $20).
  - **Changemaker**: €75 per seat / month. Batteries included: EU-hosted Gemini Flash for in-product analysis.
  - **Guardian** (coming soon): CLOUD Act safe, full stack on EU cloud providers (for example OVHcloud) with EU-sovereign LLMs hosted, ideally built, in the EU. For municipalities and large enterprises. Price to be set.
  - **Bespoke** compliance is a conversation; self-hosting is available.

- **Pricing is per seat, in EUR, for all tiers.** Billed yearly by default; monthly is 20% more. `MONTHLY_BILLING_PREMIUM_PCT` becomes 20 (was 10 in ADR 0002).

- **Hours stop being a paid-tier lever.** All paid tiers have unlimited recording and transcription under fair use (fair use = a legitimate purpose). Only Free keeps an hour cap (1 hour). The per-tier `included_hours` / `hour_overage_eur` matrix fields and the over-cap machinery from ADR 0001 apply to Free only.

- **Tier encodes analysis capability and compliance, not capacity.** The headline gate moves from hour/feature caps to analysis: Innovator has no built-in analysis (BYO via MCP), Changemaker bundles EU Gemini, Guardian is the sovereign stack. The gate lives in `policies.py`.

- **Seats are metered, never blocked.** Seat usage is always computed from membership across the billing account's covered workspaces, always visible, and billed, but invites are never walled. This continues the "no hard limits" / "recording never fails" principle from ADR 0001. A blocking seat overage concept is removed.

- **Billable seat = `member` / `admin` / `owner`, plus `external`.** External members consume a paid seat when added to an artifact in the billing context. The `billing` role is unpaid and unlimited (financial visibility only). There is no "guest" concept (ADR 0003).

- **No upsell scattered across the app.** The analysis gate presents as an integration surface ("connect your own tool to analyze your data"), not the `FeatureGate` hatched-overlay-everywhere pattern.

- **Existing paying customers migrate to Changemaker with unlimited hours until their subscription renewal date.** Free stays Free.

## Consequences

- **`tier_capacity.py` is reshaped.** Price becomes per-seat EUR; `included_hours` and `hour_overage_eur` survive only for Free; `included_seats` / `seat_overage_eur` blocking semantics are removed in favor of metered counts. `TIER_ORDER` and the enum shrink to free / innovator / changemaker / guardian.

- **The `tier` enum migration is breaking.** Pilot and Pioneer are dropped; existing rows on those tiers (and on the old Innovator/Changemaker definitions) are migrated to the new Changemaker per the rule above. This is a data migration, run per environment, documented in `docs/database_migrations.md`.

- **ADR 0001 reduces to Free-only.** The `is_over_cap` stamp, `task_stamp_conversation_on_finish`, live-lock computation, and hour overage now only ever matter on Free. The paid-tier branches of that logic are dead and should be removed, not left dormant.

- **ADR 0002 is amended.** The monthly premium constant becomes 20, and the `pricing` object becomes per-seat. The annual/monthly toggle and the proposed/approved billing-period capture on `workspace_request` are unchanged in shape.

- **ADR 0004's invite modal stops blocking.** The hard-disable of workspace rows on hard-block tiers and the soft-cap overage warning both go away; the modal shows a metered seat count and never prevents an invite.

- **`policies.py` gains an analysis/chat gate and loses hour gates.** The new gate keys chat/analysis on Changemaker and above; the export/share/whitelabel/private tier gates are revisited against the four-tier set.

- **Frontend copy and i18n sweep.** Tier names, taglines, capacity strings, and the upgrade surfaces in `lib/tiers.ts` and the workspace components change across en, nl, de, fr, es, it. `pnpm messages:extract` is on the critical path.

- **Coming-soon tiers.** Innovator and Guardian are not immediately purchasable; the UI must represent "coming soon" without dead ends.

- **Trainings are a separate epic** but the data model should leave room for a per-user training flag and a later auditing system for high-risk-environment users.

## Open

- Innovator EUR price (quoted $20; confirm EUR).
- Guardian price (number, or conversation like Bespoke).
- Exact EU-hosted Gemini model for Changemaker (product intent says Gemini 3.5 Flash; reconcile with the current `MULTI_MODAL_*` groups in `AGENTS.md`).
