# Workspace inheritance — codified rules (derived model)

**Status:** canonical. Any code that answers "does user U have access to workspace W?" or "who is on workspace W?" must go through the resolvers defined here. **Inherited admin access is not stored — it is derived at query time.**

**Supersedes:** the trigger-based fan-out model briefly codified in an earlier draft of this file on 2026-04-20. That model is gone. There are no `workspace_membership` rows with `source='inherited'`. If you see one, it's legacy from a pre-derivation-migration state and must be archived.

---

## Core principle

> **Rule-of-system:** every **open** workspace in a team includes every current + future team owner/admin as an inherited admin. Private workspaces never include anyone automatically. Inheritance is a **function of current state**, not a stored fact. If you change the state (promote, demote, flip privacy, remove from team), access recomputes on the next read — no triggers, no fan-out, no drift.

Flags that drive the derivation:
- **`org_membership.role`** — only `owner` and `admin` contribute to inheritance. `member` does not.
- **`workspace.settings.inherit_team_admins`** — boolean, default `true`. `false` = private workspace; no inheritance.
- **`workspace.settings.inherit_team_members`** — boolean, default `false`. `true` = team members (org role `member`) also inherit. Exposed via the creation wizard's second checkbox (when the user picks "Open").
- **`workspace.settings.sticky_removed`** — JSON array of `{user_id, removed_at, removed_by}`. If a user is in this list, they are never re-granted inherited access via any derivation path.

---

## Access resolution — one function, priority order

```
user_can_access(workspace_id, user_id) → role | None
```

Resolution order:

1. **Direct workspace membership.** `workspace_membership` row exists for `(ws, user)` with `deleted_at IS NULL`. Return its role. No further checks.
2. **Project-level share** (only relevant when caller is resolving access to a specific project inside a private project). Delegates to `get_user_project_access()` — see PRD §"Permission Resolution".
3. **Inherited admin** (derived):
   - Workspace has `settings.inherit_team_admins == true`, **and**
   - User has an active `org_membership` in the workspace's org with role `owner` or `admin`, **and**
   - User is **not** in `workspace.settings.sticky_removed`.
   - ⇒ return `'admin'`.
