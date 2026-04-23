# Brief — onboarding fixes

Self-contained brief for a fresh Claude Code session. Scope: six changes uncovered during live QA of the workspaces onboarding flow on 2026-04-23. Each change cites the exact file and line to edit. Do not scope-creep.

Full QA evidence — including screenshots, API responses, and the blocker's root-cause trace — lives in [qa/pains.md](pains.md) and [qa/questions.md](questions.md) next to this brief.

## Context in one paragraph

Solo user registers → verifies email → logs in → names their team on `/en-US/onboarding` → `POST /api/v2/onboarding/complete` creates an `org`, `org_membership` (owner), and a `workspace` (tier `"pioneer"`) → then calls `on_workspace_created(...)` to insert the creator's `workspace_membership` row → on success, frontend navigates to `/w/<ws-id>/projects`. A session-blocker bug in the call to `on_workspace_created` (already patched live) left `solo1` in a partial state where the workspace exists but no `workspace_membership` row was inserted; on retry the endpoint took the "workspace already exists" branch and never re-attempted the membership insert. `GET /api/v2/workspaces` then short-circuits to `{workspaces: [], teams: []}` and `/en-US/w` renders "No workspaces yet." Sameer also confirmed three product decisions that need code changes.

## Changes

### 1. Default tier is `pilot`, not `pioneer`

New workspaces should be created on the Pilot tier. `tier_capacity.py` already defines `pilot` (€349 one-time, 10 hrs hard-block, 2 seats, 2 guests, 1-month duration) and `pioneer` (€200/mo, 25 hrs soft-cap). Creation paths currently write `"pioneer"` — change to `"pilot"`.

- `echo/server/dembrane/api/v2/onboarding.py:304` — change `"tier": "pioneer"` to `"tier": "pilot"` on the default-workspace creation inside `complete_onboarding`.
- `echo/server/dembrane/api/v2/workspaces.py:437` — change `"tier": "pioneer"` to `"tier": "pilot"` on `POST /v2/workspaces`.
- `echo/server/dembrane/api/v2/workspaces.py:483` — change `tier="pioneer"` in the echoed `CreateWorkspaceResponse` so the response matches what was stored.
- `echo/server/dembrane/api/v2/workspaces.py:427` — comment reads `# Tier is always "pioneer" on creation …` — update to `pilot`.
- `echo/server/dembrane/api/v2/schemas.py:141` — same comment (`# tier is always "pioneer" on creation …`) — update to `pilot`.

Do **not** touch the many `ws.get("tier", "pioneer")` read-site defaults across the codebase. Those fallbacks apply to rows already in the DB; changing them risks silently downgrading existing pioneer workspaces if the column is ever NULL. Out of scope for this brief.

### 2. Avatar initials = first-name-initial + last-name-initial

Currently shows `SA` for "Sameer" (`.slice(0,2)` of the first name). Should show `SS` for "Sameer Solo1".

- `echo/frontend/src/components/common/UserAvatar.tsx:16-17` — replace:
  ```ts
  const initials =
      (user?.first_name as string)?.slice(0, 2)?.toUpperCase() ?? "?";
  ```
  with:
  ```ts
  const first = (user?.first_name as string)?.trim() ?? "";
  const last = (user?.last_name as string)?.trim() ?? "";
  const initials =
      ((first[0] ?? "") + (last[0] ?? "")).toUpperCase() ||
      first.slice(0, 2).toUpperCase() ||
      "?";
  ```
  The fallback keeps `SA`-style two-letter output if `last_name` is empty (which Directus allows — see `Register.tsx:71-79` comment explaining the empty-string workaround).

### 3. Post-onboarding landing goes to `/w`, not `/w/<id>/projects`

Sameer's call: a user coming out of onboarding should land on the workspace home page so they see the team + workspace grid, not be dropped straight into an empty project list.

- `echo/frontend/src/routes/onboarding/OnboardingRoute.tsx:79-85` — the `goToProjects` helper currently does `navigate(\`/w/${workspaceId}/projects\`)` when it has a workspace id. Change it to always `navigate("/w")`. Rename the function too (`goToHome`) to match the new behavior — the old name is a lie.

### 4. Onboarding must re-insert `workspace_membership` on retry

Root cause of the blocker I hit: when `complete_onboarding` re-runs for a user who already has an org + default workspace but no `workspace_membership`, the `else` branch at `onboarding.py:297-318` is skipped (because `existing_ws` is truthy at line 295), so `on_workspace_created` never runs and the creator's membership row is never written.

