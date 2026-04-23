# QA Questions for Sameer

Running list — things I need to confirm before continuing.

## Answered 2026-04-23

- **Post-onboarding landing** → `/w` (workspace home), not `/w/<id>/projects`. See [brief-01-onboarding-fixes.md](brief-01-onboarding-fixes.md) change #3.
- **Avatar initials** → should be `first[0] + last[0]` (i.e. "SS" not "SA"). See brief change #2.
- **Home-empty CTA** → a user who owns a team *should* see their team hero + "Add workspace" card on `/w`; the bare "No workspaces yet" text only renders when the user has *no* teams either. The root cause that made Sameer see the bare text was the listing-endpoint short-circuit, fixed in brief change #4.

## Open

- _(none)_
