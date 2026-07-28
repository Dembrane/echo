# Wave 6f report - echo-next final verification

Run date: 2026-07-08 Europe/Amsterdam. Target: `https://dashboard.echo-next.dembrane.com`, admin account. Evidence is in `wave6f-shots/`; primary JSON artifacts are `wave6f-target-evidence.json`, `wave6f-evidence.json`, and `wave6f-run-23b48.json`.

Overall verdict: FAIL - the Marieke v1 story is not fully working on echo-next.

## 0. Freshness

PASS.

- API health returned `200 {"status":"ok"}`.
- Workspace General > Methodologies rendered the 6e test IDs: `methodology-new-button`, `methodology-new-modal`, `methodology-new-form`, `methodology-new-name`, `methodology-new-description`, `methodology-new-framing`, `methodology-new-save`, and `methodology-new-cancel`.
- Screenshots: `02-freshness-methodology-testids.png`, `03-freshness-new-modal-testids.png`.

## 1. Beat 1 - fresh setup chat, no accidental stop, goal apply

FAIL.

- Fresh project created: `Wave 6f Target 1783470963231`, project id `cb7e5c5a-f84b-4491-9d58-9f06a927839a`.
- Setup run id: `23b48e3a-2fc9-411f-b0c6-0ba0fee4d1db`.
- Network showed stream attach, but also unexpected stop calls without a Stop click:
  - `POST /agentic/runs/23b48e3a-2fc9-411f-b0c6-0ba0fee4d1db/stream?after_seq=0`
  - `POST /agentic/runs/23b48e3a-2fc9-411f-b0c6-0ba0fee4d1db/stop`
  - later another `POST /agentic/runs/23b48e3a-2fc9-411f-b0c6-0ba0fee4d1db/stop`
- Run API later reported `status: completed`, but retained `latest_error: Run cancelled by user`; events include two early `run.failed` entries followed by later model/tool events.
- After three Marieke answers, the UI showed a project-update suggestion card, not the required goal proposal card. Project goal API returned `current: null`, `revisions: []`, so Apply and `interview` attribution could not be verified.
- Screenshots: `27-target-create-name.png`, `28-target-create-review.png`, `29-target-setup-chat-new.png`, `30-target-setup-after-wait.png`, `31-target-marieke-1.png`, `31-target-marieke-2.png`, `31-target-marieke-3.png`.

## 2. Beat 5 - pause/resume/library by chat

FAIL.

- Retested on Wave 6a project `ed606b2f-8d84-45b5-9e6a-efb51e9cb7b6`, canvas `5` (`Live Emerging Themes Wall`).
- The Ask home created chat rows for `Pause the wall.`, `Resume the wall.`, and `What's in my library?`, but no Beat 5 `/agentic/runs/.../stream` run ids were captured.
- Canvas API stayed `loop.status: active` after the pause request and again after resume; there is no API evidence of pause tool execution.
- Library turn text/UI mentioned the library/canvas, but because no run id or tool events were captured, this is not sufficient to pass the required API evidence check.
- Screenshots: `32-target-beat5-pause.png`, `33-target-beat5-resume.png`, `34-target-beat5-library.png`.

## 3. Methodology create/edit/select

FAIL / PARTIAL.

- Freshness proved the new create modal test IDs are present.
- Existing dembrane methodology row was read-only: API row `0b211748-2ca8-413a-81db-d2ab65d53582` had `is_seeded: true`, and `methodology-edit-0b211748-2ca8-413a-81db-d2ab65d53582` count was `0`.
- The create/edit flow did not complete. During the targeted UI pass, Workspace General failed into the app error boundary (`Something went wrong`) while automating the methodology modal; no methodology was created, edited, or selected into the project.
- Screenshot: `39-target-methodology-error.png`.

## 4. Generation health

FAIL / PARTIAL.

- Directus `canvas_generation` latest scheduled rows still included the previous scheduled error `12aa8e7e-d8d9-4f3c-bd5e-cbf873890e9c`, `status: error`, detail `Attempted to exit cancel scope in a different task than it was entered in`, created `2026-07-07T23:10:05.213Z`.
- Manual `Refresh now` on canvas `5` returned `202` and produced fresh generation `25cae64e-29d8-4729-b645-01cea8b99ba0`, `status: ok`, `tick_kind: manual`, created `2026-07-08T00:39:11.640Z`.
- Fresh manual HTML had no HTML comments and no `.canvas-shell { ... }` restyle, but it still contained cadence/live-copy wording such as `Live Wall` and `Real-time reflections`, so the quality check is not clean.
- Screenshots: `40-target-generation-before.png`, `41-target-generation-clicked.png`, `42-target-generation-after.png`.

## Artifacts

- `echo/docs/plans/smart-loop-briefs/wave6f-shots/wave6f-target-evidence.json`
- `echo/docs/plans/smart-loop-briefs/wave6f-shots/wave6f-evidence.json`
- `echo/docs/plans/smart-loop-briefs/wave6f-shots/wave6f-run-23b48.json`
- Screenshots: `echo/docs/plans/smart-loop-briefs/wave6f-shots/`

## Notes

- No code changes were made.
- No git write commands were run.
