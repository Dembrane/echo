---
title: Roles & policies in code
description: How policies.py enforces access - presets, the IAM-style policy model, tier gates, seats, inheritance, and how to add a capability or a role arm.
audience: developer-internal
---

# Roles & policies in code

Access control in dembrane is *policy-based, not role-based*. A *role* is a display label;
the enforcement source of truth is a *policy set*. Enforcement code always asks "does this
caller hold this policy?" - never "is this caller an admin?". This page is the engineer's view
of `echo/server/dembrane/policies.py` and the modules around it. For the conceptual model
(what each role can do, told plainly) see
[roles & permissions](../../features/roles-and-permissions.md).

> [!IMPORTANT]
> The pattern is AWS-IAM-inspired: presets are hardcoded in `policies.py`; the database stores
> only `custom_policies` (extras *beyond* the preset). Effective policies =
> `preset[role] + custom_policies`. Enforcement code calls `has_policy(...)`. If you find code
> branching on a raw role string for an access decision, that's a bug - route it through a
> policy.

## The presets

`policies.py` defines three preset dictionaries:

- `ORG_ROLE_PRESETS` - org-level. `member` (`org:view`), `admin` (manage users/settings/billing, create + view workspaces, view usage), `billing` (financial visibility across all workspaces - no invite/create/settings), `owner` (`["*"]`).
- `WORKSPACE_ROLE_PRESETS` - the workspace roles, the backbone of the product. `owner` (`["*"]`), `admin` (full project/content/member/settings/billing), `member` (author: read/create/update projects, delete conversations, chat, generate + publish reports, view usage), `billing` (financial only), `external` (a paid outside collaborator - read/update projects, read conversations, chat, view + generate reports), `observer` (free, read-only - read projects/conversations, view reports).
- `PROJECT_ROLE_PRESETS` - for private-project sharing (Innovator+). `viewer` and `editor`.

Each preset is an explicit allowlist. Anything not listed is implicitly denied. So `external`
deliberately lacks `workspace:view_usage`, `member:invite`, `report:publish`,
`project:create`, `conversation:delete`; `observer` deliberately lacks `chat:use`,
`report:generate`, `project:update` - hitting that wall is the observer→external upgrade
trigger.

## The functions you'll call

```python
get_effective_policies(role, custom_policies=None, presets=WORKSPACE_ROLE_PRESETS) -> list[str]
has_policy(role, custom_policies, required, presets=..., workspace_tier=None) -> bool
meets_tier(current_tier, minimum_tier) -> bool
```

- `get_effective_policies` expands a role into its policy list (preset + custom), normalising any legacy role first.
- `has_policy` is the one enforcement code calls. It returns `True` when the role's effective policies contain `"*"` or the `required` policy - *and*, if `workspace_tier` is passed and the policy is tier-gated, the tier check rides along automatically.
- `meets_tier` compares against `TIER_ORDER = ["free", "innovator", "changemaker", "guardian"]`.

### Tier gates ride along with the policy check

`TIER_REQUIRED_FOR_POLICY` maps policies to the minimum tier required:

| Policy | Minimum tier |
|---|---|
| `workspace:export`, `project:share`, `workspace:set_private`, `project:set_private` | innovator |
| `workspace:whitelabel`, `workspace:api_access`, `workspace:webhooks` | changemaker |

Because `has_policy` enforces this when you pass `workspace_tier`, an endpoint usually only
needs *one* call - the tier gate is not a separate check. Pass the workspace tier and the
gate is automatic; omit it (e.g. in tests) to bypass.

## Role hierarchy - escalation guard

`ROLE_HIERARCHY` orders the workspace roles for *escalation prevention*, not capability:

```
observer(0) < external(1) < member(2) < billing(3) < admin(4) < owner(5)
```

The invite endpoint (and any future role-change endpoint) uses this so a caller can only grant
a role *at or below their own* level. It is *not* a capability ranking - `billing` sits above
`member` here despite having no content access, because the number is about "what you're
allowed to hand out", not "what you can do". See ADR 0003.

## Staff policies

