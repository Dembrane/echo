# QA Audit Report — Workspaces
Date: 2026-04-23 · Auditor: Claude (automated, 8 bucket agents)
Branch: workspaces · Frontend: http://localhost:5173

---

## 1. SHOWSTOPPERS

### Auth / Session
- `[fresh-user /auth/login]` After registering a new account and clicking Login with Chrome autofill, the session resolved to `emma@seed.dembrane.dev` (a different user) — real workspace data (Partner Consulting, Client Alpha/Beta, 4 conversations) was visible to the fresh registrant. Possible autofill + permissive login bug; warrants backend investigation.
- `[fresh-user /auth/register→/en-US/login]` After completing registration, the app redirects to `/en-US/login?next=%2Fprojects` with the email field cleared and no "check your inbox" message. The user is left on the login page with no recovery path.

### Blank app on login (Cara & Dan)
- `[cara@seed /en-US/projects]` `/api/v2/me` returns `orgs: []` for Cara despite her being in "Acme Research" org per admin. She sees a completely blank app — no workspaces, no projects. Seed data or org-membership sync bug.
- `[dan@seed /en-US/projects]` Same blank-app issue. Even if orgs were populated, billing API is 404 so his Billing role grants nothing visible.

### Invite API broken for all users
- `[all users /api/v2/orgs/{id}/invites]` GET and POST both return **404** for every role (Owner, Admin, Member). The invite button in workspace settings opens the dialog but any send will fail silently or return 404. Workspace-level invite endpoint (`/api/v2/workspaces/{id}/invites`) also 404.

### Billing API broken for all users
- `[all users /api/v2/orgs/{id}/billing]` Returns **404** for every user regardless of role. Billing tab in workspace/team settings fails to load for everyone, including Owners on paid tiers.

### React crash: Remove member & Leave workspace
- `[emma /en-US/w/<client-beta>/settings]` Clicking the trash icon next to any workspace member crashes the entire React app with `Uncaught Error: Trans component was rendered without I18nProvider`. The page goes blank; no API call is made; the member is not removed. Root cause: `<Trans>` (LinguiJS) component inside a Mantine Portal loses the I18nProvider context. One fix resolves both.
- `[emma /en-US/w/<client-beta>/settings]` "Leave workspace" button triggers the identical I18nProvider crash. Workspace departure is completely broken for all multi-member workspaces.

### Navigation bugs
- `[all users /en-US/w → Manage team]` The "Manage team" button on the workspaces list page navigates to `/en-US/t` (missing the team UUID), rendering a blank page. The team management page is unreachable via this UI entry point.
- `[all users /en-US/w/<id>/settings]` Clicking the role dropdown (e.g., "Admin" textbox) for a workspace member navigates to the Danger tab instead of opening the role selector. Role changes via workspace settings are broken.

### Inbox / Notifications
- `[all users /en-US/w (Inbox)]` Clicking the "Announcements" tab inside the Inbox dialog dismisses the dialog rather than switching tabs. The modal loses focus and closes; announcement content is completely unreachable via click.

### Limits / Billing UX
- `[finn /en-US/w/<trial-run>/settings?tab=billing]` Pilot billing tab reads "Request an upgrade above" but renders no upgrade button above that text. The CTA is a dead reference.
- `[finn /en-US/t/<solo-studio>?tab=people]` Team People tab shows "Showing 0 of 0" members despite Finn being the sole owner. Header correctly says "1 person" — display bug in the tab body.

---

## 2. CONFUSION

### Onboarding & first visit
- `[fresh-user /auth/register]` Wizard says "Three quick steps and you're in" but step 3 is an out-of-band inbox verification. Copy oversells speed.
- `[fresh-user /en-US/w]` The product never explains the team / workspace / project hierarchy. Three nouns appear on the landing page (team header → workspace cards → project counts) with no introductory sentence.
- `[fresh-user /en-US/t/...]` "Innovator" and "Pioneer" tags on workspace cards are never explained. Read as plan tiers, roles, or achievement badges — no tooltip.
- `[fresh-user /auth/register step 2]` "Create account" button goes immediately disabled after click with no spinner or "Creating…" text. Looks like the click failed.
- `[fresh-user]` URL scheme inconsistency: registration at `/auth/register`; post-action redirect to `/en-US/login`. Locale prefix appears without explanation.
- `[fresh-user /en-US/t/...]` Team name helper says "Shown on the workspace selector and in email subject lines." The "workspace selector" has not been introduced to a first-time visitor.

