# Skill: Product Release

How dembrane ships a production release. Releases go out roughly every two weeks, aligned to the Linear cycle, from a `v*.*.*` tag on `main`.

`echo/docs/branching_and_releases.md` describes the mechanism. This file is the operating procedure: the order to do things in, the checks that have actually caught problems, and the steps a person has to do themselves.

Everything below is dembrane's pipeline, not general practice. The phase order generalises to any team with a staging environment and a tag-triggered production deploy. The commands and paths do not; they are specific to this repo.

## What this document is, and is not

This is a record of how one release actually went, written down while it was fresh. It is not a claim that this is the right way to ship software, and it is not how anyone here would design the process from scratch.

Quite a lot of what follows exists because something went wrong and we worked around it. Some of it is genuinely good practice. Some of it is a symptom: production drifting weeks behind the schema, a test step missing from continuous integration, knowledge living in one person's head instead of the repository. Those are problems to fix, not conventions to preserve.

So read it as field notes rather than doctrine. If a step here looks wrong to you, it may well be. The point of writing it down is to have something concrete to argue with, and to fix together, rather than rediscovering the same traps one release at a time. Where a step exists only because of an underlying problem, that is called out so the fix is obvious later.


## What a tag actually sets off

Worth holding in your head before you touch anything, because most of the sequencing rules fall out of it.

A tag matching `v*.*.*` starts three workflows at once:

- `.github/workflows/prod-deploy-gitops-backends.yaml` rewrites `imageTag` in `helm/echo/values-prod.yaml` in the `dembrane/echo-gitops` repo to the tag's commit sha and pushes to gitops `main`. Argo CD (`argo/echo-prod.yaml`, automated sync with `prune` and `selfHeal`) then rolls the `echo-prod` namespace.
- `.github/workflows/prod-deploy-vercel-dashboard.yml` and `prod-deploy-vercel-portal.yml` build and deploy the frontend on Vercel.

The frontend path is shorter, so **the frontend usually goes live before the backend**. Anything where the browser depends on a new endpoint has to tolerate that window, or the backend has to be in place before the tag.

Also: `ci.yml` only pushes images on a `push` event to `main` or `hotfix-*`. An unmerged PR has no image anywhere.

## The order, and why

**translations → QA on echo-next → gitops prep → cut tag → videos → announcement**

QA sits before the tag on purpose. echo-next (`dashboard.echo-next.dembrane.com`, deployed from `main` on every merge) is the only place the release code can be exercised before production sees it. Once the tag exists, production is already changing. A tag is not a rehearsal, so everything that could have been caught by using the product gets caught first.

Translations come before QA because a missing translation is visible in QA. Do them the other way round and you QA a build that is not the one you ship.

gitops preparation sits between QA and the tag because it is the only work that has to be positioned relative to the tag rather than simply done: additions before, removals after. See "learned the hard way".

Videos and the announcement come last because they describe what is live.

---

## Phase 1: Scope and triage

Decide what is in, then prove the set can actually be assembled.

- [ ] Establish the current production tag: `git tag --sort=-creatordate | head -1`.
- [ ] List what has already landed since it: `git log --oneline <last-tag>..main`.
- [ ] List open PRs: `gh pr list --state open`.
- [ ] Sort every one into: merge before the release, merge after, needs work, close. Nothing stays unsorted.
- [ ] For each candidate, check the real CI state rather than the badge on the page: `gh pr checks <n>`.
- [ ] Check what the checks ran against. A green run on a base from before other PRs landed says nothing about the tree you are about to create.

```bash
gh pr view <n> --json baseRefOid,headRefOid,mergeStateStatus,statusCheckRollup
```

- [ ] Test-merge the candidates into a throwaway worktree, in the order you intend to merge them, and confirm each is conflict-free.

```bash
git worktree add /tmp/release-merge-test main
cd /tmp/release-merge-test
git merge --no-commit --no-ff origin/<branch>   # repeat per PR, in order
git merge --abort
cd - && git worktree remove /tmp/release-merge-test
```

- [ ] Verify the merge **order**, not just the set. Two PRs touching the same files can merge cleanly one way round and conflict the other.

## Phase 2: Review what you are actually shipping

The triage tells you which PRs are candidates. This phase tells you whether they are correct. In the release this procedure came from, two PRs claimed green CI and both had blocking defects.

- [ ] Read the diff of every PR going in. Not the description, the diff.
- [ ] Check the claims in the description against the code. A PR that says a feature is opt-in has to be traced through every path that reads the flag; hardcoded call sites that ignore the new constant are a common way for "opt-in" to be untrue.
- [ ] Check whether a change is reversible per record. If it converts existing rows, count them against production before merging, and count how many are non-trivial (have content, have history). A read-only query is cheap; an irreversible conversion is not.
- [ ] Check whether the build actually ran the tests. A build failure earlier in a job means later steps never ran, which can hide a broken test behind a red mark that looks like an unrelated flake.
- [ ] For any fix, especially a security fix, check that it did not introduce something worse. A regex added to sanitise caller-supplied input needs its complexity considered on unbounded input running inline on the API event loop. Measure it against a large input rather than assuming.
- [ ] Know what your gates actually check. In this repo `ci-check-server` runs mypy and ruff; `ci-check-frontend` runs `pnpm run lint` and `pnpm run build`, with no test step. `pnpm test` (vitest) exists in `echo/frontend/package.json` and never runs in CI.

