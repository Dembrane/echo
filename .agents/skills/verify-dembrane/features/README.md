# dembrane verification map

The maintained list of user-facing features to prove on a `verify-dembrane` instance. Read this index, then use the matching feature file as the recipe.

## Baseline preconditions

- A run started with `scripts/up.sh`, its env file sourced, and `scripts/doctor.sh` exiting 0.
- The run's database is fresh: migrated, verification topics seeded, no users, orgs or projects.
- An agent-browser session of your own, passed as `--session "$S"` on every command.
- Never drive the developer's stack on :8080, :5173 or :5174.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise. Recipes that need a signed-in user say which recipe gets you there.
- Prefer `data-testid` selectors, then accessible names from `snapshot -i -c`.
- Wait for the loading overlay to clear before clicking on a freshly loaded page (see the skill's Drive section).
- Treat names and test ids as literal.

## Proof and skip reporting

- Screenshot each meaningful step into `$EVIDENCE`, numbered, and record the URL after each navigation.
- Pair what the screen shows with a read-only query against `$DB_URL` for anything the action stored.
- Record the feature file and sub-feature with each artifact.
- When a precondition can't be met, report the command you tried and what was missing. Never report a skipped entry point as verified through another.

## Feature entry contract

Each feature file has an H1, one paragraph of user-visible behaviour, then four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with agent-browser` (starting with `Preconditions:`), and `Gotchas`.

## Features

- [Account: register, verify, log in](./auth.md): proven on a fresh run.
- [Onboarding](./onboarding.md): organisation, invite and about-you steps after the first login; proven on a fresh run.
- [Create a project](./projects.md): entry points recorded, recipe not yet run end to end.
- [Participant portal](./portal.md): entry points recorded, recipe not yet run end to end.