`STAFF_POLICIES` is a finer grain than "any Directus administrator":
`staff:can_set_tier`, `staff:can_set_visibility`, `staff:can_transfer`. Today the staff gate is
the JWT `admin_access` claim (see [architecture](./architecture.md#authentication)); the named
staff policies are wiring-in-progress reference for when a storage mechanism lands. Treat them
as the future seams for splitting up staff power.

### The admin panel API

The staff panel (`/admin`, `AdminSettingsRoute`) is server-gated: every route below re-checks
`admin_access`, so it can't be reached by guessing a URL. The [staff guide](../staff/index.md)
covers what each action does in plain terms; this is the route map behind it.

| Action | Endpoint | Extra staff policy |
|---|---|---|
| Usage & billing rollup | `GET /api/v2/admin/billing-rollup` (`?month_offset=` for the 12-month lookback) | - |
| At-risk inbox | `GET /api/v2/admin/at-risk` | - |
| Payments view | `GET /api/v2/admin/payments` (actions in `admin_managed.py`) | - |
| Change tier | `PATCH /api/v2/workspaces/{id}/tier` | `staff:can_set_tier` |
| Discount | `PATCH /api/v2/admin/workspaces/{id}/discount` | - |
| Grant reverse trial | `POST /api/v2/admin/billing-accounts/{id}/grant-trial` | - |
| Change admin | `POST /api/v2/admin/workspaces/{id}/change-admin` | - |
| Reset usage | `POST /api/v2/admin/workspaces/{id}/reset-usage` (requires a reason) | - |
| Partner toggle | `PATCH /api/v2/admin/orgs/{id}/partner` | - |
| Referral ledger | `GET /api/v2/admin/referral-ledger` | - |
| External-led orgs | `GET /api/v2/admin/external-led-orgs` | - |
| Set workspace visibility | (workspace visibility change) | `staff:can_set_visibility` |
| Transfer workspace | (owner handoff) | `staff:can_transfer` |

## Seats - `seat_capacity.py`

Seats are *computed from membership rows*, never stored as a count. The billable roles are:

```python
_SEAT_ROLES = {"owner", "admin", "member", "billing", "external"}
```

`observer` is deliberately absent - it's free. Key functions:

- `effective_seat_user_ids(workspace_id)` - the set of users that count toward seats in one workspace.
- `compute_effective_seat_state(...)` - returns `(seats_used, member_count, external_count, observer_count)`. Seats are *pooled across a billing account's workspaces*, and a person counts *once per workspace*.
- `count_pending_invites(workspace_id)` - pending invites count toward the cap (observer invites skip it).
- `assert_can_add_seat(...)` - note: seats are *metered, never blocked*. Invites are never walled by capacity; this surfaces state and messaging, it doesn't reject. See ADR 0005.

## Membership inheritance - `inheritance.py`

A user's *effective* workspace role is derived, not just read. `inheritance.py` folds together:

- their direct `workspace_membership` row,
- org-admin auto-join and org-member inheritance - gated by the workspace's `visibility` (`open_to_organisation` auto-joins org admins; `private` does not),
- sticky-removal records (`sticky_remove` / `sticky_unremove`) so an explicitly-removed user doesn't get re-inherited.

`derive_workspace_role(...)` produces the effective role; `user_can_access(workspace_id, user_id)`
returns `(role, source)`. When debugging "why can this person see this?", trace
`inheritance.derive_workspace_role` → `policies.get_effective_policies` → `has_policy`. Don't
stop at the membership table - the answer often lives in inheritance.

## Write-time invariants

Some rules are enforced when data is written, not at read time:

- `external` ⟺ no `org_membership` in that org (ADR 0003). To promote external→member, an admin removes the external row, adds the user to the org, and re-invites as member. There's no in-place "convert" button - the cross-table mutation is deliberate.
- `observer` only exists in external-client workspaces.* Internal workspaces reject observer invites (ADR for the free observer role; `seat_capacity` excludes observer from the seat pool).
- Legacy `viewer` rows* map to `member` at read time via `_normalize_legacy_role`, which logs a warning so ops can spot and convert lingering rows. There's no migration - convert at next touch.

## How to add a capability (a new policy)

1. *Name it* with the `domain:verb` convention (`project:read`, `workspace:export`, …).
2. *Add it to the relevant preset(s)* in `policies.py` (`WORKSPACE_ROLE_PRESETS` and/or `ORG_ROLE_PRESETS`/`PROJECT_ROLE_PRESETS`) for every role that should have it. Remember: presets are allowlists - only the roles you list get it.
3. *Gate it by tier* if needed by adding an entry to `TIER_REQUIRED_FOR_POLICY`. Then any `has_policy(..., workspace_tier=...)` call enforces it for free.
4. *Enforce it* at the endpoint by calling `has_policy(role, custom_policies, "your:policy", workspace_tier=...)`. Never branch on the role string.
5. *Reflect it in the matrix* in [roles & permissions](../../features/roles-and-permissions.md) so the docs and the capability table stay true.
6. *Frontend display* is separate - `echo/frontend/src/lib/roles.ts` (`displayRole`, `roleColor`, `ROLE_HIERARCHY`) handles how roles render (observer & external render grey). Adding a policy doesn't touch this; adding a *role* does.

## How to add a role arm

Adding a whole role is heavier - it touches presets, the hierarchy, seats and inheritance:

1. Add the role to the relevant `*_ROLE_PRESETS` with its allowlist.
2. Add it to `ROLE_HIERARCHY` at the right rung (this controls who can grant it).
3. Decide whether it consumes a seat - add to or omit from `_SEAT_ROLES` in `seat_capacity.py`.
4. Teach `inheritance.py` how the role interacts with org membership and visibility (e.g. the external/observer "no org_membership" invariant).
5. Wire the invite branches (`api/v2/invites.py`, `_invite_helpers.py`) and the frontend role display.
6. Write the write-time invariants and document the upgrade/downgrade path.

> [!WARNING]
> Roles aren't free to add. The five-role collapse (matrix v1.1) plus observer was a
> deliberate simplification. Prefer a new *policy* on an existing role over a new role.
> Read ADR 0003, 0004 and 0005 before proposing one.

## The ADRs that govern this

- *ADR 0003* - external as a stored role (removed the `is_external` boolean; the role/org-membership invariant).
- *ADR 0004* - the unified invite modal and org-only membership (org membership independent of workspace membership).
- *ADR 0005* - the per-seat tier overhaul (seats, pooling, metered-not-blocked, the four tiers).

They live in `echo/docs/adr/`.

---

*Related*

- [Roles & permissions (feature)](../../features/roles-and-permissions.md)
- [Tiers & billing (feature)](../../features/tiers-and-billing.md)
- [The data model](./data-model.md)
- [Architecture - authentication](./architecture.md#authentication)
