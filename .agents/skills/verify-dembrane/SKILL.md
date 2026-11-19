---
name: verify-dembrane
description: Launch an isolated copy of the dembrane web app (API, worker, dashboard, participant portal) and drive it in a real browser with agent-browser to prove a change works the way a user sees it. Use before calling dashboard or portal work done, when reproducing a UI bug, or whenever a change needs evidence from the running app rather than from tests.
---

# Verify dembrane

Proves user-facing behaviour of the dembrane web app on a disposable instance. The surface is the browser: the **dashboard** (hosts, orgs, projects) and the **portal** (participants recording conversations). The API, worker and Postgres sit behind them. All paths below are from the repo root.

Never drive the developer's own stack on :8080, :5173 or :5174, never write to its database, and never touch a verify run you didn't start. Other agents and worktrees may have runs up at the same time.

## Launch

```sh
.agents/skills/verify-dembrane/scripts/up.sh        # prints the run's env file when ready
export VERIFY_RUN=<run>                              # the folder name in that path
. dembrane/platform/.data/verify/$VERIFY_RUN/env    # API_URL, DASHBOARD_URL, PORTAL_URL, DB_URL, EVIDENCE, SESSION
```

`up.sh` picks Postgres from docker compose (`dembrane/platform/compose.yml`, its own compose project and port from :5533) when `docker info` succeeds, otherwise native Postgres on :5432 with a fresh database `echo_verify_<run>`. It then migrates, seeds verification topics, and starts the API (from :8180), worker, dashboard and portal (from :5273). Each run claims its ports atomically, so runs started at the same moment never collide. Ports and URLs are in the env file; never assume them.

Export `VERIFY_RUN` for the whole task. Every helper acts on that run, and with more than one run up and no `VERIFY_RUN`, they refuse rather than guess.

It needs bun, pnpm-installed `dembrane/frontend/node_modules`, `dembrane/platform/node_modules`, ffmpeg, and `dembrane/platform/.env.local` (created from `.env.example` with fresh secrets if missing, as `platform/scripts/setup.sh` does). Shell env overrides `.env.local`, so the run's database, port and URLs win.

Ready means usable: it exits 0 only once the API's `/ready` reaches the database, the worker reports in on `/ready/worker`, and both dev servers proxy `/api/health` to the API. A first run on a cold Vite cache can take a minute. On failure it prints the cleanup command; the logs are in `$STATE/*.log`.

The portal is served at `http://portal.localhost:<port>`: the frontend only switches to the participant router on port 5174 or a hostname starting with `portal.` (`dembrane/frontend/src/config.ts`), and Chrome resolves `*.localhost` to this machine.

## Doctor

```sh
.agents/skills/verify-dembrane/scripts/doctor.sh
```

Read-only. Checks that each process is alive and owns its port, the API reaches its database, the worker reports in, both dev servers proxy to the API, and the platform code hasn't changed since launch. The API and worker don't reload, so after editing `dembrane/platform` restart with `down.sh` then `up.sh`; frontend edits hot-reload. Run it first whenever anything looks off, and drive nothing until it exits 0.

## Drive

Use the run's own browser session, `$SESSION` from the env file, on every command:

```sh
agent-browser --session "$SESSION" open "$DASHBOARD_URL/login"
agent-browser --session "$SESSION" snapshot -i -c          # refs and accessible names
```

