# Onboarding

After their first login, a new person names their organisation, can invite teammates, answers an optional question about themselves, and lands on "Create project" in their new organisation's default workspace.

## Sub-features

- `onboarding-org` names and creates the organisation.
- `onboarding-invite` sends invites or skips them.
- `onboarding-about` answers or skips the "Almost ready" question.
- `onboarding-done` lands on `/w/<workspace-id>/projects/new` with the organisation in the breadcrumb.

## How to get to it (user POV)

- The first login of a new account goes straight to `/onboarding`.

## Driving it with agent-browser

Preconditions:

- Signed in as a verified account that hasn't onboarded, on "Welcome, <first name>": either the end of [auth.md](./auth.md), or `scripts/seed-user.sh` (no `--org`) and the login batch in auth.md.

- **Name the organisation.** `find label "Organisation name" fill "Verify Org"`, then `find role button click --name "Get started"`. The heading becomes "Invite your team".
- **Skip invites.** `find role button click --name "Skip"`. The heading becomes "Almost ready", with radios "Yes" and "No" and a disabled "Continue".
- **Skip the question.** `find role button click --name "Skip"`. The URL becomes `…/en-US/w/<workspace-id>/projects/new`, the heading reads "Create project", and the breadcrumb shows "Home › Verify Org › Default".
- **Proof.** Screenshot the "Create project" page. `psql "$DB_URL" -Atc "select name from org"` prints `Verify Org`, and `select count(*) from workspace` prints `1`.

## Gotchas

- "Send invites" stays disabled until an address is entered. Sending real invites queues emails that are only kept in memory locally.
- The two "Skip" buttons are on different steps; snapshot between them so you click the one on the current step.
- An account that finished the organisation step but not "About you" goes back to "About you" on every login.
