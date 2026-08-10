# Production incidents

Short write-ups of production failures whose cause was not obvious from reading the
code. Each page leads with the rule, then explains the mechanism precisely, what the
fix was, and how to avoid a repeat.

These are engineering notes, not reports. No severities, no timelines, no blame. Where
timing matters, use `git log` / `git blame` on the commits cited rather than trusting a
date written here.

## When to add a page here

Add one when a failure meets both tests:

- the cause would surprise a competent reader of the code, and
- the preventing rule is not already stated somewhere a person would look

If the rule already lives in an `AGENTS.md`, link to that rule from here and link back
from the rule. Do not restate it in two places.

## Index

| Incident | Rule in one line |
| --- | --- |
| [gitops-env-removal-release-gate.md](gitops-env-removal-release-gate.md) | Never remove config from gitops before the code that reads it has shipped to a production release tag. |
| [argo-self-heal-reverts-manual-changes.md](argo-self-heal-reverts-manual-changes.md) | Never `kubectl scale` or `kubectl patch` production. Argo reverts it. Change capacity in gitops values. |
| [directus-sync-is-indexed.md](directus-sync-is-indexed.md) | A snapshot field with `is_indexed: false` over a live column indexed under a different name aborts the whole `schema/apply` on production. |
| [agent-missing-from-build-matrix.md](agent-missing-from-build-matrix.md) | Every deployment referencing an image tag needs a build-matrix entry that produces that tag. Nothing else notices when one does not. |
| [dramatiq-actor-event-loops.md](dramatiq-actor-event-loops.md) | Never create and close an event loop per call inside a worker. Go through `run_async_in_new_loop`, which owns one long-lived loop. |
| [validate-execution-not-construction.md](validate-execution-not-construction.md) | A dependency migration is validated by running the real path end to end, never by confirming imports and constructors work. |

## Related

- [../branching_and_releases.md](../branching_and_releases.md): environments, release tags, gitops
- [../database_migrations.md](../database_migrations.md): Directus schema and data migrations
- `../../AGENTS.md`: the cross-cutting rules these incidents produced
- `../../echo-gitops/AGENTS.md`: infrastructure notes, human-notes zone at the bottom
