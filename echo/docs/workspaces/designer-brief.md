# Designer brief — Workspaces & Teams release

**For:** the designer joining us
**From:** Sameer
**Date:** 2026-04-20
**Ship target:** end of this week

---

## TL;DR

We're adding two new layers above projects: **Organizations** (internally called "teams") and **Workspaces**. The core app you see today — projects, conversations, chats, reports — doesn't change. What changes is the container around it: who can access what, who pays, and how teams collaborate.

Most of the plumbing is done. What I need from you is design for the flows that are either missing or currently too barebones to ship.

---

## Before you start — log into the app

Please spend 30 minutes clicking around before reading further. You'll understand what I'm saying much faster.

1. Go to the app, register a fresh account
2. You'll land on **Onboarding** — complete it
3. You'll be taken to a **workspace dashboard** (`/w/.../projects`)
4. Click the gear icon → **workspace settings**
5. Click the logo → **workspace selector** (`/select-workspace`)
6. In settings, invite a teammate → observe the **invite modal**
7. Create a second account, accept the invite → observe **accept invite** flow

Everything above already works. It's what's *there* that needs polish, plus several screens that don't exist yet.

---

## The mental model (new)

### Real-world picture

```
An organization (a.k.a. "team")
├── is the billing entity — one bill, one tier, one set of seat limits
├── contains one or more workspaces
└── has members with org-level roles (owner, admin, member)

A workspace
├── is a collaboration container — holds projects
├── has its own tier (pilot / pioneer / innovator / changemaker / guardian)
├── inherits org admins/owners as members automatically
└── can have direct members (invited) and external members (from other orgs)

A project (already exists)
├── lives in a workspace
├── is either workspace-visible or private
└── holds conversations, chats, reports
```

### Example

> **"Human Collective"** is a consultancy (an **organization / team**).
> They have three workspaces inside:
> - *Default* — their own internal projects
> - *City of Amsterdam* — projects they run for the Amsterdam municipality
> - *Province of Utrecht* — projects they run for Utrecht
>
> Their three consultants are **team members** — they automatically see all three workspaces as admins.
> An Amsterdam civil servant has been invited as a **direct member** only to the Amsterdam workspace. She's marked **external** because she's not on the Human Collective team.

### Access inheritance — the rule

When you're added as a **team (org) member** with admin or owner role, you're automatically added to **all current and future workspaces** in that team as an inherited member. This is the magic that makes partner consultancies work — adding one person grants access to every client engagement.

A workspace admin can *remove* an inherited member from their specific workspace. That removal sticks (no re-add).

---

## What's already built (don't redesign)

These flows exist and work. Style them if needed, but the structure is settled:

| Screen | Route | State |
|---|---|---|
| Onboarding | `/onboarding` | Works. Asks for org name + optional team invites on signup. Slightly brand-thin. |
| Workspace selector | `/select-workspace` | Works. Card grid. Shows workspaces + team rollups. **Visually flat, needs hierarchy.** |
| Workspace dashboard | `/w/:id/projects` | Project list. Already shipped. |
| Workspace settings | `/w/:id/settings` | Single page with general info, members, pending invites. **Crammed — needs tabs or better structure.** |
| Invite modal | Inside settings | Works. Email + role. |
| Accept invite | `/invite/accept/...` | Works. HMAC-protected link. |
| Pending invites | `/my-invites` | Works. Accept / decline. |
| User settings | `/settings` | Exists, minimal. |

Please work *from* these screens, not from a blank page. We don't want a rebuild — we want the next layer of polish plus a few new screens that match.

---

## What I need you to design

Five asks, in priority order. For each I've noted current state, the job-to-be-done, and key constraints.

### 1. Team (Org) admin page — **the big new surface area**

**Current state:** doesn't exist.
**Route it will live at:** `/org/:orgId/...` (name TBD — could be `/team/:teamId`)
**Who sees it:** team owners and admins

**Job-to-be-done:**
As an admin of a consultancy, I need one place to see everyone who has access to *any* of our workspaces, and manage their access. I want to answer:
- Who's on my team? What's their role?
- Which workspaces can each person access?
- Who's external (invited into one of our workspaces from outside)?
- How do I add someone to the whole team at once?

**Key content:**
- Member list. Each row: name, email (on hover only), team role, workspace access (compact indicator — e.g. "3 of 3 workspaces" or a small icon grid)
- A clear split or filter between **team members** and **externals**
- Row action: change role, remove, view workspaces they access
- "Invite to team" primary action
- Empty state when team has just one person: nudge toward inviting

**Think about:**
- What's the right default view when someone has 50+ members?
- How does the workspace-access column scale? (list? count? matrix?)
- Navigation: how does an admin get here from the workspace selector?

**Not in scope:** billing tab, usage tab — those are future.

---

### 2. Tier management UI

**Current state:** tier is stored on each workspace (`pilot / pioneer / innovator / changemaker / guardian`) but there's no UI to change it. Right now I change it in the database manually.

**Job-to-be-done:**
A team admin needs to see what tier each workspace is on, and needs to request an upgrade (or for internal dembrane admins, set it directly).

**Two views needed:**

**a. The "which tier am I on" display**
- Should appear somewhere in workspace settings
- Shows current tier + what's included
- Shows a compare table or link to compare tiers
- Primary CTA to upgrade (for now this just opens an email / contact form — no self-serve billing yet)

**b. Tier set modal (dembrane-internal)**
- Only visible to dembrane staff accounts
- Simple dropdown to change tier
- Confirm dialog because this affects billing

**Feature matrix to include in the compare view:**

