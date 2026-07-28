# Wave 6h report - echo-next verification

Run date: 2026-07-08 Europe/Amsterdam. Target: `https://dashboard.echo-next.dembrane.com`, admin account. Evidence is in `wave6h-shots/`, primary JSON artifact `wave6h-evidence.json`.

Overall verdict: FAIL - the Marieke v1 story is not fully working on echo-next because methodology create/edit/select still fails.

## 0. Freshness

PASS.

- API health returned `200 {"status":"ok"}` from `https://api.echo-next.dembrane.com/api/health`.
- Composer redesign was live during an in-flight run: the send control text remained `Send`, one separate stop icon control was present, and the run indicator was visible.
- Screenshot: `02-freshness-run-in-flight.png`.

## 1. Beat 1 - fresh setup chat, mid-turn Send, goal apply

PASS.

- Fresh project: `Wave 6h Marieke 1783473640444`, project id `9ba6da24-0532-4259-80a4-533210244fe7`, chat id `025f4e96-9192-4bc1-95f5-85bf54f2cf19`.
- Run id: `8df3853b-a019-43d5-a5c3-06fd995aeb35`.
- Killer behavior passed: while the assistant was still working, I typed a second answer and clicked `Send`; `POST /messages` returned `200`, and network evidence shows zero `POST /stop` calls before or after the click.
- The run completed with 6 user messages, 5 assistant messages, and `goal_proposal` tool outputs at seq 148 and 189. Applying the card created project goal revision `833e3683-52e3-4227-94ce-b8aecff210b6` with `set_by: "interview"`.
- Screenshots: `03-beat1-midturn-send.png`, `04-beat1-after-midturn-answered.png`, `06-beat1-after-interview.png`, `07-beat1-apply-clicked.png`, `08-beat1-project-settings.png`.

## 2. Beat 5 - canvas project chat

PASS.

- Created canvas `6` (`Wave 6h methodology wall 1783473640444`) on material project `Internal / Test` (`69b45829-5034-489c-b8dd-92230ff7f8b7`) and used that project's agentic chat `1d815c78-8111-4873-a4ff-7c6970c42e7e`.
- Run id `36fc42df-ef3d-478b-8cda-ddf5830cb96b` handled `Pause the wall.`, `Resume the wall.`, and `What's in my library?`.
- API/page evidence: after pause, canvas loop status was `paused`; after resume, status was `active`; library answer listed the canvas. Run events include `listCanvases`, `pauseCanvasLoop`, and `resumeCanvasLoop` tool start/end events.
- Screenshots: `11-beat5-1.png`, `12-canvas-after-pause.png`, `11-beat5-2.png`, `13-canvas-after-resume.png`, `11-beat5-3.png`.

## 3. Methodology create/edit/select

FAIL.

- The account did not list a workspace named `General`; available workspaces were `Test`, `Value test`, `Default`, `data`, and `Internal`, so I used `Fresh Org / Default` as the closest workspace.
- Creating `Wave 6h methodology 1783473640444` from Workspace Settings > General did not complete cleanly. The browser console captured: `Access to fetch at 'https://api.echo-next.dembrane.com/api/v2/bff/methodologies' from origin 'https://dashboard.echo-next.dembrane.com' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`
- Despite the failed browser response, rows were inserted with `latest_version: null` and `versions_count: 0`. Editing also failed with the same CORS pattern for `/api/v2/bff/methodologies/bf7054d5-7216-46ea-ad14-e061c8b989a7/versions`, and API detail still showed `versions: []`.
- Project selection could not be proven; the methodology has no latest version to select, and the targeted project settings page did not render `project-methodology-select` before timeout.
- Screenshots: `20-methodology-retry-filled.png`, `21-methodology-retry-created.png`, `31-methodology-final-edit-filled.png`, `32-methodology-final-edited.png`, `error-methodology-final.png`.

## 4. Tick self-healing and quality

PASS.

- Fresh 2h canvas `6` was created at `2026-07-08T01:26:22.490Z` with cadence 5 on project `Internal / Test`, which has real conversation material.
- A scheduled generation appeared without manual refresh at `2026-07-08T01:27:04.835Z` (about 42 seconds later): generation `51b581ac-aa54-44bf-8678-6d33aff84a2f`, `tick_kind: scheduled`, `status: ok`, `detail: null`.
- Newest generation rows had no `error` entries and no banned-copy detections in `detail`; the scheduled HTML scan found no `real-time`, standalone `AI`, `successfully`, or em dash.
- Screenshot: `13-canvas-after-resume.png`; API evidence: `wave6h-evidence.json`.

## Artifacts

- `echo/docs/plans/smart-loop-briefs/wave6h-shots/wave6h-evidence.json`
- Screenshots: `echo/docs/plans/smart-loop-briefs/wave6h-shots/`

## Notes

- No code changes were made.
- No git write commands were run.
