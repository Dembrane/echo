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

Launch the session as a phone with a fake microphone (the Drive section of the skill), then open `$PORTAL_URL/<project-id>/start`. Proven so far: the portal host renders at 390px wide with an iPhone user agent, and `navigator.mediaDevices.getUserMedia({audio: true})` returns "Fake Default Audio Input". The start, record and finish steps are not yet driven; the first run records them here.

## Gotchas

- Opening the portal port as `localhost` instead of `portal.localhost` shows the dashboard, not the portal.
- Recording needs a microphone. Without the `--args` fake-media flags at launch the browser has none, and `--args` is ignored by a session that is already running.
- `$PORTAL_URL/` with no project id shows "404 Not Found". That is expected, not a broken portal.
- Device emulation is Chromium, not Safari. It proves layout at phone size, not iOS behaviour.
