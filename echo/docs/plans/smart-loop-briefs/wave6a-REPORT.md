# Wave 6a report - echo-next Marieke flow

Run date: 2026-07-08 Europe/Amsterdam. Target: `https://dashboard.echo-next.dembrane.com`, admin account, workspace `Fresh Org / Test`, project `Wave 6a Marieke 1783463585777` (`ed606b2f-8d84-45b5-9e6a-efb51e9cb7b6`). Evidence is in `wave6-shots/`; JSON traces are `wave6-playwright-evidence.json`, `wave6-canvas-chat-evidence.json`, `wave6-canvas-lifecycle-evidence.json`, and `wave6-chat-lifecycle-evidence.json`.

## Headline verdicts

- LIVE agent `proposeCanvas`: PASS. A real agentic run completed and called `proposeCanvas`, producing the `Live Emerging Themes Wall` proposal card. Try it rendered a real preview, Apply created canvas `5`, and Open in Library navigated to `/canvases/5`. Screenshots: `08b-canvas-proposal-live-agent.png`, `09b-canvas-preview.png`, `10b-canvas-applied.png`, `11b-canvas-open.png`.
- Scheduled tick: PASS with nuance. The first scheduled worker run fired on echo-next and created generation `0cb7789d-726d-4d83-848a-d87cc33ac827` at `2026-07-07T22:44:05Z`, before manual refresh. Manual refresh then created `cb283f8f-4626-48cd-ae03-d0d2182ba95c`; the version strip showed two `00:44` entries. One later cadence fired twice but recorded `no_op` because no new gathered content existed, so no third empty-data version was added.

## Beat results

1. Project creation and setup chat: PARTIAL FAIL.
   - Created project through the UI and landed in the setup Ask chat with seeded message `Help me figure out what this project is for.` Screenshots: `02-create-project-name.png` through `05-setup-chat-seeded.png`.
   - The setup agent run failed immediately with `AGENT_CANCELLED`; no interview response or goal proposal appeared. Backend run: `d7eafeb2-6707-4f25-8506-fec345ea18ff`, status `failed`, latest_error `Run cancelled by user`.
   - Because no goal card appeared, there was no project-settings goal attribution to verify. Recommendation: debug the project-creation seed path separately from normal new-chat runs.

2. Empty-project live wall request: PASS.
   - Fresh chat prompt produced a live `proposeCanvas` card from completed run `17c0461c-96d9-4029-8a82-dd8c1befab2d`.
   - Preview rendered an honest empty wall. Apply created canvas `5`; Open in Library worked.
   - Copy issue found: the agent reply exposed cadence copy, `every 5 minutes` and `next 5-minute rhythm`, even though the v1 plan says hosts should not see interval language up front.

3. Library, refresh, schedule, pause/resume: PASS with no-op nuance.
   - Canvas opened from Library and showed loop status `Stays up to date until 02:43 today`, `Pause`, `Refresh now`, and a version strip. Screenshots: `12-canvas-before-manual-refresh.png`, `13-canvas-after-manual-refresh.png`.
   - Scheduled run created the first generation before manual refresh. Manual refresh created the second generation.
   - Later cadence runs at `22:50:01Z` and `22:50:05Z` were recorded as `no_op` with detail `No new gathered content since latest generation`.
   - Pause button changed the loop to `Paused`; after waiting more than one cadence, no new generations appeared. Resume button returned the loop to active. Screenshots: `15-canvas-paused.png`, `16-canvas-after-pause-wait.png`, `17-canvas-resumed.png`.

4. Real material upload and generation judgement: PASS, with generation-quality fixes pending deploy.
   - Uploaded two text conversations through the same public participant API path used by UI uploads; both initiate/upload/finish calls returned `200`. Screenshot: `18-uploaded-text-conversations.png`.
   - Refresh after upload created generation `2ea5dd0d-f5a2-434c-b975-ada734632c38`; the version strip showed `00:57`, `00:44`, `00:44`. Screenshot: `19-canvas-with-real-material.png`.
   - Judgement vs `echo/server/dembrane/canvas/skill.md`: meaningful content, grounded in uploaded material, and useful theme grouping. Problems: the generated HTML restyled `canvas-shell`, included HTML comments, used em-dash quote attribution, said `real-time`, exposed a raw project ID footer, and showed `dembrane assistant`. Those violate the skill or brand voice.

Sample from the generated HTML:

```html
<div class="canvas-shell">
  <!-- Style overrides for specific layout adjustments -->
  <style>
    .canvas-shell {
      padding: 2rem;
      max-width: 1200px;
      margin: 0 auto;
    }
    .pulse-indicator {
      display: inline-block;
      width: 8px;
      height: 8px;
      background-color: var(--canvas-blue, #0066cc);
      border-radius: 50%;
      margin-right: 8px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 0.4; }
      50% { opacity: 1; }
      100% { opacity: 0.4; }
    }
    .theme-card {
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .quote-container {
      border-left: 2px solid rgba(0, 102, 204, 0.2);
```

5. Lifecycle by chat: FAIL.
   - Asking `Pause the wall.` created a new agentic run `c75c6cd8-adc7-4176-9ab7-d94a743daa33`, but it stayed `running` with only the `user.message` event persisted. Loop status remained `active`.
   - Sending `Resume the wall.` left the composer in `Working on your answer...`; the later `What's in my Library?` prompt could not be sent because the send button never returned. Screenshots: `20-chat-lifecycle-start.png`, `21-chat-pause-wall.png`, `22-chat-resume-wall.png`.
   - Recommendation: investigate why some simple lifecycle turns stall before model/tool events while the `proposeCanvas` turn succeeds.

6. Copy pass and fixes.
   - Fixed locally in `echo/agent/agent.py`: canvas agent instructions now say not to volunteer exact cadence/interval minutes unless the host asks.
   - Fixed locally in `echo/server/dembrane/canvas/skill.md`: generation guidance now explicitly forbids restyling `canvas-shell`, HTML comments, em-dash visible attribution, `real-time` for periodic frames, raw IDs, model/tool names, and `dembrane assistant` footers.
   - Pending deploy: these fixes only affect future agent/generator runs after this branch ships.

## Issues not fixed

- High: setup-chat seed run cancelled immediately. This blocks the complete Marieke interview and goal-proposal beat.
- High: chat lifecycle tools stall on `Pause the wall.` and block follow-up messages.
- Medium: goal proposal card apply path would save `set_by: host-edit` through the BFF if used; the story wants interview attribution. I did not change this because the setup flow never reached a goal card and the correct contract needs owner confirmation.
- Medium: generated canvas quality needs stronger enforcement beyond prompt text if models keep violating hard rules. Consider sanitizing/removing HTML comments and internal-id patterns at store time, or adding validation feedback before saving.
- Low: the canvas page exposes `Pause updates` / `Ask for the latest version` tooltip text in DOM evidence. This is acceptable, but review whether tooltip copy should be even more host-language-oriented.

## Verification

- `cd echo/agent && uv run pytest tests/test_agent_tools.py -k 'propose_canvas'`: passed, 2 tests.
- `cd echo/server && uv run ruff check dembrane/canvas`: passed.
- `cd echo/agent && uv run ruff check agent.py`: could not run because `ruff` is not installed in the agent environment.
- `cd echo/server && uv run ruff check ../agent/agent.py`: failed on pre-existing import sorting in `echo/agent/agent.py`; my edit did not touch imports.
- No git write commands were run.