## Phase 3: Merge, in the proven order

- [ ] Merge in the order you verified in phase 1.
- [ ] Re-run checks after each merge if later PRs depend on earlier ones.
- [ ] ⚠️ **Admin-merging past branch protection needs explicit human approval.** If a merge is blocked, the default answer is to fix the blockage, not to bypass it.
- [ ] Close or defer everything you decided not to ship, with a reason on the PR.

## Phase 4: Translations

Blocking, not cosmetic. Lingui macros compile away the source text: `<Trans>Hello</Trans>` becomes `<Trans id="2CludW" />`. A production build has no English fallback, so a string that was never extracted and compiled renders to participants and hosts as the raw id. 3442 of the 3680 ids in `echo/frontend/src/locales/en-US.ts` are hashes of this shape, so this is the normal case, not an edge case.

```bash
cd echo/frontend
pnpm messages:extract
pnpm messages:compile
git diff --stat src/locales/
```

- [ ] A non-empty diff after extract means somebody shipped a string without extracting it. That is expected; commit the result.
- [ ] Check `src/locales/en-US.po` for entries where `msgstr` is empty. English is the source locale, so `msgstr` should mirror `msgid`.
- [ ] Confirm a handful of the new ids resolve in the compiled catalogues: `grep -c '"<new-id>"' src/locales/*.ts`.
- [ ] Confirm the build: `pnpm run build`.
- [ ] Non-English catalogues (`nl-NL`, `de-DE`, `fr-FR`, `es-ES`, `it-IT`, `uk-UA`, `cs-CZ`) can ship with gaps; they fall back to the source locale. English gaps cannot.

## Phase 5: QA on echo-next

Once `main` is complete and translated, exercise it where it is running.

- [ ] Confirm echo-next has picked up the merges.
- [ ] Walk the flows the release touches, as a host and as a participant.
- [ ] Recording QA needs a real phone on a real network. A desktop browser does not cover it, and no agent can do this part.
- [ ] Check the surfaces adjacent to what changed, not only the changed surface itself.
- [ ] Anything found here goes back to phase 2. Do not carry a known defect past this point on the reasoning that it is small.

## Phase 6: Schema, checked in both directions

Directus holds the data layer, and the schema is the part of a release most likely to be quietly out of date. Read `echo/AGENTS.md` "Directus Rules" before touching anything here.

`sync.sh diff` is read-only and safe. Run it against echo-next and then against production, and compare the two results. In the release this came from, that comparison showed production missing 14 collections, 142 field changes and 25 relations, including the tables behind the release's headline features, against a planning document that described the gap as "seven migrations".

```bash
cd echo/directus
bash sync.sh -u https://directus.echo-next.dembrane.com -e <admin-email> -p <password> diff
bash sync.sh -u https://directus.dembrane.com          -e <admin-email> -p <password> diff
```

- [ ] Run `diff` against both environments before considering any `push`.
- [ ] Never hand-write snapshot or sync JSON. Collections and fields are created by an idempotent Python script against the Directus REST API (`POST /collections`, `POST /fields`, `POST /relations`), checked step by step against a local Directus, then pulled with `sync.sh ... pull` and committed under `echo/directus/sync/snapshot/`.
- [ ] Before a production `push`, scan the snapshot for the `is_indexed` trap. A field file with `schema.is_indexed: false` over a column that production indexes under a different name (the `idx_*` performance indexes) makes Directus diff `true → false` and knex emit `DROP INDEX "{table}_{field}_index"`, which does not exist, aborting the whole apply. It only shows on production, because echo-next lacks those indexes. The fix is to set `is_indexed: true` in `echo/directus/sync/snapshot/fields/<collection>/<field>.json`.
- [ ] ⚠️ **`sync.sh ... push` against production is destructive and needs explicit human approval.** It applies schema changes to the live database.
- [ ] A release containing schema changes is scheduled for off-hours. A frontend-only release can go out in working hours.

## Phase 7: Infrastructure preparation and the deploy race

- [ ] Work out what has to be in place **before** the tag: new env vars, new secrets, capacity, any service the frontend will start calling.
- [ ] Additions to gitops go in before the tag. Removals wait until after. See "learned the hard way".
- [ ] Where the frontend winning the race would expose a feature before its backend is ready, bring the backend up first. The pattern used: disable auto-sync on the Argo application, bump the service, confirm it boots, re-enable auto-sync, then let the tag roll normally.
- [ ] ⚠️ **Disabling auto-sync and pushing to gitops `main` are both immediate production changes and need explicit human approval.** The gitops repo has no CI gate; a push to `main` is the change. The exact mechanism for pausing sync (the `syncPolicy.automated` block in `argo/echo-prod.yaml`, applied with `kubectl apply`, or the Argo CD interface) should be confirmed with whoever holds cluster access rather than guessed at.
- [ ] Read-only inspection is always fine:

