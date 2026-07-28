# Brief: Wave 6d - post-deploy verification on echo-next

The hardening merged (#808). Verify the fixes on https://dashboard.echo-next.dembrane.com
(admin@dembrane.com / dembrane2024, Playwright, real everything). Read
wave6a-REPORT.md (the failures) and wave6c-REPORT.md (the fixes + their "Remaining QA"
section - that section is your checklist).

0. FRESHNESS GATE first: confirm the new frontend is live - project settings must show
   the Methodology section (shipped in this merge). If absent, wait and retry (Vercel +
   Argo lag); do not test stale code. Also confirm api health 200.
1. BEAT 1 RETEST (was FAIL): create a fresh project -> land in setup chat -> watch the
   NETWORK: the seeded run must attach POST /runs/{id}/stream and there must be NO
   /runs/{id}/stop call. Let the live interview run; answer briefly as Marieke; a goal
   proposal card should appear -> Apply -> project settings shows the goal with
   'interview' attribution (set-by line).
2. BEAT 5 RETEST (was FAIL): in a chat with a canvas (create one if needed via a quick
   proposeCanvas flow), send 'Pause the wall.' -> the run must attach /stream and
   complete; loop status becomes paused; 'Resume the wall.' works; 'What's in my
   library?' answers with the canvas list. Composer must never stick at 'Working on
   your answer...'.
3. METHODOLOGY SMOKE: project settings selector lists dembrane (default, framing
   shown) and patches selection; workspace General tab Methodologies card: create one,
   edit it (history note), confirm dembrane row has no Edit.
4. GENERATION QUALITY spot-check: refresh a canvas on a project with real material;
   confirm the new rules hold (no HTML comments in the stored generation - check via
   API; no canvas-shell restyle; no cadence talk in the agent's chat replies).

Screenshots per step to wave6d-shots/ (do not git-add). NO code changes in this pass -
findings only. Report -> echo/docs/plans/smart-loop-briefs/wave6d-REPORT.md with
PASS/FAIL per item and network evidence for 1 and 2.
