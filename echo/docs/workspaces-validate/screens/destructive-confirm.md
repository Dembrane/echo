# Screen 4 — Confirm destructive action

**Intent:** make the user pause exactly as long as the consequence deserves, and spell out the consequence so they can't miss it. No "Successfully deleted" — the phrasing throughout is factual.

**Used by:** delete workspace, remove member, demote (including self), transfer workspace, tier downgrade, delete organisation, delete project (admin-only).

**Reference:** matrix §4 (delete workspace requires confirmation), §3 (downgrade dialog lists frozen/reverted features), brief pattern 5.

---

## Gravity → affordance

| Action | Confirm type | Extra friction |
|---|---|---|
| Remove member | Modal + "Remove" button | Confirm once |
| Change role (downgrade — admin → member) | Modal + "Change role" button | Confirm once |
| Cancel invite | Modal + "Cancel invite" button | Confirm once |
| Tier downgrade | Modal + "Downgrade to {tier}" button | Lists every frozen + reverted feature. Staff-only action. |
| Delete project | Modal + "Delete project" button | If project has conversations, show count. Irreversible. |
| Delete workspace | Modal + **type-to-confirm** | Requires typing workspace name. Blocked if non-deleted projects exist. |
| Delete organisation | Modal + type-to-confirm | Same friction as delete workspace. |
| Transfer workspace | Modal + "Transfer" | Staff-only. Lists billing + access impact. |

## Shape — standard modal

```
┌─ Remove Anna Bakker from {workspace} ───────────┐
│                                                 │
│  Anna will lose access to this workspace.       │
│  Projects she created stay; conversations       │
│  remain as they are.                            │
│                                                 │
│  [Cancel]                       [Remove Anna]   │
└─────────────────────────────────────────────────┘
```

- Title is the action + subject, plain.
- Body: one sentence on what the user loses, one sentence on what remains. No "Are you sure?"
- Primary button on the right, destructive — Royal Blue or Cotton Candy-tinted where it matters. Never red-for-red's-sake.
- Cancel on the left, no border, plain text.

## Shape — type-to-confirm

```
┌─ Delete {workspace} ────────────────────────────┐
│                                                 │
│  This permanently removes the workspace from    │
│  your organisation. Direct members will lose access.    │
│                                                 │
│  Any projects must be deleted first.            │
│  You have 3 projects here.                      │
│                                                 │
│  Type {workspace} to confirm:                   │
│  [_______________________________]              │
│                                                 │
│  [Cancel]                    [Delete workspace] │
└─────────────────────────────────────────────────┘
```

- Button is disabled until input matches workspace name exactly (case-sensitive).
- If a precondition blocks the action (projects present), the button is disabled + input is disabled. Primary CTA becomes `[See projects]` linking to the organisation-page project view (checklist decision 2026-04-20 + matrix §4 delete-workspace requires empty).

## Tier downgrade — special case (matrix §3)

Body lists every feature affected, split by freeze vs revert:

```
Downgrading to pioneer will:
  · Freeze:  private projects (existing stay, no new)
             private workspaces (existing stay, no new)
             data export (existing files keep, no new exports)
             private project sharing (existing shares stay, no new)
             webhooks (existing fire, no new configs)
  · Revert:  whitelabel — your custom logo will be removed
             and the dembrane wordmark will be restored.

[Cancel]                         [Downgrade to pioneer]
```

- Ordering: freeze block first (less alarming), revert block last (more alarming — matches the "don't hide the bad news" principle).
- "dembrane wordmark" not "dembrane logo" — more specific, correct per brand.
- Admin clicking "Downgrade" must not be allowed through a keyboard shortcut mishit — require pointer click OR explicit Enter after focus (staff-only action anyway).

## Copy rules

- Name the subject concretely. "Remove Anna Bakker" not "Remove member".
- Factual consequences, not emotional framing. "Anna will lose access." not "You'll be making this change permanently."
- Never "This action cannot be undone." — instead, say what specifically happens ("Projects stay", "Conversations remain"). Let the user reason about reversibility.
- Success toast after confirm: "Anna removed." / "Workspace deleted." — factual. Never "Successfully".

## Last-admin protection

Any attempt to demote or remove the last admin (at workspace or organisation level) is not a confirmation — it's a refusal. Show inline error, not this modal:

> You are the only admin of {workspace}. Add another admin before changing your role.

## Non-goals

- No "Are you sure?" — replace with concrete consequence text.
- No confetti / celebration on destructive completion.
- No undo. Soft-delete exists at the data layer (`deleted_at`); a Trash/Restore UI is post-release (checklist decision 2026-04-20).
