# Wave 6d report - echo-next post-deploy verification

Run date: 2026-07-08 Europe/Amsterdam. Target: `https://dashboard.echo-next.dembrane.com`, admin account. Evidence is in `wave6d-shots/`; primary machine-readable evidence is `wave6d-shots/wave6d-evidence.json`.

## Verdicts

0. FRESHNESS GATE: PASS.
   - API health source of truth was `https://api.echo-next.dembrane.com/api/health`: `200 {"status":"ok"}`.
   - Project overview rendered the new Methodology section. Evidence project `8a4120bf-47e0-4acb-a4fa-ce22fa016cca` showed current methodology `dembrane (default)` and framing `Figure out what this project is for, then shape reports and canvases around that goal.` Screenshot: `02-freshness-methodology.png`.

1. BEAT 1 RETEST: FAIL.
   - Fresh project: `Wave 6d Verify 1783467296852`, project id `01b0125f-691a-4827-a60a-c3c70ce64296`, setup chat `bd520af5-50b5-432b-9286-9b8e6b720075`.
   - The seeded setup run did attach stream, but it also made unexpected stop calls without a user Stop click. Captured network for run `f37a72af-6a5b-404b-a766-dd7d706958dd`:
     - `POST /agentic/runs/f37a72af-6a5b-404b-a766-dd7d706958dd/stream?after_seq=0`
     - `POST /agentic/runs/f37a72af-6a5b-404b-a766-dd7d706958dd/stream?after_seq=1`
     - `POST /agentic/runs/f37a72af-6a5b-404b-a766-dd7d706958dd/stop` -> `200`
     - later another `POST /agentic/runs/f37a72af-6a5b-404b-a766-dd7d706958dd/stop` -> `200`
   - Run API for the same run reported `latest_error_code: AGENT_CANCELLED`, `latest_error: Run cancelled by user`, no `latest_output`, and only four events.
   - The interview did not reach a goal proposal. After three Marieke answers, the composer did not return to an actionable send state before timeout. Screenshots: `05-setup-chat-seeded.png`, `06-setup-seeded-after-idle.png`, `07-marieke-answer-1.png`, `07-marieke-answer-2.png`, `07-marieke-answer-3.png`.
   - Because no goal proposal card appeared, the Apply path and project settings `interview` attribution could not be verified end-to-end.

2. BEAT 5 RETEST: FAIL / PARTIAL.
   - Retested on the existing Wave 6a project with canvas `5` (`Live Emerging Themes Wall`) because the fresh setup chat was stuck.
   - Chat turns for `Pause the wall.`, `Resume the wall.`, and `What's in my library?` all returned the composer to idle; it did not remain stuck on `Working on your answer...`.
   - The library answer mentioned the canvas/list as expected.
   - The loop status check after `Pause the wall.` did not show `Paused`; `pauseCanvasHasPaused` was false in evidence. Resume ended with an active-looking `Stays up to date` state.
   - The continuation pass did not capture `/stream` network entries for these Beat 5 turns, so the required network evidence for Beat 5 is incomplete. Screenshots: `25-beat2-chat-pause.png`, `26-beat2-canvas-paused.png`, `27-beat2-chat-resume.png`, `28-beat2-canvas-resumed.png`, `29-beat2-library-answer.png`.

3. METHODOLOGY SMOKE: PARTIAL.
   - Project overview selector rendered `dembrane (default)` and framing. Screenshot: `30-methodology-project-select.png`.
   - Workspace General tab rendered the Methodologies card and the dembrane row as built-in/read-only with no Edit button. Screenshot: `31-methodology-visible-readonly.png`.
   - I could not complete the create/edit/select-patch portion under Playwright. The modal opened in probes, but repeated scripted create attempts lost access to the Framing field or modal focus before save. Treat the create/edit workflow as not verified in this pass, not as a confirmed product failure.

4. GENERATION QUALITY: FAIL / INCONCLUSIVE.
   - I refreshed canvas `5` on project `ed606b2f-8d84-45b5-9e6a-efb51e9cb7b6`, which has real uploaded material from Wave 6a. Screenshots: `34-quality-before-refresh.png`, `35-quality-refresh-clicked.png`, `36-quality-after-refresh.png`.
   - No new generation id appeared within the polling window after the refresh click. The latest stored generation in the API response remained `12aa8e7e-d8d9-4f3c-bd5e-cbf873890e9c`, status `error`, `tick_kind: scheduled`, with empty `content_html`.
   - Because no new successful stored generation was produced, I could not validate the new stored-generation rules against post-fix output. The empty/error latest generation has no HTML comments, no `canvas-shell` restyle, no cadence copy, and no assistant footer, but that is not meaningful quality evidence because there is no generated HTML.

## Artifacts

- Evidence JSON: `echo/docs/plans/smart-loop-briefs/wave6d-shots/wave6d-evidence.json`
- Screenshots: `echo/docs/plans/smart-loop-briefs/wave6d-shots/`

## Notes

- No code changes were made.
- No git write commands were run.
- The strongest regression evidence is Beat 1: the seeded setup run still issued `/stop` calls and ended as `AGENT_CANCELLED`, matching the original failure class.
