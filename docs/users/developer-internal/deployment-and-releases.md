---
title: Deployment and releases
description: How a change to dembrane ships. The checks on a pull request, PR previews from a label, staging from main, production from a release tag after approval, and how migrations fit in.
audience: developer-internal
---

# Deployment and releases

A change reaches people in three steps: a PR preview when you ask for one, staging when it is merged to `main`, and production with the next release tag. One workflow does all of it: `.github/workflows/platform.yml`. Its header comment is the source of truth, together with `dembrane/infra/README.md`.

## The three environments

| Environment | How a change gets there |
|---|---|
| PR preview | Add the label `preview` to a pull request. |
| Staging | Deploys `main`: by hand, and on every push to `main` once the repository variable `STAGING_DEPLOY_ON_MAIN` is `true`. |
| Production | A release tag `vX.Y.Z` on `main`, after approval in the `prod` GitHub environment. |

So merging to `main` makes a change available on staging. Production gets it with the next release.

### PR previews

- Adding the `preview` label deploys a preview. Each push to a labelled pull request redeploys it.
- Removing the label, closing or merging the pull request removes it.
- At most three previews exist. A fourth removes the oldest, so take the label off when you are done.
- Each preview has its own database and is seeded with fictional sample data.
- The workflow posts one comment on the pull request with the links.
- There is no manual path. Previews come only from the label.

### Production

- The tag must be on `main` and must have the form `vX.Y.Z`. The workflow refuses anything else.
- The reviewers of the `prod` environment approve each deploy before the job runs.
- After the deploy the workflow publishes the GitHub Release.
- The documentation site is published with the release. See [maintaining the docs](./maintaining-docs.md).

## Checks on a pull request

The workflow runs on pull requests that touch `dembrane/platform`, `dembrane/frontend`, `dembrane/infra`, the workflow itself or `.github/scripts`. A run checks only the side that changed.

| Job | What it checks |
|---|---|
| `10-check-server` | Biome lint and format, the type check, `bun run config check`, `bun run packages check`, that the schema matches the migrations, that the frontend's generated API types are in sync, and `bun test --parallel`. |
| `20-check-frontend` | Path case, `pnpm lint`, `tsc`, the translations, and the generated API types. |
| `21-test-frontend` | `vitest run`. |
| `40-build-images` | Builds the five images once, smoke tests them, and checks the portal's first-load bundle size. |

A separate workflow, `.github/workflows/check-cla.yml`, checks that the author is listed in `contributors.yml`.

Run the main checks yourself before you push:

```sh
cd dembrane/platform && bun run check
cd dembrane/frontend && pnpm lint && pnpm exec tsc && pnpm test
```

Three checks catch people out:

- Schema drift. Change a table in the Drizzle schema and CI fails until you commit the migration that `bun run db:generate` writes.
- Translations. CI fails when `pnpm messages:extract` or `pnpm messages:compile` changes a catalog, or when a locale lacks a message that English has. `TRANSLATING.md` explains the catalogs.
- Config. `bun run config check` fails when a key is declared but never read, and when an environment file is invalid.

## How a deploy runs

- The five images are built once per commit from `dembrane/platform/apps/*/Dockerfile`. Each image is tagged with a hash of its inputs. An image whose inputs did not change is tagged for the new commit instead of built again.
- The frontend is not deployed separately. It ships inside the `web` image, and one build runs in every environment.
- A deploy only migrates, rolls out and verifies.
- In every environment the `migrate` app runs before the new version takes traffic. A failed migration stops the deploy.
- The running build reports its release at `/health`.

PR previews and staging run on Google Cloud Run in `europe-west4`. Each environment is its own cloud project with its own identities, so a preview cannot reach staging or production. Production runs on Kubernetes through a GitOps repository: the production job pushes the images and sets the image tag there, and Argo CD migrates, rolls out and smoke tests.

`.github/scripts/build-images.sh --load` builds the images into your local Docker daemon when you need to test one.

## Migrations

- Add or change a table in the Drizzle schema, run `bun run db:generate`, and commit the SQL file.
- A migration whose name contains `_contract_` drops something. Outside the local, test and preview environments it runs only after an archive of the dropped tables is recorded.
- An advisory lock keeps two migrate jobs from racing.
- Changing the order or number of steps in a durable workflow needs a bump of `WORKFLOW_VERSION`. See [background jobs and schedules](./background-jobs-and-scheduler.md).

## Config per environment

Non-secret values for each environment are checked in: `packages/config/environments/{local,test,preview,staging,prod}.ts`. A secret may only come from the process environment. Setting one in an environment file fails the boot.

Two tests guard these files. A residency test fails when a model, embedding or email location leaves the EU. A capacity test fails when an environment's database connections would not fit its server.

Feature switches are config keys too. `bun run config show <env>` prints the effective values for an environment, and `bun run config diff <env> <env>` compares two.

## Related

- [Local development](./local-development.md)
- [Architecture](./architecture.md)
- [The data model](./data-model.md)
- [Maintaining the docs](./maintaining-docs.md)
- [Self-hosting](../developer-external/self-hosting.md)
- [Contributing](../developer-external/contributing.md)