- `echo/server/dembrane/api/v2/onboarding.py:279-318` — after the if/else that resolves `personal_ws_id`, add an **unconditional** idempotent upsert of the creator's `workspace_membership` row (check existing by `(workspace_id, user_id, deleted_at IS NULL)`, insert if missing with `role="owner"`, `source="direct"`, `is_external=False`). Keep the existing `on_workspace_created(...)` call inside the new-workspace `else` branch so it only runs on genuine workspace creation. The new upsert should mirror what `on_workspace_created` writes so reruns converge to the same row shape.

- `echo/server/dembrane/api/v2/workspaces.py:165-192` (listing endpoint) — the early return at line 191-192 drops the user to `{workspaces: [], teams: []}` whenever they have zero workspace memberships, even if they own a team via `org_membership`. Change the contract: always compute `teams` from `org_memberships` (moved out of the block starting at line 310), then return workspaces (possibly empty) alongside teams. A team-owner with zero workspace rows should still see their team rollup so they can create a workspace there. The frontend empty-state logic at `WorkspaceSelectorRoute.tsx:548` already handles `workspaces.length === 0 && teams.length === 0` separately from the `teams.length > 0` path, so this change will naturally reveal the existing team-hero + `AddWorkspace` card for the stuck user.

After both fixes, re-running `POST /api/v2/onboarding/complete` for a broken user should un-stick them.

### 5. Repair the `solo1` test account

The `solo1` account is currently in the partial-write state this brief fixes. Once changes #4 land, call `POST /api/v2/onboarding/complete` as that user (body `{"org_name": "Sameer's Team"}`) — the new upsert branch will insert the missing `workspace_membership` row. Confirm by hitting `GET /api/v2/workspaces` and seeing the `Default` workspace in the response.

Account details:
- email `sam.pashikanti+solo1@gmail.com`, password `demo1234`
- directus_user `623ef97f-03f3-4c3b-8923-1dc43f5b338e`
- app_user `8842e94f-1b88-4fc2-b785-70a944e0df0b`
- org `3160f520-087c-41c8-9938-90dbd395bd73` "Sameer's Team"
- workspace `a41f59dd-7384-40b1-895b-51779dc64d60` "Default"

If #4 is landing in a separate PR, repair `solo1` manually in Directus by inserting one `workspace_membership` row with the values above (role `owner`, source `direct`, is_external `false`) so QA can keep running.

### 6. Onboarding page layout polish

This one is visual, flagged by Sameer during QA (screenshot at [qa/\_shots/04-onboarding-team-full.png](_shots/04-onboarding-team-full.png)).

Two specific complaints on the `/en-US/onboarding` team-name step:
- The decorative illustration sits pinned to the top-left of the viewport, visually orphaned from the form card further down. It reads as a header that got left behind.
- The "Use default" button sits next to the primary "Get started" button with near-equal weight, but the input is pre-filled with the default value — so the button is a no-op on page load and its affordance is misleading.

Suggested fixes (pick one, don't do both):
- **Smaller diff:** drop the "Use default" button entirely — the input already shows the default value and the user can just click "Get started". If a reset is needed after the user has edited, show a subtle "Reset" link only while `orgName !== defaultOrgName`.
- **Bigger diff:** restructure the page into a centered single-column card that pulls the illustration into the card's header. Removes the orphan-image problem and collapses the empty right-side whitespace. This may warrant a separate design pass.

Do #6 last — #1-#5 unblock QA, #6 is polish.

## How to verify (end-to-end happy path)

1. Register a fresh account `sam.pashikanti+solo-verify@gmail.com` via `/en-US/register`.
2. Click the verification link.
3. Log in. You should land on `/en-US/onboarding` with avatar initials matching `first_name[0] + last_name[0]`.
4. Name the team, click "Get started".
5. Expect redirect to `/en-US/w` (not `/w/<id>/projects`).
6. `/en-US/w` should show a team hero card "Sameer's Team" with one workspace card "Default" marked as pilot tier.
7. Hit `GET /api/v2/workspaces` — verify `workspaces[0].tier === "pilot"`, `workspaces[0].role === "owner"`, and `teams[0].name === "Sameer's Team"`.
8. Repeat `POST /api/v2/onboarding/complete` with body `{"org_name": "Anything"}` — it should return 200 without creating duplicate memberships (idempotency check — count rows before and after, should be identical).

## Out of scope for this brief

These came up during QA but are not part of the fix set:

- Post-verify login page (`?new=true`) — no tailored welcome banner. Captured as `[rough]` in pains.md.
- `/verify-email` missing `/en-US/` locale prefix. `[note]`.
- Tab title stays "Register | dembrane" on the "Check your email" step. `[note]`.
- No "Resend" / "wrong email?" affordance on the "Check your email" step. `[rough]`.

None of these block onboarding and they each deserve their own small PR.