- Prefer `data-testid` selectors, then accessible names (`find label "Organisation name" fill …`, `find role button click --name "Skip"`). Never coordinates.
- A full-screen loading overlay (`BeautifulLoading`, class `*stageHost*`) covers the page while a route loads, and clicks fail with "covered by <div._stageHost…>". On a freshly loaded page, wait for the element you need first, then for the overlay to clear: `wait --fn "!document.querySelector('[class*=stageHost]')"`. The overlay check alone passes before the page has rendered.
- Mantine checkboxes hide the real `<input>`. Tick them through the label: `find label "<label text>" check`.
- Run a known sequence as one call with `agent-browser --session "$SESSION" batch --bail "<cmd>" "<cmd>" …`. Each command string is split like a shell line, so quote an argument with spaces in double quotes and use single quotes inside it, as in the overlay wait above. [`features/auth.md`](features/auth.md) has a login batch to copy.
- Signed-in starting points: `scripts/seed-user.sh` creates a verified account through the same API calls the register and verify pages make (`--org "<name>"` also completes onboarding) and prints `EMAIL=` and `PASSWORD=`. Then log in through `/login`. Use it for every feature except sign-up itself, which [`features/auth.md`](features/auth.md) drives through the browser.
- Locally the API keeps emails in memory (no `SENDGRID_API_KEY`). To verify an address by hand, mint the link the email would carry: `bun .agents/skills/verify-dembrane/scripts/verify-link.ts <email> "$DASHBOARD_URL"`.
- Participants use phones. For the portal, launch the session with a fake microphone and a phone screen, before its first `open`: `agent-browser --session "$SESSION" --args "--use-fake-device-for-media-stream,--use-fake-ui-for-media-stream" open "$PORTAL_URL/<project-id>/start"`, then `set device "iPhone 14"` and `reload`. `--args` only applies when the session's browser launches, so a session that already ran a dashboard recipe needs `agent-browser --session "$SESSION" close` first. This is Chromium with an iPhone screen size and user agent, not Safari: iOS-only behaviour (wake lock, the iOS 16 floor) stays unproven here.

Feature recipes live in [`features/`](features/README.md). Use the matching file; a proof that drives one convenient entry point is incomplete when the map lists others.

## Evidence

Record proof with `scripts/evidence.sh`, which numbers everything into `$EVIDENCE` (`dembrane/frontend/test-results/verify-dembrane/<run>/`, git-ignored) and appends it to `$EVIDENCE/proof.md`. `up.sh` starts `proof.md` with the branch, commit, uncommitted changes, database and URLs.

```sh
S=.agents/skills/verify-dembrane/scripts
$S/evidence.sh note "what you are about to do and what should happen"
$S/evidence.sh step <name>                 # screenshot, page text and URL of $SESSION
$S/evidence.sh query "<label>" "<select>"  # read-only query on the run's database, output kept
```

- Exercise the real user path through the browser for the feature under test. No test-only endpoints, no setting state in the database to skip a step. `seed-user.sh` sets up preconditions only, and minting the verification link is the one stand-in, because the email never leaves the API locally.
- Capture the action and the state it leads to: a `note` before, a `step` after each meaningful action.
- Check side effects alongside the screen with `query`: for example `auth_user.email_verified`, `auth_session` rows, `org.name`.
- Record failed attempts too, with a `note` saying what went wrong. `proof.md` is append-only.
- Mock nothing. External services the local config leaves unset (email, LLMs) are out of scope; say so rather than faking them.

## Cleanup

```sh
.agents/skills/verify-dembrane/scripts/down.sh
```

`down.sh` closes the run's browser session, kills only the processes in its pid files, copies the logs into `$EVIDENCE/logs/`, drops its database (or `docker compose down -v` on its own compose project), releases its ports and removes `$STATE`. It never touches `$EVIDENCE`. Afterwards, check that `$EVIDENCE/proof.md` still lists your artifacts. Run it after every failed attempt too, so broken runs don't leave ports and databases behind.

## Helpers

All in `scripts/`, executable, run from anywhere in the repo, acting on `$VERIFY_RUN`:

- `up.sh`: start an isolated run; prints its env file.
- `doctor.sh`: read-only health check.
- `evidence.sh step <name> | query <label> <sql> | note <text>`: record proof into `proof.md`.
- `seed-user.sh [--org <name>]`: a verified account, optionally onboarded.
- `verify-link.ts <email> <dashboard-url>`: the email-verification link for an address.
- `down.sh`: tear down, keeping the evidence.
