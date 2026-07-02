---
title: Deployment & releases
description: How dembrane ships - main to echo-next on merge, tags to production, the testing-branch reset rule, the GitOps repo, Dockerfiles, and database migrations.
audience: developer-internal
---

# Deployment & releases

dembrane has a short, opinionated path from a merged PR to production. `main` continuously
deploys to a staging environment; production ships from *release tags* roughly every two
weeks. This page covers the branches, the environments, the GitOps repo, the Docker images, and
the migration ritual. The canonical engineering docs are
`echo/docs/branching_and_releases.md` and `echo/docs/database_migrations.md` - this page is the
orientation and the gotchas.

## The environments

| Environment | URL | Deploys from | Notes |
|---|---|---|---|
| *Testing* | `dashboard.testing.dembrane.com` | `testing` branch (on push) | Shared, unprotected staging. |
| *Echo Next* | `dashboard.echo-next.dembrane.com` | `main` (on merge) | Staging / preview; auto-deploys ~2 min after merge. |
| *Production* | `dashboard.dembrane.com` | GitHub *release tag* on `main` | Every ~2 weeks. |

Each environment has matching `dashboard.*`, `portal.*` and `directus.*` subdomains.

> [!NOTE]
> "Echo Next" is the staging name (`dashboard.echo-next.dembrane.com`). It is not a separate
> product - it's `main` running ahead of the production tag. Use it to confirm a merged change
> behaves before it's cut into a release.

## The development flow

```
main ──────────●──────────────●────  (auto-deploys to Echo Next)
       \      ↗ PR             |
        feat/ECHO-123          |
                \              |
                 testing ────→ dashboard.testing.dembrane.com
```

1. *Branch off `main` - `feat/ECHO-xxx-description` or similar.
2. *Develop* on the feature branch.
3. *(Optional) test on the testing environment* - merge your branch into `testing` to deploy to `dashboard.testing.dembrane.com`.
4. *Open a PR* to `main`.
5. *After merge* - changes auto-deploy to Echo Next (~2 min).
6. *After you're done testing* - reset `testing` back to `main`.

### The testing-branch reset rule

`testing` is *shared and unprotected* - anyone can push to it. So before you use it, check
nobody else is mid-flight, and when you're done, reset it:

```bash
# before: is testing ahead of main? (someone else's work?)
git log main..testing --oneline

# after: hand it back clean
git checkout testing
git reset --hard origin/main
git push --force
```

> [!WARNING]
> Don't force-push `testing` over someone else's in-flight changes. Run the `git log
> main..testing` check first; if there are commits ahead of `main`, ask the team before
> overwriting. `testing` is a scratch environment, not a branch to build on.

## The release process

Releases align with the two-week Linear cycles:

1. *Accumulate* changes on `main` through the cycle.
2. *Pre-release checks* (the easy-to-forget ones):
   - *New env vars* - anything added as a field on `AppSettings` in `settings.py`, or exported from the frontend `config.ts`. If a release needs a new var, it must be set in the GitOps repo *before* the tag, or the new pods crash-loop. *Check the env-flag/feature-flag state too* - make sure a half-built feature isn't about to light up in prod.
   - *Directus migrations* - run any data/schema migrations (see below).
   - *GitOps env* - update deployment env vars in the GitOps repo if needed.
3. *Tag and release* - cut a GitHub release from a commit on `main`.
4. The release *auto-deploys to production*:
   - *Backend* - new image tags are picked up by the GitOps repo (`dembrane/echo-gitops`); *Argo CD* auto-syncs them.
   - *Frontend* - auto-deploys via Vercel.

### Hotfixes

When a critical prod bug needs fixing but `main` has unreleased changes that *shouldn't* go out,
branch the fix off the released tag, not off `main`, and release it on its own. The exact
cherry-pick recipe is in `echo/docs/branching_and_releases.md` - follow it rather than improvising.

## The GitOps repo

Production infra lives in a separate repo, `dembrane/echo-gitops`:

- *Terraform* - DigitalOcean infrastructure (clusters, managed Postgres, Spaces, Valkey).
- *Helm* - the chart that templates the Kubernetes resources for each service.
- *Argo CD* - continuous delivery; it watches the repo and auto-syncs the cluster to match. New image tags from a release are reconciled by Argo, not pushed by hand.

So a backend release is really: build image → bump tag in `echo-gitops` → Argo syncs. Changing
a prod env var means editing the GitOps repo (often a sealed/encrypted value), not the cluster
directly.

## The Docker images

Four service images are built from the monorepo:

| Image | Dockerfile | Notes |
|---|---|---|
| *server* | `echo/server/Dockerfile` | The FastAPI API, workers and scheduler share this image; the entrypoint (`prod.sh` / `prod-worker.sh` / `prod-worker-cpu.sh` / `prod-scheduler.sh`) selects the role. The API runs under the custom asyncio uvicorn worker. |
| *agent* | `echo/agent/Dockerfile` | The standalone agent service (`:8001`). Separate dep stack from the server (that's why it's its own service). |
| *directus* | `echo/directus/Dockerfile` | The Directus deployment plus the `directus-sync` tooling. |
| *usage-tracker* | `echo/tools/usage-tracker/Dockerfile` | Operational usage tooling. |

The frontend isn't a container in this flow - it deploys via Vercel.

> [!IMPORTANT]
> The agent has historically been easy to miss in the prod build matrix (it was once only built
> by the testing pipeline, causing an `ImagePullBackOff` in prod). When you change CI image
> builds, confirm *agent* is in the production matrix, not just testing.

## Database migrations

Schema lives in Directus and is managed with `directus-sync`. The ritual
(`echo/docs/database_migrations.md`):

1. `cd echo/directus`
2. Run `./sync.sh` and choose *push* (option 1) to apply the schema snapshot.
3. Run any required raw SQL on the database (`psql -h postgres -p 5432 -U dembrane`; default dev password `dembrane`), e.g. `CREATE EXTENSION vector;` for pgvector.

Some changes are *two-step and order-sensitive* - deploy the code first, then run the SQL.
The membership unique indexes (one active membership per user per org/workspace), which the
invite-race fix in `api/v2/_invite_helpers.py` depends on, are the canonical example: deploy the
API change, *then* create the partial unique indexes. If index creation fails on a duplicate
key, dedupe the active rows first, then re-run.

> [!WARNING]
> Pushing schema to prod has a known pitfall: a `directus-sync` push can 500 with "drop index
> does not exist" if the snapshot disagrees with reality (the `is_indexed` pitfall). Reconcile
> the snapshot before pushing, and test the push against staging first. When in doubt, follow
> `echo/docs/database_migrations.md` exactly rather than improvising the SQL.

## Where the rules live

- `echo/docs/branching_and_releases.md` - the authoritative branch/release/hotfix process.
- `echo/docs/database_migrations.md` - the migration ritual and the index recipes.
- `echo/docs/adr/` - the ADRs (0001–0005) that explain why the data and billing model look the way they do; relevant when a release touches roles, seats, tiers or invites. See [roles & policies in code](./roles-and-policies.md).

---

*Related*

- [Architecture](./architecture.md)
- [Local development](./local-development.md)
- [The data model](./data-model.md)
- [Background jobs & scheduler](./background-jobs-and-scheduler.md)
- [Self-hosting (external)](../developer-external/self-hosting.md)
