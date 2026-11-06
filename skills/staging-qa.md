---
name: staging-qa
description: End-to-end QA of the core and secondary flows on staging or a PR preview, driven by a headless browser. Use before a release, after a large or risky change, or when asked to "QA staging" / "check nothing broke". Covers sign-up, the participant portal, uploads, chat, reports, projects, organisations, account pages and the secondary tools.
---

# Staging QA

Checks that the app works end to end. Run every section, mark each check Pass / Fail / Not tested and keep a screenshot per check. Testing a single feature in depth is out of scope; this is the "is everything still intact" pass.

A full run takes 2 to 3 hours alone, about 45 minutes with four parallel lanes. Start R3 (scheduled report) early: it waits at least 10 minutes.

## 1. Before you start

- Pick the environment. Staging is the default: dashboard `https://dashboard.staging.dembrane.com`, portal `https://portal.staging.dembrane.com`, api `https://api.staging.dembrane.com`. For a PR preview (`skills/product-release.md` step 5), point the harness at it with `QA_DASHBOARD`, `QA_PORTAL` and `QA_API` (dashboard-<n>, portal-<n> and api-<n>.preview.dembrane.com).
- Confirm what is deployed: `curl -s $QA_API/api/health` returns `release`; compare it with the commit you mean to test (`git rev-parse origin/main` for staging). If it differs, say so in the report.
- Ask the user for the latest QA report, if there is one, so you can tell new issues from known ones.
- If a specific change triggered the QA, list what it touched outside its own feature (`git diff --stat <previous-release> <release>`). Shared code (migrations, error catalog, locales, background jobs, middleware) deserves extra attention.

## 2. Harness

`skills/staging-qa/harness/` holds a small Playwright daemon that keeps signed-in browsers open between steps, so an agent can drive the app one script at a time. It uses the Playwright already installed in `dembrane/frontend/node_modules`.

Everything personal stays outside the repo in `QA_HOME` (default `~/.cache/dembrane-qa`): browser profiles, audio fixtures, `accounts.json` and screenshots.

```sh
cd skills/staging-qa/harness
./make-audio.sh                                   # once: needs ffmpeg + espeak-ng (or macOS say, or WSL)
QA_SHOTS=$HOME/.cache/dembrane-qa/runs/$(date +%F) nohup node daemon.mjs > daemon.log 2>&1 &
./run.sh <<'JS'
const p = await get('owner');                     // opens (or reuses) the "owner" browser profile
await p.goto(L.D + '/o', { waitUntil: 'load' }); await L.wait(p, 3000);
await L.shot(p, 'setup', 'owner-home');
return p.url();                                   // lands on /login if the profile is not signed in
JS
./stop.sh                                         # at the end
```

In a script: `S` (`S.ctx[name]`, `S.p[name]`), `get(name, opts)`, `L` (`L.D`, `L.P`, `L.A`, `L.ACC`, `L.shot`, `L.wait`, `L.audio(file)`, `L.fakeMic(wav)`, `L.api(page, method, path, body)`), `fs`.

- Never wait for `networkidle`; pages poll. Use `load` plus `L.wait`.
- Keep each `run.sh` call under 5 minutes (it gives up after 5). Poll long waits in several calls.
- A participant with a microphone: `await get('portal-1', { args: L.fakeMic(L.audio('mic90.wav')), viewport: { width: 390, height: 844 } })`. Use a new name per fresh participant. After Stop, wait about 5 s before closing the page so the last chunk uploads.
- Fixtures from `make-audio.sh`: `mic90.wav` (90 s of speech), `silent.wav`, `t1-t3.wav`, `bakery.mp3`, `student.m4a`, `maria.wav`, `fake.mp3` (not audio), `many/` (11 files).
- Several agents can share one daemon. Never navigate someone else's page; open your own in the shared context: `await get('owner'); S.p['chat-owner'] ??= await S.ctx.owner.newPage();`. Close what you open.

## 3. Accounts

Ask the user which accounts to use, or to create them. Store them in `$QA_HOME/accounts.json` as role to email (`L.ACC`); never commit addresses. Roles the suite needs:

| Role | Used for |
|---|---|
| owner | owner of a paid organisation with at least one project that has transcribed conversations |
| member | member of the owner's organisation |
| external | external in one of the owner's workspaces |
| free | owner of a free organisation |
| staff | a staff account |

