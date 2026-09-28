---
name: product-release
description: Ship a release of the dembrane platform (echo/platform, the Bun API, worker, media service and the frontend it serves). The order to do things in, the checks that catch problems, and the decisions only a person makes.
---

# Product release

## What a merge sets off

`.github/workflows/platform.yml` runs on every push to `feat/bun-migration`:

1. `check`: `biome ci`, typecheck, `bun run config check`, drizzle "No schema changes", every test.
2. `frontend`: lint, `tsc`, the accounts contract copy, the portal first-load size.
3. `images`: api, worker, migrate, media and web, built once and pushed.
4. `deploy-preview`: the migrate job runs first (a failure stops the rollout before new code takes traffic), then media, API, worker, dashboard and portal roll out together, then a smoke test checks `/health` reports the new sha.

Preview is the only environment the workflow deploys. `next` and `prod` have config (`packages/config/environments`) but no deploy job. Until one exists, a production rollout is a person's call and a person's run: write down what they ran, do not improvise one.

## The order

scope → review → translations → local checks → merge (deploys preview) → QA on preview → production → announcement

## 1. Scope

```sh
gh pr list --base feat/bun-migration --state open
gh pr view <n> --json baseRefOid,headRefOid,mergeStateStatus,statusCheckRollup
```

Sort every PR: in, after, needs work, close. A green run on a stale base says nothing about the tree you are about to create; test-merge the set in order in a throwaway worktree.

## 2. Review the diffs

Read the diff, not the description. Trace every claim ("opt-in", "no data change") through the code. For a change that converts rows, count them on the target database first, and how many have real content.

## 3. Translations

A string never extracted renders as its raw id in production.

```sh
cd echo/frontend && pnpm messages:extract && pnpm messages:compile && git diff --stat src/locales/
```

Commit any diff. English gaps block; other languages fall back to English.

## 4. Local checks

From `echo/platform`, against the parity Postgres (`parity/README.md`):

```sh
rm -rf .cache && TEST_DATABASE_ADMIN_URL=postgres://dembrane:dembrane@127.0.0.1:5440/postgres bun run check
bun run config check
(cd packages/db && bunx drizzle-kit generate < /dev/null | grep "No schema changes")
```

Migrations:

- A new migration is numbered after the highest in `packages/db/migrations`; contract migrations (`_contract_` in the tag) stay last.
- A contract migration drops what the old stack still reads. Outside local, test and preview it runs only after `packages/db/scripts/archive-tables.sh` has recorded an archive of what it drops.
- Config: add a key before the code that reads it ships; remove one only after the release that stopped reading it is live.

## 5. Merge and QA on preview

Merge in the order you tested. Admin-merging past branch protection needs a person's explicit yes. Then:

```sh
curl -sf https://echo-preview-api-86405194907.europe-west4.run.app/health | jq .release
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="echo-preview-api" AND severity>=ERROR' --project dembrane-echo --limit 50
```

Walk the flows the release touches as a host and as a participant, and the screens next to them. Recording needs a real phone on a real network; no agent can do that part. A defect found here goes back to step 2.

## 6. Production

Run only what a person approved, in the same order as preview: migrate job, then the services, then `/health` on `https://api.dembrane.com` reports the sha. A bad release rolls forward with a fix; migrations do not roll back, which is why schema changes expand first and contract later.

## 7. Announce

Record the release videos (a person), then publish the in-app announcement (`create-announcement.md`).

## Decisions only a person makes

- Release scope, and closing a PR that holds the only implementation of something.
- Any production schema change, and anything irreversible per record.
- Running a contract migration, and the archive it needs.
- Bypassing branch protection.
- A production rollout, its timing, and whether a defect is acceptable.
