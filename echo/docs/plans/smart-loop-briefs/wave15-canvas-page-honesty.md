# Brief: Wave 15 - canvas page: honest freshness, one breadcrumb, calm header

Owner, on the live canvas page (screenshot evidence): "this whole ui looks
sucky" and "this canvas was supposed to update every 5 min but why did it
not?" The loop was actually healthy: it checked every 5 minutes and found no
new conversations (runs since 08:48 all no_op "No new gathered content"), the
last redraw was when the second interview landed. The page just never shows
the difference between CHECKED and CHANGED. Branch: sameer/wave14-verify is a
verify-only branch; create/work on sameer/canvas-page-polish off main. Read
echo/frontend/AGENTS.md, echo/AGENTS.md UI rules, the D17 design principles,
and routes/project/canvas/CanvasRoute.tsx first. wave14-verify may still be
running against echo-next; you are local-only.

## Item 1: honest freshness (the trust fix, do this best)

Current: chip "UPDATES EVERY 5 MINUTES" (all-caps, off-brand) + italic "Last
updated 43 minutes ago" reads like the product is broken when the loop is
actually checking on time and finding nothing new.

Target experience, one coherent freshness line/cluster:
- when the last check found nothing: "Checked 2 minutes ago. Nothing new
  since your last conversation. Updated 43 minutes ago."  (wording yours,
  but it must distinguish checked vs updated and read warm, sentence case)
- when a redraw just happened: "Updated 2 minutes ago."
- paused: say paused plainly; expired: say it stopped and when.
Data: the BFF canvas detail already carries loop fields; extend it if the
last-run time/status (no_op vs ok) is not exposed yet (agent_loop_run has
started_at/status/detail). Keep the "stays up to date until <day time>" chip
(wave 12) and cadence editing popover, but restyle so the cluster is ONE
visual family: no all-caps, no shouting, brand chips only.

## Item 2: one breadcrumb, the real one

The app-level breadcrumb still reads Home > dembrane > Internal > sam >
"Canvas" while a second "Library > <name>" line sits under the title (the
wave-12 fix landed in the wrong place). Fix the APP breadcrumb source so the
trail is ... > <project> > Library > <canvas name> (find where routes feed
the top breadcrumb; the sidebar/topbar own it), and REMOVE the duplicate
in-page Library > name line. Exactly one breadcrumb on the page. Library
sidebar highlight must keep working.

## Item 3: calm header - ONE home for controls

Owner follow-up, verbatim: "(multiple breadcrumbs) too many settings
haphazardly placed." Title row currently: page title, then loose blue text
links "New chat about this canvas / Pause / Refresh now" + expand icon +
two chips + a popover - six scattered control surfaces.

Consolidate: title + the honest freshness cluster (item 1) on the left; on
the right exactly TWO affordances: the primary chat action ("New chat about
this canvas" or "Open the chat", whichever resolves - they can share one
button with the other in its menu) and ONE quiet menu (Mantine Menu, icon
trigger) holding Pause/Resume, Refresh now, how-long-it-stays-live, how
often it updates, and Full screen. The freshness chip stays informative but
its EDITING moves into that same menu so settings live in one place. Same
behaviors, same tooltips, lingui strings; follow ConfirmModal/menu
conventions and neighbors (LiveMonitorSection, report page) for register.

## Item 4: the iframe dead space + scrollbar

The generated canvas opens with a large blank band above content and shows a
heavy dark scrollbar strip on the right. In the kit css (canvas side):
tighten canvas-shell top spacing so content starts near the top, and style
iframe scrollbars to be quiet (thin, brand-neutral, auto-hiding where the
platform allows). Also check the skill so generations do not add their own
big top padding/hero whitespace.

## Item 5: tick-chain idempotency (server, small but real)

Evidence: during this morning's deploys the loop's scheduled chain
multiplied: 7 parallel runs at 08:48 UTC, 13 at 08:54, all no_op, settling
back to 1 by 09:02 (loop 5f6ad6a6-2844-4698-ac97-9b0293487ca3, echo-next).
Cause is deploy-time redelivery/sweep duplication. Add an idempotency guard
so at most one tick per loop runs per cadence window (e.g. Redis SETNX
canvas:tick:{loop_id}:{window} with TTL slightly under cadence; follow the
existing refresh rate-limit pattern in bff/canvases.py). Duplicates must
exit without enqueuing their own next tick (chains must collapse, not
multiply). Unit-test the guard.

## QA

- Gates: server whole-tree ruff + focused pytest (ticks); frontend tsc,
  biome lint, lingui extract+compile.
- Playwright fixtures: canvas page screenshot (header + freshness cluster +
  single breadcrumb), before/after to wave15-shots/ (no git-add).
- No git write commands. Report ->
  echo/docs/plans/smart-loop-briefs/wave15-REPORT.md.