Sign in with an email code, once per profile; profiles stay signed in for days:

1. In that role's browser, open `/login`, click "Email me a sign-in code instead", fill the email, click "Email me a code". Request a code once and keep the page open; requesting again invalidates the previous code.
2. Ask the user for the code. Request codes for every role you need at the start, in one go, so the user pastes them together.
3. Type the six digits into the first code box. The form submits on its own; do not also click "Log in", a second submit uses up the code.

If a code is rejected: check the page shows the same address the user received the code for, click "Send a new code" once and ask again. After a second rejection, skip that role's checks and list them under Not tested with the reason.

## 4. Rules

- Prefix everything you create with `QA <MMDD>` and delete only what you created.
- Do not change staff settings that apply to every account (for example free tier limits).
- Publishing a report replaces the project's published report; unpublish your test report afterwards and mention it in the report.
- Sending invites, webhooks or feedback reaches real inboxes: use the user's own addresses and say what was sent.
- No code edits, commits or stashes.
- On a failure: retry once, capture console errors and failing network calls (status and error code), and judge whether the change under test could cause it before calling it a regression.

## 5. Core flows

Sign-up and invites (new addresses from the user, each needs the user to open an email)
- [ ] A1 Register a new account, verify the email, onboarding, land in the new organisation
- [ ] A2 Invite a new address to a workspace: accept link, create account (email locked), onboarding, lands with access
- [ ] A3 Invite an existing account: accept from Invites, lands in the workspace; the inviter gets a "joined" notice
- [ ] A4 Revoked invite link says it is no longer valid

