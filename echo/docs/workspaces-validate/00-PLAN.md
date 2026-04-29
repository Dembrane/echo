# Working plan

Session start: 2026-04-23. Branch: `workspaces`.

Goal (brief): bring workspaces release across the finish line — release blockers built + tested + committed, flow/screen specs match what shipped, matrix ↔ checklist ↔ product mutually consistent.

## Sequencing rationale

Two hard constraints drive order:

1. **Derivation walkback (Flow 0) precedes Flows 1 / 4 / 6.** Matrix v1.1 retires derived inheritance; any UI built on top of the old `user_can_access` walker will be wrong.
2. **Stop conditions before destructive ops.** Backfill explicit Admin rows is a stop condition — dry-run first, Sameer confirms row count, then apply.

## Phases

### Phase A — Orient (done)

- Read matrix, checklist, brand, CLAUDE, companion design docs.
- Inventory repo + doc state → `00-DOC-AUDIT.md`.
- Gap analysis → `02-DELTA.md`.
- Bundle blocking questions → `04-QUESTIONS-FOR-SAMEER.md`.
- Seed `03-DECISIONS.md`, `05-PROGRESS.md`, this plan.

### Phase B — First sync with Sameer (gate)

Halt. Send over:
- Doc audit + delta + questions
- Proposed phase order below
- Flag: uncommitted working tree (Q4) needs call before I touch notifications / emails / scripts / auth routes.

Do not proceed past this gate without at minimum Q1, Q2, Q3, Q4 answered.

### Phase C — Canonical screens (brief §"The 7 canonical screen patterns")

Write specs for all 7 in `screens/` before instantiating flows. One file per pattern. Each spec is:
- Name + intent (1–2 sentences)
- Copy skeleton (role-aware where applicable)
- Component references (existing + to-build)
- Variants (empty / loading / error / success)
- Non-goals

Patterns (order):
1. `feature-locked.md` — already largely shipped in `FeatureGate.tsx`; reverse-document + flag gaps.
2. `status-banner.md` — 3 intrusion levels. Needed by every tier-gate + quota flow.
3. `request-submitted.md` — upgrade request, join request, handoff pending.
4. `destructive-confirm.md` — delete workspace + demote + downgrade.
5. `manage-list.md` — members, invites, settings rows.
6. `empty-state.md` — first-encounter hero + action.
7. `readonly-data.md` — usage rollup, member list, audit log, referral ledger.

### Phase D — Flow specs (brief priority order)

One file per flow under `flows/`. Each flow ≤ 1 page, referencing canonical screens.

Priority 0 first (derivation walkback — backend, not UI but spec it); then 1–15 per brief. Target: top 5 flows for second sync, then iterate.

### Phase E — Build (release blockers + matching flows)

Work release blockers + remaining checklist tasks in dependency order. Small commits, one session tag per commit (e.g. `S9: workspace creation wizard — visibility step`). Update `05-PROGRESS.md` after each commit.

Release blockers (brief §"Release blockers"):
1. Organisations admin page expansion (Ask 1 list ⇄ matrix ⇄ projects) — S7
2. Tier set/change staff inline (Ask 2s) — S8
3. Workspace suspend — **per matrix reconciliation, not this release.** Drop from blocker list; access-blocking is covered by tier downgrade + soft-delete + membership removal.
4. Delete workspace endpoint + UI — endpoint done; UI needs wiring to settings tab + project-exists error
5. Onboarding split — S13, partial
6. Email polish + plain-text fallback — mostly done per autonomous notes; verify live (Q4 working tree)

Matrix-added blockers beyond checklist (`02-DELTA.md`):
- Derivation walkback (backfill + simplify resolver + drop sticky_removed)
- `workspace.visibility` enum migration
- Slack-style discovery endpoints (join + request-access)
- `billing` role (pending Q1)
- Hour meter + Pilot hard-block (pending Q3)
- M1 CSV migration tool (pending Q7)
- `staff:can_set_tier` policy + default-inbox switch
- Tier capacity matrix surface (billing tab + upgrade modal)
- Downgrade confirmation dialog + 7-day banner + admin email
- Honesty disclosure on private workspace creation

### Phase F — Migration specs (writing only; execution later)

`migration/M1.md` through `M6.md` mirror matrix sections. Not executed this session.

### Phase G — Final sync + release

Once blockers land + smoke tests green + flow specs match product:
- Run existing test suite before each commit (per brief Dev Loop).
- No push until Sameer confirms at delta gate.
- Final commit bundle on `workspaces` branch.

## Time budget (rough)

Brief suggests A is 30 min. Realistic:
- A: done
- B: gate — depends on Sameer
- C: 2–3 hours (7 screen specs)
- D: 3–4 hours (15 flows, top 5 first)
- E: biggest chunk — days. Phase into its own planning passes.
- F: 1–2 hours once E settles
- G: ship

## Escape valve

If I find mid-work that any of:
- The derivation walkback can't cleanly backfill (would require dropping a customer's access)
- The uncommitted working tree is incoherent (Q4)
- `billing` role ripples deeper than expected (schema → email templates → invite token flow)
- Hour meter derivation from `conversation.duration` doesn't match what customers see today

→ stop, log in `05-PROGRESS.md`, add to `04-QUESTIONS-FOR-SAMEER.md`, continue on unblocked work.

## What I'm explicitly not doing

Per brief anti-goals:
- No pricing page, no marketing surface
- No rename of `owner/admin/member/viewer` or `is_external` at the DB layer (except adding `billing` pending Q1, and the visibility enum pending Q2)
- No `suspended_at` field
- No invite reminder cron, trash/restore UI, org billing rollup, audit log UI, usage_event reinstatement (unless Q3 flips)
- No post-release features
- No features matrix explicitly leaves open (languages, library views, agentic chat stay open)
- Not touching the participant portal for any gate

## Handoff shape for next session

If this session times out mid-phase:
- `05-PROGRESS.md` is the authoritative resume point
- Unshipped items stay in `02-DELTA.md` with updated status
- Open questions stay in `04-QUESTIONS-FOR-SAMEER.md`
- Commit log + checklist tell the code story
