# Removing an env var from gitops before the code ships

**Rule: config removals are release-gated. Delete the field from `settings.py`, ship
that code on a `v*.*.*` release tag, and only then remove the key from
`echo-gitops`. Leaving a stale key in gitops costs nothing.**

## What happened

On 2026-07-02 two feature-flag fields were deleted from `server/dembrane/settings.py`
on `main` (`refactor(chat): remove auto-select in favor of agentic chat`, 8d543c27).
The matching env keys were then removed from `helm/echo/values*.yaml` in the gitops
repo (`chore(env): drop removed feature flags (auto-select, DISABLE_REDACTION)`,
gitops 2da4daa / PR #30).

Production was still running release `v2.0.5` (1e0362e1), which predates the settings
change and still declared both fields. Argo synced the gitops change to production
within minutes. Every worker, the scheduler, and the new API replica set failed
pydantic settings validation at boot and crash-looped. Transcription stopped. The API
kept serving only because the previously running pods were not restarted.

Recovery was a straight revert of the gitops commit (gitops 066ff21 / PR #32); Argo
self-heal re-synced and the pods came back.

## Mechanism

Two deploy channels move at different speeds and they are easy to conflate:

| Channel | Trigger | Reaches production |
| --- | --- | --- |
| Application code | GitHub release tag on `main` | every ~2 weeks |
| Deployment config (`echo-gitops` `main`) | merge to `main` | within minutes, all clusters |

`argo/echo-prod.yaml` sets `targetRevision: main` with `syncPolicy.automated`
(`prune: true`, `selfHeal: true`), and so do the dev and testing apps. There is no
per-environment branch. A config change merged to gitops `main` therefore lands on
production against whatever release tag is currently deployed, which may be weeks
behind `main`.

When a required (no-default) field is removed from the environment, pydantic-settings
does not fall back to a default: it raises. In this case Helm still templated the env
name with an empty value, so the failure surfaced as a `bool_parsing` error on `''`
rather than a missing-field error. Either way the process cannot start, and because
workers and the scheduler restart aggressively, the whole background pipeline goes
down while the older API pods make it look partially healthy.

## Why the opposite direction is safe

Every settings class in `server/dembrane/settings.py` is configured with
`extra="ignore"`:

```python
model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)
```

An env var present in the environment but no longer declared as a field is silently
ignored. So the asymmetry is total:

- config present, code does not read it: harmless
- config absent, code requires it: crash loop

That makes "leave it in gitops until after the release" a free action, and "remove it
early" the only risky one.

## The rule in practice

1. Remove the field from `settings.py` and merge to `main`. Echo Next picks it up.
2. Cut the release tag. Confirm production is running it.
3. Only then remove the key from `helm/echo/values*.yaml` and
   `helm/echo/templates/_helpers.tpl` in gitops.

Removing from gitops straight away is fine in exactly two cases: the key only exists
in `values.yaml` / `values-testing.yaml` (dev and testing track `main` anyway), or the
field is optional-with-a-default in the image production is currently running.

When unsure, read the deployed code rather than guessing:

```bash
git show <prod-release-tag>:echo/server/dembrane/settings.py | grep -n <ENV_NAME>
```

The same gate applies to renames, which are a removal plus an addition, and to any
required key consumed by the Directus or agent deployments.

## Current state

The revert is still in place. `DISABLE_REDACTION` and
`FEATURE_FLAGS__ENABLE_CHAT_AUTO_SELECT` are set in `helm/echo/values.yaml`,
`values-testing.yaml` and `values-prod.yaml`, and templated in `_helpers.tpl`, even
though neither field exists in `settings.py` on `main` any more. That is correct and
deliberate: production still runs `v2.0.5`, which requires them. They can be dropped
from gitops once a release containing 8d543c27 is live.

## See also

- [../branching_and_releases.md](../branching_and_releases.md), "Release Process"
- [argo-self-heal-reverts-manual-changes.md](argo-self-heal-reverts-manual-changes.md)