```bash
kubectl -n echo-prod get pods
kubectl -n echo-prod get deploy
kubectl -n echo-prod rollout status deploy/<name>
kubectl -n echo-prod logs deploy/<name> --tail=100
```

## Phase 8: Cut the tag

- [ ] Confirm `main` is at the commit you reviewed.
- [ ] Create the GitHub release from that commit. Version is a human decision.
- [ ] Write release notes from the merged PRs, in dembrane's voice, describing what changed for hosts and participants rather than which modules moved.

## Phase 9: Watch it land, then clean up

- [ ] Confirm the gitops commit landed: `imageTag` in `helm/echo/values-prod.yaml` should now be the tag's commit sha.
- [ ] Confirm Argo synced and the `echo-prod` pods are running the new image.
- [ ] Exercise the release on production, at least the paths QA covered.
- [ ] **Now** remove any env var or config key you retired in this release from the gitops values files. Not before.
- [ ] If something is wrong, the route back is a hotfix branch off the release tag and a new tag, not a hand edit on the cluster. See `echo/docs/branching_and_releases.md`.

## Phase 10: Videos and the announcement

- [ ] Record the release videos. A person has to do this; it is the part of the release that cannot be delegated to tooling.
- [ ] Publish the in-app announcement. See `skills/create-announcement.md` for the schema and the working push path.
- [ ] Update the docs corpus for anything user-visible. See `.claude/skills/code-to-docs/SKILL.md`.

---

## Learned the hard way

These are mistakes an agent will make by default. Read them twice.

### gitops removals are immediate, code moves on tags

Argo tracks gitops `main` for every cluster including production, so a config change merged there reaches production within minutes. Production **code** only advances on a `v*.*.*` tag. Removing an env var from gitops while production still runs older code that requires it takes production down.

This happened on 2026-07-02: two feature-flag fields were deleted from `settings.py` on `main` and removed from `helm/echo/values*.yaml`, while the deployed production release still required them. Every worker, the scheduler, and the new API replica set crash-looped on settings validation. Transcription was dead for about two and a half hours.

The order is: remove it from the code, ship that to a release tag, then clean gitops. Leaving a stale env var in place in the meantime is harmless, because every settings class in `echo/server/dembrane/settings.py` uses `extra="ignore"`. When unsure what the running release reads, check it: `git show <deployed-sha>:echo/server/dembrane/settings.py`.

### Argo self-heals, so do not change production by hand

`kubectl scale` and `kubectl patch` on managed resources get reverted on the next sync. Capacity changes go through `helm/echo/values-prod.yaml` in gitops. Read-only `kubectl` for diagnosis is fine.

### Never push to gitops `main` casually

There is no review gate between a push and production. Treat every commit there as a deploy.

### A green check on a stale base proves nothing

`gh pr checks` reports what ran, against the base it ran against. Confirm the base, and test-merge into a throwaway worktree before believing a set of PRs can ship together.

### CI may not run what you assume

`ci-check-frontend` in `.github/workflows/ci.yml` runs lint and build only. Frontend tests exist and never run in CI. Before trusting a gate, read it.

### Verify claims against the code, not the PR description

Descriptions state intent. Code states behaviour. A flag introduced as opt-in is only opt-in if every path that could set it reads the new constant, and the way to know is to find all of them.

### Verify that a fix did not introduce something worse

A patch that closes one problem can open a larger one. A regex added to sanitise input needs its worst-case complexity checked against unbounded, caller-supplied values on the path it actually runs on. Measure it.

### Frontend feature flags are compile-time constants

They are resolved by `byEnv()` in `echo/frontend/src/config.ts`, not by runtime env vars, so changing one means a new build and a new deploy. There is no way to flip one on a running production frontend.

Keep "is the feature available" and "is the feature the default" as two separate constants. Collapse them into one and every `if (FLAG)` in the codebase quietly also means "and it is the default", which is how a feature meant to be opt-in becomes mandatory.

### Never hand-write Directus snapshot JSON

Use the REST API through an idempotent script, verify, `pull`, commit the snapshot. Hand-edited JSON produces schema applies that fail halfway.

## Decisions only a human makes

Surface these; do not settle them yourself.

- **Release scope.** What ships and what waits.
- **Closing a PR that holds the only implementation of a feature.** The code goes away with it.
- **Any production schema change.** Every `sync.sh push` against production, and every manual DDL statement.
- **Anything irreversible per record.** A migration that converts existing rows needs the count, the count of rows with real content, and a decision from a person before it merges.
- **Bypassing branch protection.**
- **Pausing Argo auto-sync, or any gitops push during a release.**
- **The version number**, and whether the release is off-hours.

## What cannot be automated

Keeping this honest matters more than making the runbook look complete.

- Recording the release videos needs a person.
- QA of real recording needs a real phone on a real network.
- Judging whether a half-finished feature is good enough to be seen is a taste question.
- Deciding that a defect is acceptable is a decision, not a check.
