---
name: verify-dembrane
description: Launch an isolated copy of the dembrane web app (API, worker, dashboard, participant portal) and drive it in a real browser with agent-browser to prove a change works the way a user sees it. Use before calling dashboard or portal work done, when reproducing a UI bug, or whenever a change needs evidence from the running app rather than from tests.
---

# Verify dembrane

Proves user-facing behaviour of the dembrane web app on a disposable instance. The surface is the browser: the **dashboard** (hosts, orgs, projects) and the **portal** (participants recording conversations). The API, worker and Postgres sit behind them. All paths below are from the repo root.

Never drive the developer's own stack on :8080, :5173 or :5174, and never write to its database. Everything here runs on a separate instance that `up.sh` starts.

## Launch

```sh
.agents/skills/verify-dembrane/scripts/up.sh      # prints the run's env file when ready
. dembrane/platform/.data/verify/<run>/env        # API_URL, DASHBOARD_URL, PORTAL_URL, DB_URL, EVIDENCE, STATE
```

`up.sh` picks Postgres from docker compose (`dembrane/platform/compose.yml`, its own compose project and port from :5533) when `docker info` succeeds, otherwise native Postgres on :5432 with a fresh database `echo_verify_<run>`. It then migrates, seeds verification topics, and starts the API (from :8180), worker, dashboard (from :5273) and portal (the next free port), each on the first free port. Ports and URLs are in the env file; never assume the defaults.

It needs bun, pnpm-installed `dembrane/frontend/node_modules`, `dembrane/platform/node_modules`, ffmpeg, and `dembrane/platform/.env.local` (created from `.env.example` with fresh secrets if missing, as `platform/scripts/setup.sh` does). Shell env overrides `.env.local`, so the run's database, port and URLs win.

Ready means usable: it exits 0 only once the API's `/ready` reaches the database and both dev servers proxy `/api/health` to it. A first run on a cold Vite cache can take a minute. On failure, read the logs in `$STATE/*.log`.

The portal is served at `http://portal.localhost:<port>`: the frontend only switches to the participant router on port 5174 or a hostname starting with `portal.` (`dembrane/frontend/src/config.ts`), and Chrome resolves `*.localhost` to this machine.

## Doctor

```sh
.agents/skills/verify-dembrane/scripts/doctor.sh  # newest run; VERIFY_RUN=<run> picks another
```

Read-only. Checks that each process is alive, owns its port, the API reaches its database, and both dev servers proxy to it. Run it first whenever anything looks off, and drive nothing until it exits 0.

## Drive

Use your own agent-browser session, and pass it on every command:

```sh
S=$(agent-browser session id --scope worktree --prefix verify)
agent-browser --session "$S" open "$DASHBOARD_URL/register"
agent-browser --session "$S" snapshot -i -c          # refs and accessible names
```

- Prefer `data-testid` selectors (`'[data-testid="auth-login-submit-button"]'`), then accessible names (`find label "Organisation name" fill …`, `find role button click --name "Skip"`). Never coordinates.
- A full-screen loading overlay (`BeautifulLoading`, class `*stageHost*`) covers the page while a route loads, and clicks fail with "covered by <div._stageHost…>". Before clicking on a freshly loaded page, run `agent-browser --session "$S" wait --fn '!document.querySelector("[class*=stageHost]")'`.
- Mantine checkboxes hide the real `<input>`. Tick them through the label: `find label "<label text>" check`.
- Locally the API keeps emails in memory (no `SENDGRID_API_KEY`). To verify an address, mint the link the email would carry: `bun .agents/skills/verify-dembrane/scripts/verify-link.ts <email> "$DASHBOARD_URL"`.
- Every account you create is new on this run's database, so use a fresh address such as `verify-$(date +%s)@example.com`.

Feature recipes live in [`features/`](features/README.md). Use the matching file; a proof that drives one convenient entry point is incomplete when the map lists others.

## Evidence

Write every artifact to `$EVIDENCE` (`dembrane/frontend/test-results/verify-dembrane/<run>/`, git-ignored), numbered in the order taken.

- Exercise the real user path through the browser. No test-only endpoints, no setting state in the database to skip a step. Minting the verification link is the one stand-in, because the email never leaves the API locally.
- Capture the action and the state it leads to: a screenshot after each meaningful step, plus the URL or snapshot text that shows it.
- Check side effects alongside the screen. Query the run's own database read-only with `psql "$DB_URL" -Atc "<select>"`: for example `auth_user.email_verified`, `auth_session` rows, `org.name`.
- Mock nothing. External services the local config leaves unset (email, LLMs) are out of scope; say so rather than faking them.

## Cleanup

```sh
agent-browser --session "$S" close
.agents/skills/verify-dembrane/scripts/down.sh    # newest run; VERIFY_RUN=<run> picks another
```

`down.sh` kills only the processes recorded in the run's pid files, copies the logs into `$EVIDENCE/logs/`, drops the run's database (or `docker compose down -v` on its own compose project), and removes `$STATE`. It never touches `$EVIDENCE`. Afterwards, check that `ls "$EVIDENCE"` still lists your artifacts. Run it after every failed attempt too, so broken runs don't leave ports and databases behind.

## Helpers

All in `scripts/`, executable, run from anywhere in the repo:

- `up.sh`: start an isolated instance; prints its env file.
- `doctor.sh`: read-only health check of a run.
- `down.sh`: tear down a run, keeping its evidence.
- `verify-link.ts <email> <dashboard-url>`: print the email-verification link for an address.