### Role / permission visibility
- `[all users /en-US/w]` User role (Owner / Admin / Member / Billing) is only visible per-workspace card. No global role indicator in the nav or account menu. Users can't easily answer "what am I in this team?"
- `[dan@seed /en-US/]` "Billing" role is never rendered anywhere in the UI that Dan himself would see. The role's capabilities are also moot because the billing API is 404.
- `[hank@seed /en-US/w]` Hank owns "Alpha Inc" (0 workspaces, 0 projects) but his real workspace is "Client Beta" (Partner Consulting). The workspaces page shows his Alpha Inc org banner with zeros while his actual work lives in another org — the cross-org access is not explained.

### Invite & guest
- `[ben /en-US/w/<id>/settings (invite dialog)]` External person type description ("workspace-only access, doesn't count as a seat") doesn't list what an External user *cannot* see (billing, other workspaces, team member emails). Inviters don't know where the data boundary is.
- `[ben /en-US/w/<id>/settings (invite dialog)]` The Workspace Role selector (Member / Billing / Admin) remains visible after selecting "External" person type. It's unclear whether an External-type invitee can hold the Billing workspace role and thereby see billing data.
- `[finn /en-US/w/<id>/settings (invite dialog)]` Invite form opens freely with no mention of seat limits even though Finn is at/near tier limits. Seat counter (0/2) shown on the projects header is absent from the invite flow.

### Limits
- `[finn /en-US/w]` "AT LIMIT" badge on workspace card does not label *what* is at limit (audio hours, seats, or projects). User must navigate to billing to find out.
- `[finn /en-US/t/<id>?tab=usage]` "1 AT LIMIT" label appears on the Projects row in the Usage tab — but the limit is on audio hours, not projects. The label placement implies a project count limit that doesn't exist.

### Destructive flows
- `[anna /en-US/w/<id>/settings?tab=danger]` Workspace delete uses the term "soft-delete" in its warning copy. Non-technical users expect permanent deletion; the retention-window nuance is buried and not actionable.
- `[anna /en-US/w/<id> delete project]` Neither delete-project confirmation modal shows the count of conversations to be destroyed. The scope of deletion is invisible to the user.
- `[F3/F4]` The React crash (blank white page) is visually indistinguishable from a network timeout. Users will attempt to reload and retry, repeatedly, not knowing the action failed.

### Notifications
- `[ben /en-US/w (Inbox)]` Badge "1" on the Inbox bell while "For you" tab says "You're all caught up." The badge appears to count Announcements only, with no visual distinction between "For you" badge and "Announcements" badge.

---

## 3. POLISH

### Copy
- `[/en-US/w/.../settings]` "No logo set — dembrane default will be used." — brand name should be "Dembrane" (capitalised). Same error in 2 other locations in project-defaults settings.
- `[/en-US/w]` "1 people" on team overview card — ungrammatical; should be "1 person" or "1 member".
- `[/en-US/w/.../settings?tab=danger]` "Clear the 1 project(s) first." — `(s)` pluralisation is awkward; should use conditional ("Clear the project first" / "Clear all projects first").
- `[/en-US/w/.../settings?tab=billing]` "…email upgrades@dembrane.com for now." — "for now" is filler; cut.
- `[/auth/register footer]` "Dembrane B.V. 2026, all rights reserved." — comma after "B.V." creates odd rhythm; "© 2026 Dembrane B.V. All rights reserved." is cleaner.
- `[/auth/register]` Privacy policy link opens in same tab — clicking it abandons the signup flow. Should open in a new tab.
- `[/en-US/w/.../settings]` Em dashes in radio labels ("Open to the team — team admins get access automatically", "Private — only people you explicitly invite") and hint text clash with the casual brand voice. Tier taglines use em dashes intentionally (punchy); inline radio usage does not.