| Feature | Pioneer | Innovator | Changemaker | Guardian |
|---|---|---|---|---|
| Projects + conversations | ✓ | ✓ | ✓ | ✓ |
| Chats + reports | ✓ | ✓ | ✓ | ✓ |
| Data export | — | ✓ | ✓ | ✓ |
| Private project sharing | — | ✓ | ✓ | ✓ |
| Whitelabel branding | — | — | ✓ | ✓ |
| API access | — | — | ✓ | ✓ |

---

### 3. Private project sharing modal

**Current state:** the ability to mark a project as private exists in the data model, but there's no UI for it, and no way to share a private project with specific people.

**Job-to-be-done:**
Sometimes an admin runs a project that shouldn't be visible to the whole workspace (e.g. sensitive stakeholder interviews). They need to mark it private and then hand-pick who can see it.

**Screens:**
- **Visibility toggle** somewhere on the project settings / header: "Visible to everyone in this workspace" ↔ "Private — only shared people"
- **Share modal** (opens when project is private):
  - List of current people with access (name, role: viewer / editor)
  - Add person by email (must already be a workspace member — no cross-workspace sharing)
  - Remove / change role

**Gating:**
This whole feature is **Innovator tier and above**. For lower tiers, the visibility toggle should be disabled with a clear upgrade prompt — see ask 4.

---

### 4. Tier upgrade prompts (a component, used in many places)

**Current state:** when a tier doesn't unlock a feature, the backend blocks it but the frontend often either hides the feature completely or shows nothing useful.

**Job-to-be-done:**
Show users what they're missing without making them feel blocked. Invite them to upgrade.

**Component I need:**
- An inline "locked feature" treatment — could be a disabled button with a subtle lock + tooltip, or an overlay on a feature card
- A modal or drawer that opens when they click it, showing:
  - The feature name + a one-line benefit
  - The minimum tier required
  - A "request upgrade" action
- Consistent across: private sharing, data export, whitelabel, API — so we only need to design this once

---

### 5. Workspace selector + settings — polish pass

**Current state:** both exist and function. Selector is a card grid. Settings is a single scrolling page.

**What I want:**

**Selector polish:**
- Stronger visual hierarchy when the user is a team admin (team-level context at top, workspaces below)
- Clearer treatment for **external** workspaces (where the user is a guest)
- Empty state when user has just one workspace — right now it auto-redirects, but if they somehow land here, the page feels underused
- Search / filter when they have many workspaces (10+)

**Settings polish:**
- Split into tabs: **General** / **Members** / **Branding** / **Legal** / **Billing**
- "Branding" and "Legal" are mostly empty for now — design the shell, we'll fill content later
- Members tab should feel distinct from the team admin page — this is workspace-scoped only

---

## Brand & UI rules you must follow

From our style guide (`brand/STYLE_GUIDE.md`) — these are non-negotiable:

- **"dembrane" is always lowercase**, even at the start of a sentence
- **Never say "AI"** — say "language model" or describe the action directly
- **Never say "successfully"** — just state what happened ("Saved", not "Successfully saved")
- **Say "participants and hosts"** not "users"; **"partners and clients"** not "customers"
- **Never use bold for emphasis** — use our Royal Blue (`#4169e1`) or italics
- **Don't stack multiple alert banners** — show one at a time
- **Primary font + spacing** — follow what's already in the app; we use Mantine
- **Logos / loading spinners** — there's a whitelabel system; use the `alwaysDembrane` variant only where the dembrane brand itself is appropriate (login, billing, team admin). Use the workspace's branded logo everywhere inside a workspace.

Tone: warm but not gushing. Direct but not cold. Think IKEA meets Patagonia. We're a trusted colleague, not a corporate announcement.

---

## How we'll work together

- **File format:** Figma is fine. Share the link, I'll comment inline.
- **Review cadence:** I'll give same-day feedback on anything you share before 4pm. Past that, next morning.
- **Scope discipline:** if something feels like it needs more than what's here, flag it rather than building it — we're shipping this week.
- **Questions:** I'd rather get a Slack message with a half-formed question than a polished mock that solves the wrong problem. Ask early.

---

## Week plan (so you know where your inputs are needed)

| Day | You | Me |
|---|---|---|
| Mon | Explore the app, read this brief, ask questions | Build migration script + org API |
| Tue | Deliver wires for **team admin page** (#1) | Build org endpoints, review your wires |
| Wed | Deliver **tier management** + **project sharing** (#2, #3) | Implement team admin page frontend |
| Thu | Deliver **upgrade prompts** + **selector/settings polish** (#4, #5) | Build tier UI + sharing modal |
| Fri | Final review, polish pass on anything I implemented | Bug bash, migration dry-run |

---

## Questions I expect you'll have

**"Why 'teams' and not 'organizations'?"**
Internally we call it `org` in the code and schema. Externally, "team" is warmer and clearer — most of our users don't run formal organizations. Use "team" in all user-facing copy.

**"What happens when someone has access to 20 workspaces?"**
They see a searchable list view on the selector. We've got a visual treatment partly built but it's barebones — include this in ask #5.

**"What about mobile?"**
Desktop first. The existing app is desktop-first. If you have strong opinions about mobile patterns for any of these screens, flag them but don't invest time.

**"Do I need to design the migration modal for existing users?"**
Not this week. The migration runs silently; if we need a welcome modal after, we'll design it next sprint.

---

## Reference material

All in this repo if you have access, or I can send over:
- `/workspaces/echo/docs/workspaces/workspaces-prd-v3-final.md` — full PRD (long, skim the "Data Model" and "Edge Cases" sections)
- `/workspaces/echo/brand/STYLE_GUIDE.md` — voice, tone, color, vocabulary
- The app itself at [production URL] or [staging URL]

That's it. Welcome aboard — excited to work with you on this.
