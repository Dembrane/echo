# Create a project

A host creates a project in a workspace, starting from uploaded files, pasted text, a link, or one of the conversation formats.

## Sub-features

- `project-from-format` starts a project from a format card such as "Table conversations".
- `project-from-files` starts from files dropped or chosen in "Drop files or choose them".
- `project-from-text` starts from "Paste text".
- `project-from-link` starts from "Add a link".

## How to get to it (user POV)

- The end of onboarding lands on "Create project".
- "Create project" in the workspace sidebar.
- `/w/<workspace-id>/projects/new`.

## Driving it with agent-browser

Preconditions:

- Signed in with onboarding finished: `scripts/seed-user.sh --org "Verify Org"` and the login batch in [auth.md](./auth.md), then "Create project" in the sidebar. Or the end of [onboarding.md](./onboarding.md).

Not yet run end to end. On the "Create project" page the entry points are a region "Drop files or choose them" with a "Choose Files" button, buttons "Paste text", "Add a link" and "More formats", and format cards in the region "Or start from a format". The first run that drives one records its steps and end state here.

## Gotchas

- Starting from files, text or a link may call an LLM through `LLM_VERTEX_PROJECT`. If `.env.local` leaves it unset, report that path as blocked rather than mocking it.
