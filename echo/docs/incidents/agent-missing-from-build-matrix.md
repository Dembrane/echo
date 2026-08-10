# echo-agent was never built for production

**Rule: every deployment that references an image tag needs a matching entry in the
`ci.yml` build matrix that actually produces that tag. Nothing in the pipeline notices
when one is missing, and an internal ClusterIP service can stay broken indefinitely
without a single external symptom.**

## What happened

The `echo-agent` deployment in the `echo-prod` namespace sat in `ImagePullBackOff` for
weeks with no ready pods and therefore no service endpoints. The agentic chat backend
was unavailable in production for the entire period.

## Mechanism

Two workflows build images, and they tag differently:

- `.github/workflows/deploy-testing.yml` built `dbr-echo-agent`, tagging it with a
  short 7-character SHA plus `testing`
- `.github/workflows/ci.yml`, job `ci-build-and-push-servers`, built only
  `dbr-echo-directus` and `dbr-echo-server`, tagged with the full 40-character
  `github.sha`

Production and Echo Next both deploy by full commit SHA, so their agent deployments
requested `dbr-echo-agent:<full-sha>`. That tag was never produced by anything, because
the only workflow that built the agent used the short form on a different branch. The
registry's newest agent tags were `testing` and a short SHA, both stale.

Nothing failed loudly:

- CI was green. It builds the images in its matrix and has no knowledge of what the
  Helm chart references.
- Argo reported the application synced. The manifests matched git exactly; the
  container simply could not pull.
- The service is `ClusterIP` on port 8001 and is not on any ingress. Production ingress
  exposes only `directus.dembrane.com` and `api.dembrane.com`, and the dashboard and
  portal front ends are on Vercel. So every external health check stayed green.

The gap between "declared in the chart" and "produced by CI" had no owner, and the one
component affected happened to be invisible from outside the cluster.

## Fix

`dbr-echo-agent` was added to the `ci.yml` matrix in
`feat(agentic): foundation slices — agent image on main, v2 authz, design doc`
(d9e245cf, PR #745). It is present today, with the reason recorded inline so the entry
does not get pruned as redundant:

```yaml
# Agent service. Also built by deploy-testing.yml for the testing
# env; without this entry no main-SHA agent tag ever exists, so the
# echo-next and prod agent deployments ImagePullBackOff.
- name: dbr-echo-agent
  # Repo-root context: the image bakes docs/ as the agent's
  # read-only knowledge corpus.
  context: .
  dockerfile: echo/agent/Dockerfile
  tag: dbr-echo-agent
```

The build context is the repository root, not `echo/agent/`, because the image bakes
the docs corpus in as the agent's read-only knowledge base.

Production only picks this up on a release tag, so the deployment stays broken until a
release containing d9e245cf goes out.

## Preventing a repeat

- When adding a service to `helm/echo/`, add its image to the `ci.yml` matrix in the
  same change. The chart reference and the build entry are one unit.
- When adding an image to `deploy-testing.yml`, check whether `ci.yml` needs it too.
  The two workflows serve different environments and neither implies the other.
- For an internal service with no ingress, add a check that fails visibly. Green
  external probes prove nothing about a `ClusterIP` workload.

A quick audit at any time:

```bash
# image repositories the chart references
grep -rn "repository:" echo-gitops/helm/echo/values.yaml
# images CI actually builds
grep -n "tag: dbr-" .github/workflows/ci.yml
# what exists in the registry
doctl registry repository list-tags dbr-echo-agent
```

## See also

- [gitops-env-removal-release-gate.md](gitops-env-removal-release-gate.md): the same
  code-versus-config skew, from the other direction
- [../agentic-chat-design.md](../agentic-chat-design.md)
