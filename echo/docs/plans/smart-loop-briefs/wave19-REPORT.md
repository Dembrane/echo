# Wave 19 Verify Report - echo-next owner-feedback arc

Run time: 2026-07-08 09:41-09:58 UTC.

Target: `https://dashboard.echo-next.dembrane.com`, user `admin@dembrane.com`.
API health: `GET https://api.echo-next.dembrane.com/api/health` returned `200 {"status":"ok"}`.

Screenshots and machine evidence: `echo/docs/plans/smart-loop-briefs/wave19-shots/`.

## Summary

Overall: **FAIL**. The wave-14 persisted-chat regression is fixed, echo-next portal URL grounding is fixed, the invite-link Vertex stall is fixed, the canvas page polish is live, the insight pipeline works, and the wizard toggle placement/landing behavior is live. The full 2026-07-08 owner-feedback arc is not fully verified live because navigation suggestion cards did not render for the portal/invite-link replies, the canvas update applied state did not re-render as a card after chat reload, the live iframe still showed the old generated wording immediately after applying, and worker health showed a duplicate cadence-window run row.

One-line owner-feedback answer: **No, the whole 2026-07-08 owner-feedback arc is not fully verified live.**

## Beat Results

### 0. Freshness gate - PASS

- Existing canvas opened: `Street Feedback Dashboard`, project `41ed3b10-b912-4859-8ec9-a33c38d4a213`, report/canvas `8`.
- Iframe attributes passed: one iframe with `aria-label="Canvas preview"` and `title=null`.
- Create-project wizard Name step contains `Set up with the assistant after creating`.
- Health check returned 200.
- Evidence: `01-canvas-page.png`, `02-canvas-iframe.png`, `21-wizard-name-step-toggle-off-final.png`.

### 1. Regression retest - PARTIAL FAIL

- 1a persisted history: **PASS**. In a fresh browser context with localStorage cleared, chat `d6cad155-d725-4058-917a-0432ba2d4fe1` rendered the persisted user prompt and assistant reply, not the empty Ask state. Evidence: `08-persisted-chat-clean-localstorage.png`, `wave19-chat-rerun.json`.
- 1b portal link: **FAIL on navigation card**. A new chat rendered an anchor href of `https://portal.echo-next.dembrane.com/en/41ed3b10-b912-4859-8ec9-a33c38d4a213/start` and did not render `portal.dembrane.com`, but `agentic-navigation-suggestion` count was 0 so there was no take-me-there card to click. Evidence: `09-portal-chat-reopened-anchors.png`.
- 1c invite link: **FAIL on navigation card, PASS on stall**. The chat produced a persisted assistant reply with the echo-next portal URL and was no longer stuck in the working state, but `agentic-navigation-suggestion` count was 0 and the reply asked whether the host wanted a navigation card instead of rendering one. Evidence: `10-invite-chat-reopened-final.png`.
- 1d canvas update: **FAIL on reload-card persistence**. The update card rendered and Apply produced `I applied the canvas.`, but after reloading the chat there were 0 applied-card and 0 active-card nodes; only the plain messages persisted. The canvas route also still showed `2 interviews uploaded` immediately after reload. No duplicate canvas was created. Evidence: `16-canvas-update-card-or-reply.png`, `17-canvas-update-applied-chat.png`, `18-canvas-update-after-reload.png`, `26-canvas-update-chat-reload-applied.png`, `wave19-canvas-update.json`, `wave19-canvas-update-reload.json`.

### 2. Canvas page - PASS

- Dembrane brand is at the top of the iframe content via `.dembrane-canvas-brand`; iframe body has `overflowY: visible`, body/client heights match closely, and there was no inner scrollbar or long empty tail.
- Freshness copy was coherent: `Checked ... Nothing new since your last conversation. Updated ...`; it did not form a half sentence.
- The edit affordance sits next to the freshness indicator as `canvas-freshness-settings-button`.
- Saving the freshness popover worked: UI moved from `Stays up to date until tomorrow 10:58` to `Stays up to date until tomorrow 11:52`, and Directus confirms `agent_loop.expires_at = 2026-07-09T09:52:48.729Z`.
- Fullscreen is visible as `canvas-fullscreen-button`.
- There is exactly one breadcrumb trail ending `Library > Street Feedback Dashboard`.
- Evidence: `01-canvas-page.png`, `02-canvas-iframe.png`, `12-freshness-popover-open.png`, `13-freshness-after-save.png`, `wave19-directus-final.json`.

### 3. Insights pipeline - PASS

- Prompted in a project chat: `I wish the canvas could email me a weekly summary every Monday morning.`
- Agent reply contained one quiet "noted this request for the dembrane team" style line and did not narrate internal logging.
- Directus `agent_insight` row `2e3fad78-ecaf-4a9e-bcb3-1e26cff10c74` exists with `kind=wish`, plain-words content, `project_id=41ed3b10-b912-4859-8ec9-a33c38d4a213`, `workspace_id=863463ac-62ab-4a4a-908b-401996b890de`, and `chat_id=4b04cac2-f5bb-4436-b957-befc21a86bff`.
- Row content is summarized product language, not a transcript verbatim: `The host wants the canvas feature to support an automated weekly email summary sent every Monday morning.`
- Evidence: `20-insight-wish-reply.png`, `wave19-insight.json`, `wave19-directus-final.json`.

### 4. Wizard - PASS

- Name step showed Project name, Description, and the `Set up with the assistant after creating` switch.
- Access step did not show the setup switch.
- With the switch off, Review showed `Setup: Go to project home`, not `Start in assistant chat`.
- Created `Wave19 Toggle Off 1783504620140`; the app landed on `/projects/6ab5d96d-8a66-43e6-ba0b-318aa1871844/home`.
- Evidence: `21-wizard-name-step-toggle-off-final.png`, `22-wizard-access-no-toggle-final.png`, `23-wizard-review-home-final.png`, `24-wizard-created-home-final.png`, `wave19-wizard.json`.

### 5. Worker health - FAIL

- Loop is active: `agent_loop.id=5f6ad6a6-2844-4698-ac97-9b0293487ca3`, `cadence_minutes=5`, `status=active`.
- Last 6 `agent_loop_run` rows:
  - `2026-07-08T09:54:00.447Z` - `no_op` - `Duplicate tick for cadence window`
  - `2026-07-08T09:53:00.340Z` - `no_op` - `No new gathered content since latest generation`
  - `2026-07-08T09:49:00.871Z` - `no_op` - `No new gathered content since latest generation`
  - `2026-07-08T09:43:00.824Z` - `no_op` - `No new gathered content since latest generation`
  - `2026-07-08T09:37:00.671Z` - `no_op` - `No new gathered content since latest generation`
  - `2026-07-08T09:30:06.210Z` - `no_op` - `No new gathered content since latest generation`
- The loop is still ticking, but the latest six include a duplicate cadence-window row, so the strict "one per window, no duplicate bursts" requirement does not pass.
- Evidence: `wave19-directus-final.json`.

## Additional Notes

- Directus shows exactly one canvas report for the Street Feedback Dashboard after applying the update: report `8`, `kind=canvas`, `status=published`; no duplicate canvas was created.
- The update application appears to change accepted configuration state/messages but did not immediately produce a new generation; the latest `canvas_generation` remains `2026-07-08T08:19:03.383Z`.
- No code changes or git writes were performed.
