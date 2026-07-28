# Brief: Wave 6a - the complete Marieke flow on echo-next, find and fix

v1 is DEPLOYED to echo-next (real workers, real agent service, real models). Your job:
walk the complete story as a real user against https://dashboard.echo-next.dembrane.com,
prove what works, fix what's small, and report what's not. Read first: the story
(docs/building/smart-loop.md), `echo/docs/plans/smart-loop.md` (v1 acceptance),
wave4-REPORT.md (what was already proven locally and what wasn't: scheduled ticks and a
LIVE agent turn producing proposeCanvas - those two are YOUR headline targets).

## Environment

- Browser (Playwright, headed ok): https://dashboard.echo-next.dembrane.com - log in as
  admin@dembrane.com / dembrane2024. If that account lacks onboarding/workspaces, say
  so and use whatever workspace it can reach; create a fresh test project for the run.
- The agent service is live on echo-next; agentic chat is enabled there.
- You may also curl https://api.echo-next.dembrane.com directly with a Directus token
  (POST https://directus.echo-next.dembrane.com/auth/login, same creds) for API-level
  checks.
- You CANNOT redeploy: fixes you make land locally in this worktree (branch
  sameer/smart-loop-hardening) and ship on the next merge - so VERIFY fixes locally
  (gates + dev-server where practical) and note "pending deploy" in the report.

## The flow to walk (in order; screenshot each beat to wave6-shots/, do not git-add)

1. Create a project -> confirm you land in the setup chat with the seeded message ->
   let the LIVE agent interview you (answer as Marieke: citizen panel, themes per
   neighbourhood) -> a goal proposal card appears -> Apply -> goal visible in project
   settings with the interview attribution.
2. Record NO audio (empty project): ask the chat for a live wall ("I want a live
   overview on a big screen, themes as they emerge, until <2h from now>") -> a REAL
   proposeCanvas proposal card from a LIVE agent turn -> Try it (real preview, honest
   empty state) -> Apply -> Open in Library.
3. Library lists it; open the canvas; Refresh now produces a generation; confirm the
   SCHEDULED tick also fires (wait one cadence; version strip gains an entry WITHOUT
   manual refresh - real workers run on echo-next). Pause -> no new versions; Resume.
4. Add real material: upload a text conversation or two into the project (the upload
   route exists) so the next generation has data -> refresh -> judge the generation
   against echo/server/dembrane/canvas/skill.md (meaningful? honest? kit-styled? not
   generic dashboard-ware?). Paste 30 lines + judgement.
5. Lifecycle by CHAT: ask the agent to pause the wall, then resume it, then what
   canvases exist ("what's in my library?") - the live tools should answer.
6. Copy pass along the way: note every string that is off-brand (jargon like
   "polling"/"interval"/"generation failed", "AI", capitalized Dembrane, dishonest or
   robotic phrasing) in chat, cards, Library, canvas page, settings. Fix the small
   ones in code (lingui + recompile); list the debatable ones in the report.

## Fix policy

- Fix in this worktree: copy issues, small UX honesty gaps (blank states, missing
  loading/error states, broken links), obvious wiring bugs. Run the matching gates for
  everything you touch (server: whole-tree ruff + focused pytest; frontend: tsc + lint
  + lingui). Do NOT touch src/components/methodology/ or the workspace-settings
  methodology card area (a parallel agent builds there).
- Anything structural (agent behavior redesign, schema, new endpoints): REPORT, don't
  build.
- No git write commands.

## Report -> echo/docs/plans/smart-loop-briefs/wave6a-REPORT.md

Per beat: what happened (DOM/screenshot refs), PASS/FAIL vs the story, fixes made
(file + why), issues found but not fixed (severity + your recommendation), and the two
headline verdicts up top: did a LIVE agent turn produce a working proposeCanvas card,
and did the SCHEDULED tick fire on its own.