### Brand name
- Three occurrences of "dembrane" (lowercase) in product copy. All should be "Dembrane": (1) logo-set hint in workspace settings, (2) "Upload a custom logo to replace the dembrane logo" in project defaults, (3) "Using default dembrane logo."

### Accessibility
- `[/en-US/w/.../settings (invite dialog)]` Close button (×) on invite dialog has no aria-label — screen reader unfriendly.
- `[/en-US/w/.../projects]` Project row action button (`opacity-0 group-hover:opacity-100`) has no aria-label and is invisible until hover.

### Dutch (nl-NL) translation
- `[/nl-NL/login]` "Create an account" button not translated (should be "Account aanmaken").
- `[/nl-NL/w]` Workspace summary stats fully English: "1 workspace · 1 person · 1 projects · 10.3 h this month". "1 projects" is also a grammar bug in English.
- `[/nl-NL/w]` "AT LIMIT" badge not translated.
- `[/nl-NL/w]` "Manage team", "Manage", "Add workspace", "Owner" all English.
- `[/nl-NL/w/.../settings]` ~80% English bleed: Billing tab, Danger tab, Privacy & defaults heading, all access/membership copy, all CTA buttons ("Upload logo", "Add workspace", "Invite member").
- Formality: Dutch copy correctly uses "je/jij" throughout — register is on-brand.
- Page title bug: "Login | dembrane" shown as document title while URL was `/en-US/projects`.

---

## 4. MODEL DISCOVERY

**Verdict: PARTIALLY FOUND**

The product clearly supports a consulting-firm-delivers-for-clients pattern, but it is not a labeled, first-class UI concept.

### How it was found
- Emma's team is literally named "Partner Consulting". Her two workspaces are named "Client Alpha" and "Client Beta".
- In workspace settings, the team name appears inline below the workspace name and tier tag: `Client Alpha / Pioneer / for your first real engagements. / Partner Consulting`. This is the only explicit visual signal of the relationship.
- Hank (who owns a separate, empty org "Alpha Inc") has workspace-Admin access to "Client Beta" (Partner Consulting). This hints at a cross-org workspace-membership capability — unexplained anywhere in the UI.

### What the UI communicates
- The model is implied entirely through naming conventions. There is no label, tooltip, or onboarding copy explaining "your team can manage workspaces on behalf of clients."
- A new user would see "Partner Consulting" → "Client Alpha" / "Client Beta" and either infer the relationship (savvy) or think those are internal project codenames (common mistake).

### Isolation: does it hold?
- YES. Anna ("Acme Research") and Emma ("Partner Consulting") have zero visibility into each other's workspaces — entirely separate orgs with no cross-org discovery surface. Isolation appears solid.

### What could not be confirmed
- Whether a client company gets its own login to their named workspace. Hank's cross-org access hints this is possible, but the mechanism and any access-limiting copy were not found.
- The `external_count: 0` field in Emma's org API response is inconsistent with Hank having workspace access — suggests external-member counting may be broken, not just unexplained.

### Pages that should have referenced it and didn't
- `/en-US/t/<id>` (Team settings overview) — no "client workspaces" or "managed on behalf of" framing.
- `/en-US/w/<id>/settings` (Workspace settings, Members tab) — no "external org" label on Hank's entry, no explanation of cross-org access.
- Invite dialog — no option labeled "Client access" or "External organisation"; the "External" person type is seat-based framing, not org-relationship framing.
- Billing tab — no mention of per-client billing or workspace-level billing separation.

### Hints seen but unconfirmed
- "for your first real engagements." (Pioneer tier tagline) — implies client-facing delivery work.
- "Whitelabel Project" workspace in Anna's "Acme Research" — may indicate white-label delivery model; no further context.
- `DISCOVERABLE IN THIS TEAM` section — intra-team workspace discovery exists; no cross-team equivalent found.

---

## 5. DESIGN CONSISTENCY

Observations about pattern divergence — not individual bugs, but surfaces that expose two or more different implementations of the same concept.

### Confirmations for destructive actions (3 different patterns)
- Delete workspace → inline Danger tab, text-input name-match, no modal
- Delete project → double sequential modal ("Cannot be undone" → "Are you absolutely sure?")
- Remove member / Leave workspace → intended single modal (currently crashes)
Three destructive flows, three UX patterns. A user who deleted a project learns nothing about how workspace deletion will feel.

