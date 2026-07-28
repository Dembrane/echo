# Brief: Wave 19 verify - the full day, live on echo-next

READ-ONLY against https://dashboard.echo-next.dembrane.com (admin@dembrane.com /
dembrane2024, Playwright). No code changes, no git writes. PRs #817, #818,
#819, #820 all merged to main by ~11:5x UTC 2026-07-08. The agent_insight
migration has been run against echo-next. Prior verify: wave14-REPORT.md
(three regressions, since fixed). Read wave15-wave18 briefs/REPORTs for what
shipped.

0. FRESHNESS GATE: open an existing canvas page. The iframe must have
   aria-label="Canvas preview" and NO title attribute (wave 18), and the
   create-project wizard's Name step must contain the "Set up with the
   assistant after creating" switch (wave 17 PR). If stale: wait 3-5 min,
   retry up to ~25 min. api health 200.

1. REGRESSION RETEST (the wave-14 failures, exact same probes):
   a) Open chat d6cad155-d725-4058-917a-0432ba2d4fe1 in a FRESH browser
      context (no localStorage): the persisted user+assistant messages must
      RENDER (not the empty Ask state).
   b) New chat: "How do my interns record interviews? Where is the link?"
      -> link must be https://portal.echo-next.dembrane.com/... (NOT
      portal.dembrane.com), plus a navigation card; click it: SPA navigation,
      Back returns to the chat.
   c) "where do I find the invite link?" in another chat -> short locating
      sentence + take-me-there card; the run must produce a persisted
      assistant reply (the Vertex-400 stall is fixed).
   d) Canvas update proposal: ask to change wording on the existing Street
      Feedback Dashboard -> an update card renders (not swallowed, not the
      library stub) -> Apply -> "I applied the canvas." auto message ->
      agent continues -> reload -> card still applied -> no duplicate canvas.

2. CANVAS PAGE (waves 15+18): on the Street Feedback Dashboard page verify
   and screenshot: dembrane logo at the TOP of the canvas content (not a
   bottom text wordmark); iframe height fits content with NO inner scrollbar
   and no long empty tail; freshness cluster shows checked vs updated
   coherently (never a half sentence); expiry/cadence edit affordance sits
   NEXT TO the freshness indicator and works (change stays-live-until, API
   confirms); fullscreen is a visible icon; exactly ONE breadcrumb trail on
   the page ending Library > Street Feedback Dashboard.

3. INSIGHTS PIPELINE (wave 17): in a project chat, express a capability wish
   the product cannot do (e.g. "I wish the canvas could email me a weekly
   summary"). Then query Directus items/agent_insight (admin login): a row
   should exist with kind wish (or capability_gap), plain-words content, and
   chat_id reach-back matching the chat. Confirm the agent did NOT narrate
   logging beyond at most one "noted for the dembrane team" line, and no
   transcript verbatims in the row.

4. WIZARD: the setup toggle appears in the NAME step (with name/description),
   not in Access; toggle off -> Review says project home; create -> lands
   on project home.

5. WORKER HEALTH: confirm via the API that the Street Feedback Dashboard
   loop still ticks on cadence (agent_loop_run rows continuing, one per
   window, no duplicate bursts) - list the last 6 runs with timestamps.

Screenshots to wave19-shots/ (no git-add). Report ->
echo/docs/plans/smart-loop-briefs/wave19-REPORT.md: PASS/FAIL per beat with
evidence, plus one line: is the whole 2026-07-08 owner-feedback arc now
verified live?