4. **Inherited member** (derived, only if workspace has `settings.inherit_team_members == true`):
   - Workspace has `settings.inherit_team_admins == true` (admins-only open workspaces don't fan to members), **and**
   - User has an active `org_membership` with role `member`, **and**
   - User is **not** in `workspace.settings.sticky_removed`.
   - ⇒ return `'member'`.
5. **Otherwise** — `None` (no access).

Direct always wins. If a user is `source='direct'` with role `member`, and they're also a team admin, they see the workspace as a member (direct row beats derivation). This is intentional: direct is an explicit, audited state; derivation is ambient.

---

## Member list resolution

```
get_effective_members(workspace_id) → list[EffectiveMember]
```

Returns the union of:
- every direct `workspace_membership` (source recorded as `'direct'`)
- every derived team admin (source `'inherited'`, role `'admin'`) — computed as in step 3 above
- every derived team member (source `'inherited'`, role `'member'`) — if `inherit_team_members=true`, computed as in step 4

Deduplication: if a user has a direct row, they appear only once with their direct role — the derivation is suppressed in the output. Users in `sticky_removed` never appear as inherited.

This function is what the Teams admin page, workspace members tab, and seat-count queries all call.

---

## Storage model

**Stored:**
- `org_membership` — (org_id, user_id, role) — the source of truth for team membership and role
- `workspace_membership` — only `source='direct'` rows. These represent explicit invites.
- `workspace.settings.inherit_team_admins` — boolean flag
- `workspace.settings.inherit_team_members` — boolean flag
- `workspace.settings.sticky_removed` — JSON array of tombstones

**Not stored (derived):**
- Inherited admin access
- Inherited member access
- Effective role for users not in `workspace_membership`

---

## Transitions — what happens when…

Because access is derived, most transitions are no-ops for the inheritance layer. The state change on the stored table is enough; the next access check reflects it.

| Event | What to store | What to call |
|---|---|---|
| Workspace created (via `POST /v2/workspaces`) | Insert one `workspace_membership` for the creator with `source='direct', role='owner'`. Set `settings.inherit_team_admins` + `inherit_team_members` per wizard choice. | `inheritance.on_workspace_created()` (small helper; no fan-out) |
| Team admin invites a new person to the team | Insert `org_membership` with the chosen role. | Nothing in inheritance — derivation picks them up on next read |
| Team member promoted to admin/owner | Update `org_membership.role`. | Nothing — derivation sees the new role immediately |
| Team admin demoted to member | Update `org_membership.role`. | Nothing — derivation stops including them on open workspaces where they were inherited. Direct rows survive (they're explicit). |
| Team member removed from the team | Soft-delete `org_membership`. | Call `inheritance.on_team_member_removed()` which soft-deletes their `source='direct'` workspace_membership rows in this org. Inherited access stops automatically. |
| External user added as an explicit workspace member | Insert `workspace_membership` with `source='direct', is_external=True`. No `org_membership`. | — |
| External user is later added to the team | Insert `org_membership`. `is_external=True` on any existing workspace_membership rows becomes stale — reconcile to `False` on those rows. Derivation now applies to any workspace they're a team admin for. | `inheritance.on_external_became_internal()` |
| Internal user later loses team membership (becomes external) | Soft-delete `org_membership`. Direct rows on workspaces survive (explicit state). Any rows in this org should set `is_external=True` so UI renders correctly. | `inheritance.on_internal_became_external()` |
| Workspace privacy flipped open → private | Update `settings.inherit_team_admins = false`. | Nothing — derivation stops granting inherited access on next read |
| Workspace privacy flipped private → open | Update `settings.inherit_team_admins = true`. | Nothing — derivation grants inherited access on next read, minus anyone in `sticky_removed` |
| Admin "removes" an inherited member from a workspace | Add `{user_id, removed_at, removed_by}` to `workspace.settings.sticky_removed`. | `inheritance.sticky_remove(workspace_id, user_id)` |
| Workspace soft-deleted | Soft-delete `workspace`. All direct memberships hidden by `deleted_at IS NULL` filters. Derivation returns None for a deleted workspace. | — |

The only two triggers left are **(a) workspace creation** (set the flags + insert creator row) and **(b) sticky-remove on explicit kick**. Plus the external-↔-internal reconciliation helpers, which are one-liners.

---

## Sticky removal — representation

`workspace.settings.sticky_removed` is a JSON array of tombstones:

```json
{
  "sticky_removed": [
    { "user_id": "uuid", "removed_at": "2026-04-21T10:30:00Z", "removed_by": "uuid" }
  ]
}
```

Checks:
- `is_sticky_removed(workspace, user_id)` = `user_id in [t['user_id'] for t in workspace.settings.sticky_removed or []]`
- `sticky_remove(workspace_id, user_id, by_user_id)` appends a tombstone (idempotent — skip if already present)

Reverse query ("which workspaces has user X been sticky-removed from?") isn't needed for the release. If it becomes load-bearing, promote to a dedicated table.

---

## Module shape — `dembrane/inheritance.py`

```python
"""Workspace inheritance resolvers. See docs/workspaces/inheritance-rules.md.

Inheritance is derived at query time, not stored. All access decisions and
member-list queries must route through this module.
"""

from __future__ import annotations


# ── Helpers ───────────────────────────────────────────────────────────

def workspace_inherits_team_admins(workspace: dict) -> bool:
    return (workspace.get("settings") or {}).get("inherit_team_admins", True)


def workspace_inherits_team_members(workspace: dict) -> bool:
    return (workspace.get("settings") or {}).get("inherit_team_members", False)


def is_sticky_removed(workspace: dict, user_id: str) -> bool:
    tombstones = (workspace.get("settings") or {}).get("sticky_removed") or []
    return any(t.get("user_id") == user_id for t in tombstones)


# ── Resolvers (read-side) ─────────────────────────────────────────────

async def user_can_access(workspace_id: str, user_id: str) -> str | None:
    """Return the effective role for this user on this workspace, or None.
    Implements steps 1–5 in the access-resolution order."""
    ...


async def get_effective_members(workspace_id: str) -> list[dict]:
    """Return [{user_id, role, source: 'direct'|'inherited', is_external, ...}].
    Derivation runs here; direct rows deduplicate derived."""
    ...


# ── State transitions (write-side) ────────────────────────────────────

async def on_workspace_created(
    workspace_id: str,
    creator_app_user_id: str,
    inherit_team_admins: bool,
    inherit_team_members: bool,
) -> None:
    """Set settings flags + insert creator as source='direct', role='owner'."""
    ...


async def on_team_member_removed(org_id: str, user_id: str) -> None:
    """User left or was removed from the team. Soft-delete all their
    source='direct' rows in this org. (Derived access stops automatically.)"""
    ...


async def on_external_became_internal(org_id: str, user_id: str) -> None:
    """User just got an org_membership. Reconcile is_external=False on
    any existing workspace_membership rows in this org."""
    ...


async def on_internal_became_external(org_id: str, user_id: str) -> None:
    """User lost org_membership. Set is_external=True on any surviving
    workspace_membership rows in this org so UI labels correctly."""
    ...


async def sticky_remove(
    workspace_id: str, user_id: str, by_user_id: str
) -> None:
    """Append a tombstone to workspace.settings.sticky_removed (idempotent)."""
    ...
```

No fan-out. No triggers. The resolvers replace every path that used to read `workspace_membership.source='inherited'` rows.

---

## Migration — from stored to derived

One-time, idempotent, dry-run-supported:

1. For every `workspace_membership` row with `source='inherited'` and `deleted_at IS NULL`: verify the derived model would grant the same access. Log divergences. Archive the row (soft-delete with a note) — it's no longer the source of truth.
2. For every `workspace_membership` row with `source='inherited'` and `deleted_at IS NOT NULL`: convert to a `sticky_removed` tombstone on the workspace's settings. Then archive the row.
3. After this script runs once, no code should ever insert `source='inherited'` again. Delete the `source='inherited'` branches from `POST /v2/workspaces` and any other handler (there shouldn't be many — the existing fan-out loop in `workspaces.py` is the main one).

Run in dry-run mode first. Expect `source='inherited'` rows only on workspaces that were created via the current fan-out path (very few today).

---

## Call sites

| Where | Pattern | Owns |
|---|---|---|
| `middleware.get_workspace_context` | `await user_can_access(workspace_id, session.user_id)` → 403 if None | Every scoped endpoint |
| `GET /v2/workspaces/:id/settings` (members list) | `get_effective_members(workspace_id)` | Members tab |
| `GET /v2/orgs/:id/members` (matrix view) | For each user × workspace, compute `user_can_access` | Teams admin page |
| `GET /v2/workspaces` (selector) | `get_effective_members(ws).filter(user_id == me)` for each workspace | Workspace selector counts |
| `POST /v2/workspaces` | `on_workspace_created(...)` — no fan-out loop | Creation |
| `DELETE /v2/workspaces/:id/members/:uid` | If the removed user was inherited only: `sticky_remove(...)`. If direct: soft-delete the row. | Explicit kicks |
| `DELETE /v2/orgs/:id/members/:uid` | Soft-delete `org_membership` + `on_team_member_removed(...)` | Org membership management |
| External ↔ internal transitions | `on_external_became_internal` / `on_internal_became_external` | Invite accept with `include_org_membership=true`, and org removal |

---

## Invariants (tests)

1. **Single source of truth.** `user_can_access` is the only function that returns a role. No endpoint inspects `workspace_membership.source` directly to decide access.
2. **Direct wins.** If a user has both a direct row and a derived path, `user_can_access` returns the direct role and `get_effective_members` lists them once with `source='direct'`.
3. **Sticky forever (this release).** Once a user is tombstoned on a workspace, no state change (promotion, workspace re-opening, team re-join) re-grants them inherited access. They can only return via an explicit direct invite, which appends a direct row and is independent of the tombstone.
4. **Private means private.** When `inherit_team_admins=false`, `user_can_access` returns a role only via steps 1 or 2 (direct or project-share). Step 3/4 short-circuits.
5. **No orphan inherited rows.** After migration, `SELECT count(*) FROM workspace_membership WHERE source='inherited' AND deleted_at IS NULL` = 0 forever.
6. **External flag consistency.** A user with an active `org_membership` in this org never has `is_external=true` on any `workspace_membership` row in the same org. Reconciled by the two helpers above.

---

## Open items (workshop)

- **Sticky-forever vs expiring.** Currently sticky never clears. Do we want a "restore inherited access" path for the case where a past kick is no longer appropriate? Probably yes, but post-release.
- **Tier-per-team vs tier-per-workspace.** Separate decision (tracked in release-checklist.md §"Questions for the team"). Doesn't interact with this derivation model — it just moves where the tier flag lives.
- **Trigger #7 question from the old spec ("on open → private, do we kick existing inherited members?").** Resolved: there are no inherited members to kick in the derived model. Flipping `inherit_team_admins=false` makes them stop being members on the next read. Elegant.
