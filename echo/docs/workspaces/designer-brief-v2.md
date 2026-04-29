# Designer brief v2 — follow-ups after v2 review

**For:** the designer
**From:** Sameer
**Date:** 2026-04-20
**Ref:** builds on `designer-brief.md` + `designer-return.html` (your v2)

---

## TL;DR

Your v2 directions are accepted. This addendum lists the clarifications I need **before** we start mid-fi on the new screens, plus a newly scoped pattern (**creation wizards with dry-run preview**) that touches several of the asks you've already solved.

Questions are grouped by ask. Answer inline in this file or Slack — whatever's faster.

---

## New pattern — Creation wizards with dry-run preview

Bigger direction change than any single ask. Affects workspace creation and project creation (both currently one-shot forms). We'll extend later to project context setup (not this release).

**Scope locked (2026-04-20):** full multi-step flow — dedicated route, progress indicator, step-back, reviewable summary before create, cancel at each step. Not a modal, not an inline upgrade to the existing form.

**The pattern:**
- Step 1 — what to call it
- Step 2 — **access decision with a sensible default and a live "here's what will happen if you proceed" preview**
- Step 3 — review summary (name + access choice + dry-run count again)
- Step 4 — [Create]
- Persistent progress indicator, back button on every step, cancel-with-confirm.

**Workspace creation wizard** (step 2):
> **Access**
> ◉ Open to the organisation
> ○ Private workspace
>
> *(shown when "Open to the organisation" is selected:)*
> Who on the organisation inherits access?
> ☑ Organisation admins *(always inherit — can't uncheck)*
> ☐ Organisation members *(optional)*

Private workspace copy: *"Only you will have access. Organisation admins won't be auto-added, even when joining the organisation later."*

Dry-run line live-updates with the choice: *"3 organisation admins + 7 organisation members will inherit access."* or *"3 organisation admins will inherit access."* or *"Only you. Organisation admins won't inherit."*

**Show step 2 even for solo organisations** (organisation of 1). Dry-run honestly reads "0 organisation admins will inherit" — don't hide the affordance.

**Gating:** the *Private workspace* option is innovator+ tier. On lower tiers, the Private radio is disabled with the standard Ask 4 upgrade hint.

**Project creation wizard** (step 2):
> ◉ Workspace — *12 people in [workspace name] will get access, including 3 inherited organisation admins.*
> ○ Private — *Just you, for now. Share with specific people later.*

**What I need from you for this pattern:**

1. **Wizard layout**: full page, modal, or drawer? I'm leaning drawer for workspace creation (lives inside settings context), full page for project creation (fresh mental space). Your call.
2. **Dry-run visual**: is the count a simple sentence, a row of avatars + count, or an expandable "see who" reveal?
3. **Private state iconography**: is there a lock icon treatment that travels from wizard → workspace card → matrix → settings?
4. **Error/empty states**: what does "0 organisation admins will be added" look like (solo organisation creating first workspace)?

---

## Ask 1 — Organisation admin page

1. **URL naming**: you mocked `/org/:orgId/members`. Our internal code says `org`, our user copy says "organisation". Keep URL as `/org/...` (shorter, matches code) or `/organisation/...` (matches copy)? Low stakes — pick one.
2. **"Invite to organisation" CTA**: I'm assuming this always sets `include_org_membership=true` so the invitee joins the organisation and auto-inherits every **open** workspace. Confirm? (Workspace-scoped invites still live inside each workspace's settings.)
3. **Matrix cell clicks**: what should clicking an empty `—` cell (user not in that workspace) do — open inline invite, or add at default role with a confirm toast? Same Q for the `— removed` cell (sticky-remove rule says don't auto re-add — so does the click prompt "re-add as direct member"?).
4. **Private workspaces in the matrix**: when a workspace is marked private, the column should signal that somehow — lock icon? Greyed cells until explicitly invited? Your call.
5. **Project management on the organisation page — NEW ASK.** Delete-workspace is blocked if the workspace has any non-deleted project (decision locked 2026-04-20). So from the organisation admin page, an owner/admin needs to be able to see every project across every workspace in the organisation and soft-delete any of them — otherwise winding down a partner engagement means walking into 20 workspaces one by one. Pick the right surface:
    - **(i)** Third view on the organisation page: **List · Matrix · Projects**. Projects view = flat list of every project, filterable by workspace, row action = delete. Feels consistent with the existing view switcher.
    - **(ii)** Click a workspace column header in the Matrix → opens a drawer showing that workspace's projects with delete actions. Contextual, but hides the feature behind a click.
    - **(iii)** Separate route `/org/:id/projects` with its own page. Cleanest separation but adds a top-level nav item.
    
    My lean: **(i)** — reuses the view switcher pattern you already drew and keeps organisation management on one URL. Confirm?

---

## Ask 2 — Tier management

5. **"Request upgrade" CTA target**: when a organisation admin clicks this, what happens?
   - (a) `mailto:` prefilled to a billing inbox
   - (b) Python endpoint that emails billing via SendGrid + shows a toast
   - (c) External form (Notion / CRM / Typeform)
   - (d) No-op for this release
   
   Cheapest that still captures intent: (b). Need a target inbox address — likely `billing@dembrane.com`. Confirm?
6. **Staff tier dropdown** (Ask 2s): the "Reason (internal)" field — required or optional? I'd say required for audit hygiene, but it's your copy call.

---

## Ask 3 — Private project sharing

7. **Strip when project is public**: designer note says it reads "Visible to everyone in [workspace] · Make private". Always visible, or hide on public projects to reduce clutter? My preference: always visible — the strip is the tell for privacy state, and hiding it would make public the "invisible default" which is what we're trying to correct.
8. **Share modal — role default**: new person added gets `can read` or `can edit`? I'd say `can read` for safety but check.

---

## Ask 4 — Upgrade prompts

9. **"Ask an admin" (member-role CTA) — RESOLVED: no CTA.** Member-role users see the 4B/4C gate with copy like *"This feature requires [tier]. Ask one of your organisation admins to upgrade."* No button, no mailto, no admin-name list. Please redraw Ask 4 modal/overlay without the member-path primary CTA — member sees only "Not now" / close affordance, the gate message does the work. Admin-role view unchanged (still has "Request upgrade" primary).

---

## Ask 5 — Selector + settings polish

10. **Tier aggregation on organisation hero card**: your mock says "pioneer tier (aggregated)". When workspaces in a organisation are on mixed tiers, show:
    - (a) the **highest** tier in the organisation
    - (b) the **lowest**
    - (c) "Mixed"
    - (d) the default workspace's tier
    
    My gut: (c) "Mixed" with a tooltip listing each workspace's tier.

11. **Private workspace toggle in workspace settings**: new concept that didn't exist in Ask 5. Lives under General, or does "Access" deserve its own tab?

---

## How to answer

Inline comments on this doc are fine. If a question has a quick visual answer, a sketch image dropped into Slack works. Batch or one-by-one — your call.

When the wizard pattern is sketched (#1–4), that becomes the "Ask 6" we haven't numbered yet.
