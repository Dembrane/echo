# Wave 8 verify report

Live target: `https://dashboard.echo-next.dembrane.com`, app `v3.0.2`, API health `200 {"status":"ok"}`.

Evidence:

- Screenshots: `echo/docs/plans/smart-loop-briefs/wave8-verify-shots/`
- Network/message evidence: `echo/docs/plans/smart-loop-briefs/wave8-verify-shots/wave8-verify-evidence.json`
- Workspace: `863463ac-62ab-4a4a-908b-401996b890de`
- Toggle-off project: `9e7e4dc5-f6ad-4fc6-91e3-a7c33408c43d`
- Setup/apply project: `07e9b734-8b59-47ce-bbc3-719b4fa7c738`
- Setup/apply chat: `15bb8e96-9405-4129-81c4-f8f92c061869`
- Run ids observed: `e3147155-d7c4-416c-85d8-13b728c79089`, `0737e9c2-43de-4ed5-90e7-5179b24c3917`

## Beat results

0. Freshness gate: PASS
   - API health returned 200.
   - Create-project wizard showed `Set up with the assistant after creating`.

1. Wizard toggle: PASS
   - Default/on state review said `Start in assistant chat`; created project landed in setup chat.
   - Off state review said `Go to project home`; created project landed on project home.
   - `Help me figure it out` advanced to access with the assistant switch checked.

2. Setup conversation wording: FAIL, strict
   - Banned wording is gone: no `interview`, no announced question count, no numbered multi-question dump.
   - The option turn is good: one question with 3 concrete options and an own-words escape hatch.
   - Strict failure: the first persisted assistant message was a host-visible status/planning turn, not a skippable one-question turn: `I am looking at your current settings and project context... Reviewing the onboarding playbook project context...`.
   - No `frameworks`/`tools` product wording and no docs-link closer were found in the first assistant turns.

3. Composer: PASS
   - `New messages will be answered next.` was absent during an in-flight run.
   - A mid-turn send appended a user message and generated zero `/stop` calls.

4. Artifacts: PASS for specified checks, with one noted wording leak
   - Across 9 persisted assistant messages: no trailing underscore after punctuation.
   - No persisted assistant message consisted of a lone parenthetical planning line.
   - No assistant message ended with a docs link/docs closer.
   - Noted: the first assistant message still starts with planning/status prose (`I am looking at...`), which is why beat 2 is strict-fail.

5. Apply is a message + durable: PASS
   - Goal Apply auto-sent persisted user message `I applied the goal.`
   - Assistant responded after goal apply: assistant count 6 -> 7.
   - Reload showed goal card applied.
   - Goal API returned current goal with `set_by: "interview"` and project settings displayed it.
   - Canvas Apply auto-sent persisted user message `I applied the canvas.`
   - Assistant responded after canvas apply: assistant count 8 -> 9.
   - Reload showed canvas card applied.
   - Canvas API returned one canvas named `Onboarding Playbook Adoption Barriers`; no duplicate canvas with that name.

6. Sidebar: PASS
   - Project nav order includes `Monitor` immediately followed by `Library`.

## Verdict

Not every owner complaint is fully fixed live under the strict brief: wizard toggle, composer, apply durability, duplicate prevention, artifact cleanup, docs closer, and sidebar order pass, but setup wording still exposes a persisted planning/status assistant turn before the skippable option question.
