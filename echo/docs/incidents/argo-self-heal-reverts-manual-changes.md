# Manual kubectl changes to production get reverted

**Rule: never `kubectl scale` or `kubectl patch` a production workload. Argo CD
self-heal reverts it to the git-declared state within minutes. Capacity changes go
through `helm/echo/values-prod.yaml` in `echo-gitops`.**

## What happened

During a transcription backlog, `kubectl scale deploy echo-worker-cpu --replicas=10`
was run against the production cluster. Argo reset the deployment to its declared
replica count on the next sync. Nothing about the backlog changed, and the time spent
looked like progress while producing none.

## Mechanism

`argo/echo-prod.yaml` declares:

```yaml
syncPolicy:
  automated:
    prune: true
    selfHeal: true
```

`selfHeal` means Argo continuously compares live cluster state against the rendered
manifests from gitops `main` and reconciles any difference it finds, whatever produced
it. A hand-edited replica count or resource limit is drift, so it is undone. `prune`
means a live object with no manifest behind it is deleted outright.

The behaviour differs by resource:

- deployments without an HPA (Neo4j, for example) have their `spec.replicas` reverted
  hard
- deployments with an HPA are managed by the autoscaler within the bounds declared in
  gitops, so a manual scale is either overwritten by Argo or immediately re-evaluated
  by the HPA, and in both cases the bounds in git win

## What to do instead

Change the declaration and let Argo apply it:

1. Edit replicas, resources, or HPA bounds in `helm/echo/values-prod.yaml` (or the
   relevant template under `helm/echo/templates/`).
2. Commit to gitops `main`, push, and watch the sync.

Note the ceiling before assuming a replica bump helps: the production node pool sits
at its Terraform limit, so raising replicas past available capacity yields `Pending`
pods with `FailedScheduling: Insufficient cpu/memory`. Real headroom comes from
Terraform (a larger pool) or from reclaiming capacity by removing an unused workload
through gitops.

## What is still fine by hand

Self-heal only reconciles declared object state, so diagnosis is unaffected:

- read-only `kubectl get` / `describe` / `logs`
- `kubectl exec` into a running pod, including a one-off enqueue or a backfill script
- `kubectl port-forward` for Loki or Grafana

Deleting a pod is also fine when the intent is a restart: the replica set recreates it
and the declared state never changed.

## See also

- [gitops-env-removal-release-gate.md](gitops-env-removal-release-gate.md): the other
  half of the same fact, that gitops `main` is production
- `echo-gitops/AGENTS.md`, recipe "Tune worker CPU scaling"
