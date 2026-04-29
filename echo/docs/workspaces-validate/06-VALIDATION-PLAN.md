# Validation plan — subagent reviewers

Four axes, dispatched in parallel at three cadences. Findings land in `06-AUDIT-LEDGER.md`. Critical findings are stop conditions.

## Axes

### Security (cybersec)

Scope — dispatch when any of these change:
- API endpoint (route, method, payload, permission guard)
- Policy definition or `TIER_REQUIRED_FOR_POLICY` map
- Directus collection permission
- Middleware (`get_workspace_context`, `user_can_access`)
- Migration script
- Environment variable that controls access

What it checks:
- Auth bypass — can a session without the required role reach the endpoint?
- IDOR — swap a `:projectId` / `:workspaceId` / `:orgId` for one the caller shouldn't see
- Tier-gate bypass — does every gated surface pass `workspace_tier` into `has_policy()`? Does the Directus SDK path honor the same gates as the BFF path?
- Cross-tenant leakage on list endpoints — org A can't see org B's workspaces/projects
- Input validation — Jinja autoescape on all user-provided template inputs, URL scheme allowlist for logos, HMAC token replay + expiry, CR/LF strip on subject-like fields
- Rate limits on abuse-prone endpoints (upgrade-request, invite send, join-request)
- `deleted_at IS NULL` on reads; destructive paths set the timestamp
- Migration safety — dry-run default, lockfile for `--apply`, `script_start_iso` cutoff, corrupted-JSON tolerance
- **Participant portal never blocks** — recording / upload / transcription survive any tier state, including Pilot hard-block
- **Last-admin protection** — cannot demote self or be removed if last admin at workspace or organisation
- `staff:can_set_tier` narrower than `auth.is_admin` where matrix requires

### Human-first design

Scope — dispatch for:
- New flow spec (`flows/*.md`)
- New canonical screen spec (`screens/*.md`)
- Flow implementation at commit time

What it checks:
- Matrix invariants present (recording is a participant act; tier gates never touch the participant portal; role + tier visible on every workspace card)
- Role change UX: toast + notification + first-visit banner; no affordance disappears mid-click
- State is URL-driven where shareable — tabs, filters, selected entity
- Confirmation gravity matches action: type-to-confirm for delete-workspace; plain confirm for role change; no confirm for idempotent settings
- Honesty disclosures present — private-workspace create shows "Organisation admins can still discover and join this workspace"
- Request/wait states exist for async actions — upgrade request, join request, handoff pending each render a "submitted, waiting" screen
- Member / Admin / Billing / Guest views are genuinely differentiated, not labelled
- Progressive solo experience — 1-workspace user doesn't see "workspaces" language
- Degradation: feature-locked surfaces render a placeholder, never mount the gated subtree (keyboard / pointer hygiene)

### Brand

Scope — dispatch for:
- Any UI change (`frontend/src/**/*.tsx`, CSS tokens)
- Email templates (product `server/email_templates/` and Directus `directus/templates/`)
- System-generated strings

What it checks (from `brand/STYLE_GUIDE.md`):
- "dembrane" lowercase, always
- No bold — Royal Blue `#4169e1` or italics for emphasis
- Palette: Parchment `#f6f4f1` canvas, Graphite `#2d2d2c` text, Royal Blue primary action. System states Golden Pollen / Cotton Candy only for warning/error
- DM Sans with stylistic alternates ss01-ss06
- Phosphor icons, regular weight, paired with labels where clarity matters
- `alwaysDembrane` prop on `DembraneLoadingSpinner` in whitelabel-safe contexts
- One clear action per card
- No `@mantine/charts`; no stock or AI-generated imagery
- Never two alerts stacked; either error or info, not both
- Email: brand logo header, typography scale, plain-text fallback

### Copy

Scope — dispatch for:
- Every user-facing string, error, toast, empty state
- Every email body (subject + preview text + body + signature)
- i18n `.po` files (all locales)

What it checks:
- Vocabulary: "language model" not "AI"; "participants / hosts" not "users"; "partners / clients" not "customers"; "the platform" or "dembrane" not "the tool"
- Never "successfully", never "please", never "click here", never "in order to", never "we apologize"
- Labels above inputs; placeholder is not a label substitute
- Validation errors inline, close to the field
- Loading copy is active voice ("Analyzing…" not "Please wait while we process")
- Empty states welcome, don't scold ("No conversations yet. Start your first one.")
- Dutch uses je/jij/jou informal; keep English terms where they sound better (Dashboard / Upload / Chat)
- Show emails on hover only; don't display by default in lists
- No "new conversation" buttons in UI — conversations come from QR or upload
- Prefer text buttons over icon-only for important actions
- Matrix participant-reassurance line present on any hard-block copy

## Cadences

### Spec-time (fast, two axes)

When: as `flows/*.md` and `screens/*.md` drafts land.
Dispatch: **brand + copy**, in parallel.
Turnaround target: under 2 minutes.
What I do with output: fix inline before the draft ships to the build queue.

### Build-time (full, four axes)

When: code for a blocker lands but before I commit.
Dispatch: **security + design + brand + copy**, all four parallel, one message.
Input scope: exact file diffs of the pending commit.
Turnaround: under 5 minutes; subagents return structured lists, not prose.
What I do with output:
- `critical` → fix before commit
- `high` → fix before commit unless explicitly deferred with reason
- `medium` → log in audit ledger + fix in same phase
- `nit` → log

### Phase-boundary (cross-cutting)

When: before pinging Sameer for a gate sync.
Dispatch: all four on the full changeset since last gate + the relevant flow specs.
Input: list of files changed + list of flows implemented in the phase.
Turnaround: under 10 minutes.
What I do with output: ledger + fix list before the sync message.

## Output format expected from each subagent

```
Finding N
- Severity: critical | high | medium | nit
- Axis: security | design | brand | copy
- File: server/dembrane/api/v2/workspaces.py:627
- Issue: <one sentence>
- Fix: <one sentence or snippet>
```

No prose, no preamble, no summary paragraphs. Bullet-style output so I can paste into the ledger.

## Not-excessive discipline

- Only dispatch axes relevant to the change. Backend policy edit: security only.
- Skip all axes for pure doc writes.
- Skip the security axis on code already cleared in the three prior audit rounds unless I modified it. The `audit-summary` and `fix-ledger` commits (`f2bfb2f`, `8aba15d`, `deb6597`, `4646825`) are the clearance baseline.
- Always pass explicit file-path scope. Never "audit the whole release."
- Never launch `/ultrareview` — user-triggered per CLAUDE.md.

## Stop conditions (from brief)

- `critical` security finding affecting access control → halt, log in `05-PROGRESS.md`, ask Sameer.
- Migration blast radius uncertain → halt at dry-run.
- Matrix invariant violated (tier gate reaches participant portal, last-admin protection bypassable) → halt.
- Brand or copy finding does **not** halt — it goes in the ledger and gets fixed in the same phase.

## Ledger

`06-AUDIT-LEDGER.md` — append-only. One entry per finding. Severity / axis / file / issue / fix / resolution-commit. So the next session can see what's already cleared and what's deferred.
