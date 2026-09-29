---
name: product-release
description: Ship a release of the dembrane platform (dembrane/platform, the Bun API, worker, media service and the frontend it serves). The order to do things in, the checks that catch problems, and the decisions only a person makes.
---

# Product release

## What the workflow does

`.github/workflows/platform.yml`:

- Every PR and every push to `main` or `feat/bun-migration`: `10 Check server` (`biome ci`, typecheck, config, package layers, drizzle "No schema changes", every test), `20 Check frontend` (lint, `tsc`, tests, translations, API types in sync, portal first-load size) and `40 Build images`.
- A PR with the `preview` label: `50 Deploy PR preview` to dashboard-<n>, portal-<n> and api-<n>.preview.dembrane.com, and one comment on the PR with the links, edited on each deploy. Removing the label or closing the PR runs `51 Tear down PR preview`.
- next: `60 Deploy next` from main, by hand (and on each push to main once `NEXT_DEPLOY_ON_MAIN` is `true`). It posts the PRs it carried to #team-engineering and comments "Now on dembrane-next" on each.
- prod: `70 Deploy prod` from a release tag `vX.Y.Z` on main, by hand with the tag (and on pushing the tag once `PROD_DEPLOY_ON_TAG` is `true`), after the `prod` environment's approval. It creates the GitHub Release (an annotated tag's first line becomes its headline), posts to #team-engineering, comments "Released in vX.Y.Z" on each PR and sends `release.published` to sam.
- `90 Notify on failure` posts any failed job and step to #alerts-ci. Successes never reach Slack.

`scripts/release.sh` with `DRY_RUN=1` prints any of these messages without sending them.

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
cd dembrane/frontend && pnpm messages:extract && pnpm messages:compile && git diff --stat src/locales/
```

Commit any diff. English gaps block; other languages fall back to English.

## 4. Local checks

From `dembrane/platform`, against the parity Postgres (`parity/README.md`):

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
curl -sf https://echo-preview-api-218237812097.europe-west4.run.app/health | jq .release
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="echo-preview-api" AND severity>=ERROR' --project dembrane-web-previews --limit 50
```

Walk the flows the release touches as a host and as a participant, and the screens next to them. Recording needs a real phone on a real network; no agent can do that part. A defect found here goes back to step 2.

## 6. Production

Tag the release on main with an annotated tag whose first line is the headline (`git tag -a v2.5.0 -m "Popcorn ticks on their own worker"`), push it, and run the workflow for prod with that tag. A person approves the `prod` environment. The deploy runs the migrate job, then the services, then checks `/health` reports the sha. A bad release rolls forward with a fix; migrations do not roll back, which is why schema changes expand first and contract later.

## 7. Announce

`release.published` reaches sam with the tag, the notes and every PR (number, title, author). From it, draft, never publish:

- the in-app release notes entry: a PR that prepends a release to `getReleases()` in `dembrane/frontend/src/components/release/releases.ts` (customer-facing changes only, each typed feature, improvement or fix, `publication: { tag, date }`), with `messages:extract` run; a person reviews the copy and the translations before it merges, and it ships with the next deploy;
- documentation updates the changes call for;
- a video suggestion when a change is worth showing.

Record the release videos (a person), then publish the in-app announcement (`create-announcement.md`).

## Decisions only a person makes

- Release scope, and closing a PR that holds the only implementation of something.
- Any production schema change, and anything irreversible per record.
- Running a contract migration, and the archive it needs.
- Bypassing branch protection.
- A production rollout, its timing, and whether a defect is acceptable.