### Settings tab implementation (inconsistent across surfaces)
- Workspace settings: query-param tabs (`?tab=billing`, `?tab=danger`) — URL-addressable, back/forward works
- Team page: Mantine tab component (Overview / Usage / People) — in-page state, not URL segments
- Project settings: buried inside a "Settings" tab within the project overview — not a `/settings` route at all
These behave differently on reload, share, and keyboard navigation. The role-change dropdown accidentally triggering Danger tab navigation is a symptom of mixing tab implementations on the same page.

### Loading / submission feedback (inconsistent)
- Create account button: instantly disabled, no spinner, no "Creating…" label — looks like a failed click
- Delete workspace: shows a success toast after completion; no spinner during deletion
No single loading-state convention across forms.

### Logo upload (two different input types for the same concept)
- Team logo: raw `https://` URL text field
- Workspace logo: file upload picker
Same concept, different affordance depending on which settings level you're on.

### Tier / plan display (no consistent visual slot)
- Workspace cards: tier badge alongside role — "Owner / Innovator", "Owner / Pioneer", "Pilot" (Pilot uses no slash separator)
- "AT LIMIT" badge appears on workspace card, projects page header, and team Usage tab — three different visual treatments
- Billing tab: Innovator/Pioneer shows a full tier comparison table; Pilot shows a placeholder — same tab, completely different content structure per tier

### Member / role management (two surfaces, different interactions)
- Workspace members (settings Overview tab): inline trash icon + role dropdown in the same row
- Team People tab: separate surface, different controls
No shared member-row component.

### Empty-state consistency
- Finn's workspace (no projects): blank app, no empty-state illustration, no CTA
- Cara and Dan (broken org membership): also blank app — visually indistinguishable from Finn's intentional empty state

---

## 6. COPY CONSISTENCY

Axes where the product uses multiple words or formats for the same concept, creating terminology drift that is especially visible during a demo.

### "Member" is overloaded across 3 meanings
- **Person type** in invite dialog: "Member" (seat-counted) vs "External" (no seat)
- **Workspace role** in invite dialog and member list: "Member / Billing / Admin"
- **Tab label** on the team page: "People" (not "Members")

A user inviting someone holds three definitions of "member" simultaneously — person type, workspace role, and team-level concept — with no disambiguation. The team tab saying "People" while the workspace settings says "Members" adds a fourth word for the same thing.

### Action verbs for destructive actions are inconsistent
- "Delete workspace" / "Delete project" — but "Remove member" / "Leave workspace" / "Clear projects"
No single verb for "take something away." A user who just learned "Delete" will not expect "Remove" to be the remove-member action, and "Leave" to be the self-removal action.

### Number / unit formatting has no standard
- `2.6h this month` (workspace card)
- `10.3 / 10 hours` (AT LIMIT badge on projects header)
- `10.3 h this month` (nl-NL workspace card)
- `10.3 hours in April 2026` (team Usage tab)

Four formats for the same unit across screens a demo guest sees in under 60 seconds. Decide on one: `10.3 h` (short) or `10.3 hours` (spelled out), then apply it everywhere.

### Tier names appear with zero introduction
Pilot / Pioneer / Innovator / Changemaker / Guardian appear as workspace card tags and in billing copy with no tooltip, no glossary entry, and no onboarding mention. A demo guest who asks "what's a Pioneer?" has no in-product answer. Even a one-line tooltip ("Pioneer — for your first client engagements. 5 seats, 50 h/month.") would resolve this.

### "Workspace" vs "team" usage is inconsistent in helper text
- "Shown on the **workspace selector** and in email subject lines." (team name field helper) — uses "workspace selector", a surface not named elsewhere in the UI
- "Open to the **team** — team admins get access automatically" (workspace access radio) — "team" here means the parent org
- "Workspace-only access" (invite dialog External description) — "workspace" here means a single workspace, not the product concept

The same two words carry different referents on different surfaces with no consistent glossary backing them up.

---

*Report generated from 8 parallel audit agents. Raw bucket files in `echo/audit/buckets/*.md`.*
