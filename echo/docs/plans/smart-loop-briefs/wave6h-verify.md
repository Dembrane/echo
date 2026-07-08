# Brief: Wave 6h - the mirror verification (after the composer redesign)

Read wave6g-REPORT.md (what changed) and wave6f-REPORT.md (the failures to mirror).
READ-ONLY against https://dashboard.echo-next.dembrane.com (admin@dembrane.com /
dembrane2024, Playwright). No code changes, no git writes.

0. FRESHNESS: api health 200 AND the composer carries the redesign - open any agentic
   chat, start a turn, and confirm the Send control REMAINS Send while the run is in
   flight, with a separate small Stop icon control present. If the morph is still
   there, the frontend is stale: wait and retry.
1. BEAT 1, including the killer behavior: fresh project -> setup chat -> while the
   assistant is STILL WORKING, type an answer and CLICK the send control (this is what
   broke 6d and 6f). NETWORK: zero /stop calls; the mid-turn message appends and gets
   answered when the current step finishes. Continue the interview as Marieke -> a
   GOAL proposal card (not project-update) -> Apply -> project settings shows the goal
   attributed to the interview. Capture run id + network log.
2. BEAT 5, inside the CANVAS PROJECT'S chat (not new Ask-home chats): 'Pause the
   wall.' -> canvas page shows Paused; 'Resume the wall.' -> active; 'What's in my
   library?' -> lists canvases. Confirm tool events exist in the run via the API.
3. METHODOLOGY: workspace General -> create 'Wave 6h methodology' -> edit framing +
   history note -> history count increments -> select it on a project -> PATCH fires,
   framing shows. (The crash from 6f is supposedly fixed; if the error boundary
   appears again, capture the console error verbatim.)
4. TICK SELF-HEALING + QUALITY: create a fresh 2h canvas with cadence 5 on a project
   with real material; confirm a SCHEDULED generation appears within ~7 minutes
   without manual refresh (proves chain + sweep). Then check the newest generation
   rows via the API: fresh scheduled entries ok/no_op; note any banned-copy detections
   recorded in detail fields.

Screenshots to wave6h-shots/ (no git-add). Report ->
echo/docs/plans/smart-loop-briefs/wave6h-REPORT.md: PASS/FAIL per item with evidence,
plus the one-line verdict: is the Marieke v1 story fully working on echo-next?
