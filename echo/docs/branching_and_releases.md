# Branching Strategy & Release Process

## Environments

| Environment | URL | Deploys from | Notes |
|---|---|---|---|
| **Testing** | dashboard.testing.dembrane.com | `testing` branch (on push) | Shared, unprotected |
| **Echo Next** | dashboard.echo-next.dembrane.com | `main` branch (on merge) | Staging / preview |
| **Production** | dashboard.dembrane.com | GitHub release tag on `main` | Every ~2 weeks |

Each environment has dashboard, portal, and directus subpaths (e.g., `dashboard.dembrane.com`, `portal.dembrane.com`, `directus.dembrane.com`).

## Feature Development Flow

```
main ──────────────────●──────────────────●──── (auto-deploys to Echo Next)
        \             ↗ PR                |
         feat/ECHO-123 ──→ (optional)     |
                           \              |
                            testing ────→ dashboard.testing.dembrane.com
```

1. **Branch off `main`** — name your branch `feat/ECHO-xxx-description` or similar
2. **Develop** on the feature branch
3. **(Optional) Test on testing environment**:
   - Merge your feature branch into `testing` to deploy to dashboard.testing.dembrane.com
   - The `testing` branch is **unprotected** — you can push/merge directly
   - **Before merging**, check that nobody else is currently using it:
     ```bash
     git log main..testing --oneline   # any commits ahead of main?
     ```
   - If there are commits ahead, check with the team before overwriting
4. **Create a PR** from your feature branch to `main`
5. **After merge** — changes auto-deploy to Echo Next
6. **After done testing** — reset `testing` back to `main`:
   ```bash
   git checkout testing
   git reset --hard origin/main
   git push --force
   ```

## Release Process

Releases happen every ~2 weeks, aligned with Linear two-week cycles.

1. **Accumulate changes** on `main` throughout the cycle
2. **Pre-release checks**:
   - Check for new env vars (`settings.py` fields, `config.ts` exports)
   - Run Directus data migrations if needed (see [database_migrations.md](database_migrations.md))
   - Update deployment env vars in the GitOps repo if needed
3. **Tag and release** — create a GitHub release from a commit on `main`
4. The release triggers **auto-deployment to production**:
   - Backend: new image tags are picked up by the GitOps repo (`dembrane/echo-gitops`, Argo CD auto-sync)
   - Frontend: auto-deploys via Vercel

## Hotfix Process

When a critical bug is found in production and `main` has unreleased changes that shouldn't go out yet:

```
main ────────●────────●────── (has unreleased work)
             |
v1.2.0 (tag) \
               hotfix-fix-description ──→ v1.2.1 (new release, auto-deploys)
```

1. **Branch off the current release tag** (not `main`):
   ```bash
   git checkout -b hotfix-<description> v1.2.0   # use the actual release tag
   ```
2. **Make the fix** on the hotfix branch
3. **Create a new GitHub release** from the hotfix branch (e.g., `v1.2.1`)
   - This auto-deploys to production
   - Backend image tags update automatically via GitOps
   - Frontend auto-deploys via Vercel
4. **Cherry-pick the fix into `main`** so it's included in the next regular release:
   ```bash
   git checkout main
   git cherry-pick <hotfix-commit-sha>
   ```

**Why branch off the tag?** This isolates the hotfix from unreleased work on `main`. Only the fix ships to production.

## GitOps

Infrastructure and deployment configuration live in a separate repo: **`dembrane/echo-gitops`**

- Terraform for DigitalOcean infra (VPC, K8s, DB, Redis, Spaces)
- Helm charts for application workloads and monitoring
- Argo CD for GitOps sync with auto-prune and self-heal
- SealedSecrets for secret management

See that repo's README and AGENTS.md for details.

## Project Management

- **Linear** for issue tracking — tickets are `ECHO-xxx`
- **Two-week cycles/sprints** aligned with release cadence
- Cycle end = release candidate on `main` → tag → deploy to production
