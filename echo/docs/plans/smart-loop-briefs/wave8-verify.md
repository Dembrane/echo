# Brief: Wave 8 verify - owner-feedback fixes live on echo-next

READ-ONLY against https://dashboard.echo-next.dembrane.com (admin@dembrane.com /
dembrane2024, Playwright). No code changes, no git writes. Read
wave8-owner-feedback.md (what was fixed) and wave8-REPORT.md (how) first.
Merged to main as PR #814 at 2026-07-08T07:29Z; echo-next deploys from main.

0. FRESHNESS GATE: the create-project wizard must show the new switch
   "Set up with the assistant after creating". If absent, the frontend is stale:
   wait 3-5 minutes and retry (up to ~25 minutes). Also confirm api health 200.
   Do not run the other beats against a stale deploy.

1. WIZARD TOGGLE, both states:
   a) Toggle ON (default) -> create project -> land in the setup chat.
   b) Toggle OFF -> review step says you'll go to project home -> create ->
      land on project home, no chat.
   c) "Help me figure it out" -> toggle flips ON.

2. SETUP CONVERSATION WORDING: in the fresh setup chat from 1a, read the first
   assistant turns. FAIL if it says "interview", announces a question count
   ("five questions"), or dumps multiple numbered questions in one message.
   PASS = one question per turn with 2-4 concrete options, plainly skippable.
   Also: the word "frameworks"/"tools" must not appear for methodologies, and no
   message may END with a docs link as the closing line.

3. COMPOSER: while a turn is in flight, confirm the line "New messages will be
   answered next." is GONE, and mid-turn send still appends with zero /stop calls.

4. ARTIFACTS: over the whole conversation from beats 1-2 (and one Ask chat),
   check every persisted assistant message via the API/network: none may end
   with a trailing underscore after punctuation, and none may consist of a lone
   parenthetical planning line like "(I am checking ...)".

5. APPLY IS A MESSAGE + DURABLE (the owner's exact repro): continue the setup
   conversation until a GOAL proposal card appears -> Apply ->
   a) a user message "I applied the goal." appears in the thread automatically
      and the agent responds on its own (no "let me know once you have applied").
   b) RELOAD the page -> the card still shows applied, not an Apply button.
   c) project settings shows the goal, provenance interview.
   Then ask for a canvas -> Apply on the canvas card -> same three checks with
   "I applied the canvas." -> reload -> re-check the card; confirm via the API
   that only ONE canvas with that name exists (no duplicate).

6. SIDEBAR: in the project sidebar, Library sits directly below Monitor.

Screenshots to wave8-verify-shots/ (no git-add). Report ->
echo/docs/plans/smart-loop-briefs/wave8-verify-REPORT.md: PASS/FAIL per beat
with evidence (run ids, message excerpts, network logs), plus a one-line
verdict: is every one of the seven owner complaints fixed live?
