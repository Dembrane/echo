# Participant portal

A participant opens a project's portal link on their phone, steps through a short tutorial, names their table, records the conversation in pieces, and finishes. The host's project gains a finished conversation with its audio.

## Sub-features

- `portal-start` opens `/<project-id>/start`: "Welcome to dembrane!" and a "Let's go!" button.
- `portal-tutorial` steps through the intro, privacy and setup screens.
- `portal-initiate` names the table (and adds tags, when the project has them) and creates the conversation.
- `portal-record` records audio, uploaded as chunks about every 30 seconds.
- `portal-finish` stops, finishes, skips the "Before you finish" check, and shows the thank-you screen.

All five proven on a fresh run with a "Table conversations" project.

## How to get to it (user POV)

- The project's portal link or QR code from the dashboard.
- `$PORTAL_URL/<project-id>/start` directly; `$PORTAL_URL/<project-id>` redirects there.

## Driving it with agent-browser

Preconditions:

- A project made through [projects.md](./projects.md), with its id in `$PROJECT`.
- The session launched as a phone with a fake microphone (the skill's Drive section). Close it first if it ran a dashboard recipe.

```sh
S=.agents/skills/verify-dembrane/scripts
agent-browser --session "$SESSION" close
agent-browser --session "$SESSION" --args "--use-fake-device-for-media-stream,--use-fake-ui-for-media-stream" open "$PORTAL_URL/$PROJECT/start"
agent-browser --session "$SESSION" set device "iPhone 14"
agent-browser --session "$SESSION" reload
agent-browser --session "$SESSION" wait --text "Let's go!"
agent-browser --session "$SESSION" wait --fn "!document.querySelector('[class*=stageHost]')"
agent-browser --session "$SESSION" find role button click --name "Let's go!"
```

The tutorial is one screen per heading, each with "Back" and one forward button. Press the forward button on each, in this order:

| Heading | Forward button |
|---|---|
| What is dembrane? | Tell me more |
| Just speak your mind | Continue |
| Solo or in a Group | Continue |
| Question time | Got it |
| Privacy matters | Tell me more |
| Data controller, usage and security. | I understand |
| Reduce background noise | Noted |
| Strong internet connection | Ready! |
| Don't lock your device! | Okay |

`find role button click --name "<button>" --exact` for each, with `wait 1000` between them. Then:

```sh
$S/evidence.sh step portal-ready-to-begin          # "Ready to begin?"
agent-browser --session "$SESSION" find label "Table name or number" fill "Table 7"
agent-browser --session "$SESSION" find role button click --name "Continue" --exact
agent-browser --session "$SESSION" wait --url "**/conversation/*"
agent-browser --session "$SESSION" wait --fn "!document.querySelector('[class*=stageHost]')"
agent-browser --session "$SESSION" eval "document.querySelectorAll('[data-react-grab]').forEach(e=>e.remove())"
agent-browser --session "$SESSION" find role button click --name "Record" --exact
agent-browser --session "$SESSION" wait 65000                 # two full chunks and part of a third
agent-browser --session "$SESSION" find role button click --name "Stop" --exact      # "Recording paused"
agent-browser --session "$SESSION" find role button click --name "Finish" --exact    # "Before you finish"
agent-browser --session "$SESSION" find role button click --name "Skip" --exact
agent-browser --session "$SESSION" wait --url "**/finish"
$S/evidence.sh step portal-finished
$S/evidence.sh query "portal conversation and its chunks" "select c.participant_name, c.source, c.is_finished, count(k.id), sum(k.audio_seconds) from conversation c left join conversation_chunk k on k.conversation_id = c.id where c.project_id = '$PROJECT' group by c.id"
ls -R "$STATE/audio"
```

End state:

- The portal shows "Thank you for participating!" at `/<locale>/<project-id>/conversation/<conversation-id>/finish`, with "Show QR code" and "Record another conversation".
- The query returns `Table 7|PORTAL_AUDIO|t|<chunks>|<seconds>`: one chunk per ~30 s recorded, plus the partial one sent at Stop.
- `$STATE/audio/conversation/<conversation-id>/chunks/` holds a `.webm` and an `.mp3` per chunk.

While recording, the record screen shows "ECHO" and "Stop" in place of "Record". "Recording paused" offers "Resume", "Finish" and "Switch to text input". "Before you finish" offers "Verify", which asks an LLM to summarise, and "Skip".

## Gotchas

- Opening the portal port as `localhost` instead of `portal.localhost` shows the dashboard, not the portal.
- Recording needs a microphone. Without the `--args` fake-media flags at launch the browser has none, and `--args` is ignored by a session that is already running.
- React Grab, the dev-only inspector (`dembrane/frontend/index.html`, `import.meta.env.DEV` only), puts its toolbar bottom-centre. At phone width it sits over the sticky "Record" button, and the click fails with "covered by <div>". Remove its host as above; production builds don't load it.
- The worker transcribes each chunk with the model `.env.local` configures, so a run with Vertex credentials makes real, billed model calls. The fake microphone plays a tone, not speech: expect `[Nothing to transcribe]`, and sometimes invented text. Transcript content proves nothing here; the chunk rows and files do.
- The verification seed adds about 50 sample conversations to other projects. Always filter conversation queries by `project_id`.
- `$PORTAL_URL/` with no project id shows "404 Not Found". That is expected, not a broken portal.
- Device emulation is Chromium, not Safari. It proves layout at phone size, not iOS behaviour (wake lock, the iOS 16 floor).
