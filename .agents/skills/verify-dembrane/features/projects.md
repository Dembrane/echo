# Create a project

A host creates a project in a workspace, starting from uploaded files, pasted text, a link, or one of the conversation formats. A new project lands on its home page, with the portal link and QR code participants use.

## Sub-features

- `project-from-format` starts a project from a format card such as "Table conversations". Proven on a fresh run.
- `project-from-files` starts from files dropped or chosen in "Drop files or choose them". Not yet driven.
- `project-from-text` starts from "Paste text". Not yet driven.
- `project-from-link` starts from "Add a link". Not yet driven.

## How to get to it (user POV)

- The end of onboarding lands on "Create project".
- From the home page (`/o`): the organisation's sidebar link ("Verify Org"), its workspace "Default", then "Create project" in the workspace sidebar.
- `/w/<workspace-id>/projects/new`.

## Driving it with agent-browser

Preconditions:

- Signed in with onboarding finished: `scripts/seed-user.sh --org "Verify Org"` and the login batch in [auth.md](./auth.md), with any "What's new" dialog closed. Or the end of [onboarding.md](./onboarding.md).

`project-from-format`, with "Table conversations":

```sh
S=.agents/skills/verify-dembrane/scripts
agent-browser --session "$SESSION" find role link click --name "Verify Org" --exact
agent-browser --session "$SESSION" find role link click --name "Default" --exact
agent-browser --session "$SESSION" find role link click --name "Create project"
agent-browser --session "$SESSION" wait --url "**/projects/new"
agent-browser --session "$SESSION" wait --fn "!document.querySelector('[class*=stageHost]')"
$S/evidence.sh step create-project-page
agent-browser --session "$SESSION" find role button click --name "Table conversations"
agent-browser --session "$SESSION" find label "Project name" fill "Verify table project"
agent-browser --session "$SESSION" find role button click --name "Create project" --exact
agent-browser --session "$SESSION" wait --url "**/projects/*/home"
$S/evidence.sh step project-created
$S/evidence.sh query "project row" "select id, name from project where name = 'Verify table project'"
```

End state: `/w/<workspace-id>/projects/<project-id>/home` with the heading "Verify table project", a "Take part" panel with "Copy link" and "Download QR code", and links "Overview", "Conversations" and "Portal editor". The `project` table has one row with that name, beside the "Best practices (sample)" project every new organisation gets. Keep the id for [portal.md](./portal.md): it is the path segment after `/projects/`.

The "Table conversations" form has the textboxes "Project name" and "Project context". "Create project" stays disabled until the name is filled.

## Gotchas

- Onboarding names the workspace "Default". Use `--exact` on it and on "Verify Org": the breadcrumb and the search results repeat both names.
- Use `--exact` on "Create project": the sidebar link and the submit button share the name.
- "Copy link" and the QR code point at `http://localhost:5174`, the developer's own portal, because the participant base URL is fixed locally. Never follow them. Open `$PORTAL_URL/<project-id>/start` instead. Clipboard reads are denied in agent-browser, so the copied link can't be checked either.
- Starting from files, text or a link may call an LLM through `LLM_VERTEX_PROJECT`. If `.env.local` leaves it unset, report that path as blocked rather than mocking it.
