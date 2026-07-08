# Wave 14 Verify Report - echo-next owner-feedback arc

Run time: 2026-07-08 08:57-09:06 UTC.

Target: `https://dashboard.echo-next.dembrane.com`, user `admin@dembrane.com`.
API health: `GET https://api.echo-next.dembrane.com/api/health` returned `200 {"status":"ok"}`.

Screenshots: `echo/docs/plans/smart-loop-briefs/wave14-shots/`.

## Summary

Overall: **FAIL**. The canvas route polish and freshness controls are live, and the setup first turn is substantially fixed in persisted BFF history, but the full owner-feedback arc is not fixed live. Portal link grounding points to the production portal, navigation cards did not render, the canvas update proposal was not visible/applicable in the thread, and existing agentic chat routes rendered the empty Ask state even though `/chat-messages` returned persisted user/assistant messages.

One-line owner-feedback answer: **No, not every piece of owner feedback from 2026-07-08 is fixed live.**

## Beat Results

### 0. Freshness gate - PASS

- Existing route opened: `https://dashboard.echo-next.dembrane.com/w/863463ac-62ab-4a4a-908b-401996b890de/projects/41ed3b10-b912-4859-8ec9-a33c38d4a213/canvases/8`
- Project/canvas: project `41ed3b10-b912-4859-8ec9-a33c38d4a213`, canvas/report `8`, `Street Feedback Dashboard`.
- Evidence: page showed `New chat about this canvas`.
- Evidence: breadcrumb ended with `Library > Street Feedback Dashboard`.
- Evidence: freshness chip showed `Stays up to date until tomorrow 09:59` and cadence copy `UPDATES EVERY 5 MINUTES`.
- Screenshot: `00-freshness-gate.png`.

### 1. Portal link + take me there - FAIL

- Chat: `d6cad155-d725-4058-917a-0432ba2d4fe1`, prompt `How do my interns record interviews? Where is the link?`
- Persisted BFF assistant reply included a portal link, but it was the wrong environment: `https://portal.dembrane.com/en/41ed3b10-b912-4859-8ec9-a33c38d4a213/start`.
- Required URL was `https://portal.echo-next.dembrane.com/en/41ed3b10-b912-4859-8ec9-a33c38d4a213/start`.
- No `agentic-navigation-suggestion` card rendered in the live thread, so there was no take-me-there click or SPA/back assertion to perform.
- It did not invent a `Portal tab`.
- Screenshots: `01-portal-link-card.png`, `rerender-portal.png`.

### 2. Setup conversation - PASS in persisted history, FAIL in rendered chat history

- Fresh project via wizard: `Wave14 Setup 1783501109994`, project `8fc38155-2a9c-406b-b8ad-6b2b57b3b5d3`, chat `85c9f134-bf6c-4ff7-8b2a-a24f9767e345`.
- Persisted first assistant message:
  - Started with a real question arc, not status narration.
  - Mentioned the dembrane way of working early: `We start on the dembrane way of working...`
  - Asked one main question: `What is the main thing you want to discover from the staff feedback about this neighborhood library program?`
  - Offered options: `Common challenges`, `New ideas`, `What's working well`, `Something else`.
  - Did not contain `interview`, question counts, or `frameworks`.
- However, re-opening the chat route rendered the empty Ask state instead of the persisted messages, despite BFF returning the history.
- Screenshots: `02-setup-first-turn.png`, `rerender-setup.png`.

### 3. Update proposal not swallowed - FAIL

- Existing canvas count before/after remained `1`, so no duplicate canvas was created during the failed UI attempt.
- Chat: `b6d2c78e-0007-41a9-85bd-6b3608d6f2d7`, prompt `In the canvas say 'interviews had' instead of 'interviews uploaded'.`
- Persisted BFF assistant reply said it proposed an update to `Street Feedback Dashboard`.
- The thread did not render an `agentic-canvas-suggestion` update card and did not render the compact already-in-library stub either.
- Because no update card rendered, Apply could not be clicked, no `I applied the canvas.` auto-message was produced, and reload persistence could not pass.
- Newest checked generation remained `6fa24d11-b6f7-4d8e-9654-b1bfb2986252` from `2026-07-08T08:19:03.383Z`; it still contained `interviews uploaded` and did not contain `interviews had`.
- Screenshots: `03-update-proposal-card.png`, `rerender-update.png`.

### 4. Canvas brand + freshness - PASS

- Canvas iframe uses `DM Sans Variable`, with fallback `DM Sans`.
- Iframe DOM contains `.dembrane-canvas-brand` with a data-URI dembrane wordmark image.
- Screenshot: `04-canvas-iframe-brand.png`.
- Freshness popover opened from `canvas-freshness-chip`; screenshot: `04-freshness-popover.png`.
- Saving the default `24 hours` setting moved the loop expiry to `2026-07-09T08:58:10.000Z`.
- Chip updated to `Stays up to date until tomorrow 10:58`; cadence remained `UPDATES EVERY 5 MINUTES`.
- Library remained present/highlighted on the canvas route.

### 5. Sample preview - FAIL in UI, PASS at preview API layer

- Fresh empty project: `Wave14 Empty 1783501128417`, project `d9a28f59-fb24-4299-a47b-61675a5e8b6d`, chat `b36e275d-499d-4a70-ab38-8fc31d7f1965`.
- Asking for a live canvas did not render a proposal or `Try it out` control in the chat UI.
- Direct preview API probe on that empty project passed: `POST /api/v2/bff/canvases/preview` returned generated HTML containing `Sample conversations, your real conversations replace these.` and sample participant labels.
- Real project scheduled/manual generations checked for canvas/report `8` did not contain `sample conversations`.
- Screenshots: `05-sample-preview-proposal.png`, `rerender-sample.png`.

### 6. Navigation grounding regression - FAIL

- Chat: `bab5a18f-9a14-4922-b223-9b1e531374cb`, prompt `where do I find the invite link?`
- No assistant response persisted for the first attempt.
- Rerun chat `07154bdc-8dae-49d4-9a57-aa0cc3e97c88` also had only the user message after repeated BFF polls.
- No `agentic-navigation-suggestion` card rendered, so the required short locating sentence + take-me-there card was absent.
- Screenshot: `06-invite-link-navigation.png`.

## Additional Live Regression Found

Existing agentic chat routes do not render persisted history. Browser network showed:

- `GET /api/v2/bff/chats/d6cad155-d725-4058-917a-0432ba2d4fe1` returned `200`.
- `GET /api/chats/d6cad155-d725-4058-917a-0432ba2d4fe1/context` returned `200` with user/assistant token entries.
- `GET /api/v2/bff/chat-messages?chat_id=d6cad155-d725-4058-917a-0432ba2d4fe1&limit=500` returned `200` with the persisted user and assistant messages.
- The UI still displayed the empty Ask state: `Where would you like to start?`

This directly blocks the update-card reload check and makes the live chat evidence worse than a simple agent-answer issue.
