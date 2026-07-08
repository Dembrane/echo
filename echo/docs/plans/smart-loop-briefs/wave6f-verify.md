# Brief: Wave 6f - final verification on echo-next (after the 6e fixes)

Read wave6e-REPORT.md (the fixes + local reproductions) and wave6d-REPORT.md (the
failures). READ-ONLY pass against https://dashboard.echo-next.dembrane.com
(admin@dembrane.com / dembrane2024, Playwright). No code changes, no git writes.

0. FRESHNESS: api health 200 AND the frontend carries the 6e build - check that the
   workspace Methodologies card's create modal exposes the new testIds (added in 6e).
   If stale, wait and retry.
1. BEAT 1 (the one that failed twice): fresh project -> setup chat -> NETWORK: stream
   attach present, ZERO /stop calls -> live interview (answer briefly as Marieke) ->
   goal proposal card -> Apply -> project settings shows the goal attributed to the
   interview. Capture the run id + network log.
2. BEAT 5: on a project with a canvas (reuse Wave 6a's or create one), by chat:
   'Pause the wall.' -> loop status actually becomes Paused on the canvas page;
   'Resume the wall.' -> active; 'What's in my library?' -> lists canvases. Composer
   never sticks. Capture run ids; confirm via the API that the pause tool events exist
   in the run.
3. METHODOLOGY create/edit (now automatable): workspace General tab -> create
   'Wave 6f methodology' (description + framing) -> edit it (change framing, add a
   history note) -> confirm history count increments and dembrane row still has no
   Edit. Then in a project: select it; confirm the PATCH fires and the framing shows.
4. GENERATION HEALTH: confirm scheduled ticks are healthy again post-fix - query the
   API for the newest canvas_generation rows (Directus token): the most recent
   scheduled entries should be ok or no_op, NOT error/cancel-scope. If a canvas with
   real material exists, Refresh now and confirm a fresh ok generation whose HTML has
   no comments, no canvas-shell restyle, no cadence copy.

Screenshots to wave6f-shots/ (no git-add). Report ->
echo/docs/plans/smart-loop-briefs/wave6f-REPORT.md: PASS/FAIL per item with network/API
evidence, and a one-line overall verdict: is the Marieke v1 story fully working on
echo-next?