Portal (owner project; take the portal link from the project's share tab)
- [ ] P1 Start page at desktop and 390 px, language route (`/nl-NL/...`), consent, session name, tags
- [ ] P2 Audio recording with the fake mic: record, Stop, Resume, Finish, finish page. On the dashboard: conversation, duration, transcript, summary
- [ ] P3 Mic check with `silent.wav` warns that no audio arrives
- [ ] P4 Text mode: two submissions, finish; transcript and summary on the dashboard
- [ ] P5 Explore: reply grounded in what was said
- [ ] P6 Verify: topic, draft, Approve; outcome on the dashboard
- [ ] P7 Close the tab mid-recording: conversation still saved and transcribed
- [ ] P8 Finish page email subscribe (turn on "Ask for email" and report notifications if needed, revert after); the unsubscribe link in the email works
- [ ] P9 Monitor: a live session moves through recording, verifying and finished

Uploads and conversations (in a new project)
- [ ] U1 Upload mp3, m4a and wav: transcribed, summarised, durations shown
- [ ] U2 `fake.mp3` shows a transcription error; `many/` shows the file limit
- [ ] U3 List: search, every sort, tag filter, verified filter, reset; project home list
- [ ] U4 Detail: transcript, summary, player play and seek, edit title, tags, regenerate summary
- [ ] U5 Download transcript and audio, retranscribe, move to another project and back, delete

Chat (project with several transcribed conversations)
- [ ] C1 Select one and select all, ask: streamed answer with quotes, auto title
- [ ] C2 Stop before the first token and mid-stream; reload shows the right messages
- [ ] C3 Copy markdown, rename, search, delete chat, suggestions
- [ ] C4 Templates: create, edit, duplicate, pin, use, delete
- [ ] C5 Thumbs up and down (with a reason) persist after reload
- [ ] C6 Agentic chat: plan, steps, cited answer, citation opens the conversation; cancel
- [ ] C7 Free account: chat limits lead to the upgrade flow

Projects and portal editor
- [ ] PJ1 Create project wizard; project goal and revision history; settings autosave
- [ ] PJ2 Clone keeps settings, tags, verify topics, explore and verify, notifications; delete the clone
- [ ] PJ3 Portal editor: each setting persists after reload, the portal language included
- [ ] PJ4 Share: copy link, QR download, printouts, host guide

Reports
- [ ] R1 Generate with focus and custom instructions; cancel one generation; generate one to completion
- [ ] R2 Edit mode autosaves; copy content
- [ ] R3 Schedule at least 10 min ahead, reschedule, confirm it runs at the new time; cancel a schedule
- [ ] R4 Share > Public: publish, public page logged out, views and analytics, unpublish
- [ ] R5 Inbox "report is ready" opens the report; free account report limit

## 6. Secondary flows

- [ ] S1 Home, sidebar, Ctrl K search, inbox (mark read, open), What's new, documentation link, feedback modal
- [ ] S2 Workspace: create, rename, settings tabs; invite one of the user's addresses, copy link, resend, revoke; role options
- [ ] S3 Organisation: general, members, usage, billing; billing details save (change one field, then revert); documents page loads
- [ ] S4 Account and security (change name and revert; password and 2FA sections), My access, Appearance (theme; switch to nl-NL and check pages show no raw message ids such as `error.xxx`)
- [ ] S5 Webhooks: add `https://example.com/hook`, test, delete
- [ ] S6 Free account: upgrade prompts on creating a project, workspace or organisation; plan and usage pages
- [ ] S7 Staff: admin pages load (look only, change nothing)
- [ ] S8 Auth in a fresh anonymous browser: protected URL redirects to `/login?next=`, login, create account and password reset pages; unknown route
- [ ] S9 Owner at 390 px: menu drawer works, no horizontal scroll
- [ ] S10 Invitees: member sees the workspace; external cannot create projects or delete
- [ ] S11 Popcorn: open a session, it renders and updates
- [ ] S12 Analysis: recipes list, run one recipe to a result
- [ ] S13 Library and map: library loads (with and without canvases), generate the map
- [ ] S14 Present: create a presentation, edit, open the screen view and the public audience link
- [ ] S15 Connect your agent: settings page and the agent authorize page load
- [ ] S16 On every page: note console errors, 4xx/5xx API responses, and em dashes (`—`) in visible text

## 7. Severity and go / no-go

| Severity | Means | Release |
|---|---|---|
| Blocker | a core flow (section 5) fails for every user, data is lost or exposed, or users cannot sign in | no-go |
| Major | a core flow fails for some users or in some cases, or a secondary flow (section 6) fails outright, with no workaround | no-go unless a person accepts it in writing |
| Minor | cosmetic, wrong copy, an awkward but working path | go; ticket it |
| Pre-existing | known from an earlier report or also on production | go; note it |

A run is "go" with no Blocker and no unaccepted Major. A core flow left Not tested is listed as a risk next to the verdict.

## 8. Parallel lanes

Four lanes fit well: (1) sign-up + portal + monitor, (2) uploads + chat, (3) projects + reports, (4) secondary. The coordinator starts the daemon, signs in every role, finds the IDs below, then gives each lane agent this brief:

```
You are lane <name> of a staging QA run. Read skills/staging-qa.md and follow it.
Environment: <dashboard/portal/api URLs>, release <sha>.
Daemon: 127.0.0.1:<port>, already running. Signed-in contexts: <roles>.
Open your own pages: S.p['<lane>-<role>'] ??= await S.ctx.<role>.newPage(); close them at the end.
Use: workspace <id>, project with conversations <id>, org <id>.
Checks: <IDs from sections 5 and 6>.
Screenshots: L.shot(p, '<lane>', name). Prefix created data "QA <MMDD>".
Return: table of check | result | evidence, issues with severity (section 7), Not tested, data created.
```

The coordinator merges the lane results into one report.

## 9. Cleanup

- Delete or note every `QA <MMDD>` project, workspace, chat and template you created; unpublish test reports.
- Revert every setting you changed (portal editor, display name, language, theme, billing details).
- Close all pages and stop the daemon (`./stop.sh`).

## 10. Report

Write `REPORT.md` next to the screenshots (`QA_SHOTS`) in exactly this shape, and give the user the same tables as the final message. One row per area or issue, one short line per cell.

```
# Staging QA <date>

| Release | Environment | Verdict |
|---|---|---|
| <sha> | staging | GO / NO-GO |

| Area | Checks | Result | Notes |
|---|---|---|---|
| Sign-up and invites | A1-A4 | Pass / Fail / Not tested | |
| Portal | P1-P9 | | |
| Uploads and conversations | U1-U5 | | |
| Chat | C1-C7 | | |
| Projects | PJ1-PJ4 | | |
| Reports | R1-R5 | | |
| Secondary | S1-S16 | | |

| # | Issue | Severity | New? | Evidence |
|---|---|---|---|---|
| 1 | <one line> | Minor | New / Known | <screenshot> |

| Not tested | Why |
|---|---|

| Test data left | Where |
|---|---|
```
