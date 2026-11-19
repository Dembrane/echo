# Participant portal

A participant opens a project's portal link, enters their name, and records or types their contribution to a conversation.

## Sub-features

- `portal-start` opens `/<project-id>/start` and shows the project's start screen.
- `portal-initiate` enters a name (and tags, when the project has them) to start a conversation.
- `portal-record` records audio in pieces and sends them.
- `portal-finish` finishes the conversation and shows the finish screen.

## How to get to it (user POV)

- The project's portal link or QR code from the dashboard.
- `$PORTAL_URL/<project-id>/start` directly; `$PORTAL_URL/<project-id>` redirects there.

## Driving it with agent-browser

Preconditions:

- A project made through [projects.md](./projects.md), with its id.

Not yet run end to end. Open `$PORTAL_URL/<project-id>/start` (always the `portal.localhost` host from the env file). The first run records the steps and end state here.

## Gotchas

- Opening the portal port as `localhost` instead of `portal.localhost` shows the dashboard, not the portal.
- Recording needs a microphone. Headless Chrome has none unless launched with fake-media flags; record how the first run provides one.
