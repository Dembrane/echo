# dembrane verification map

The maintained list of user-facing features to prove on a `verify-dembrane` instance. Read this index, then use the matching feature file as the recipe.

## Baseline preconditions

- A run started with `scripts/up.sh`, `VERIFY_RUN` exported, its env file sourced, and `scripts/doctor.sh` exiting 0.
- The run's database is fresh: migrated, verification topics seeded, no users, orgs or projects.
- The run's own agent-browser session, `--session "$SESSION"`, on every command.
- Never drive the developer's stack on :8080, :5173 or :5174.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise. Recipes that start signed in use `scripts/seed-user.sh`, then the login batch in [auth.md](./auth.md).
- Prefer `data-testid` selectors, then accessible names from `snapshot -i -c`.
- Wait for the loading overlay to clear before clicking on a freshly loaded page (see the skill's Drive section).
- Treat names and test ids as literal.
- After login, check for a "What's new" dialog over the page before asserting on it (see [auth.md](./auth.md)).

## Proof and skip reporting

- Record with `scripts/evidence.sh`: a `note` naming the feature file and sub-feature before each action, a `step` after it, and a `query` for anything the action stored. All of it lands in `$EVIDENCE/proof.md`.
- When a precondition can't be met, report the command you tried and what was missing. Never report a skipped entry point as verified through another.

## Feature entry contract

Each feature file has an H1, one paragraph of user-visible behaviour, then four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with agent-browser` (starting with `Preconditions:`), and `Gotchas`.

## Features

- [Account: register, verify, log in](./auth.md): proven on a fresh run.
- [Onboarding](./onboarding.md): organisation, invite and about-you steps after the first login; proven on a fresh run.
- [Create a project](./projects.md): from a format proven on a fresh run; from files, text or a link not yet driven.
- [Participant portal](./portal.md): start, tutorial, record and finish on a phone with a fake microphone; proven on a fresh run.
