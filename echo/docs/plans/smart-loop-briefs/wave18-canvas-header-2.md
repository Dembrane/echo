# Brief: Wave 18 - canvas presentation round 2 (logo on top, auto-height, freshness cluster)

You are in the solve-queue-issues worktree. Start:
`git fetch origin && git checkout -b sameer/canvas-header-2 origin/main`.
(origin/main includes #817 canvas polish; #818 may or may not be in yet, it
touches different files.) Owner feedback on the LIVE post-#817 page, with
screenshots. Read routes/project/canvas/CanvasRoute.tsx,
components/canvas/CanvasFrame.tsx, components/canvas/kit.ts, and
components/report/ReportRenderer.tsx first.

## Item 1: the logo, on top, like reports

Owner: "logo should be on top (same logo as report basically). currently it
is just text." Reports render the shared `<Logo />` component
(components/common/Logo, whitelabel-aware, logomark not just wordmark) at the
top (ReportRenderer.tsx:73). The canvas kit currently inlines
wordmark-no-padding.svg (text only) at the BOTTOM (kit.ts:124-139).

Move the assembler brand mark to the TOP of the canvas document and use the
same visual identity as the report header: the full logo treatment (logomark
+ wordmark, or whitelabel logo when configured), converted to a data: URI for
the iframe CSP as today. Quiet, small, top-left or top-center to match the
report's register. Remove the bottom text-only mark.

## Item 2: kill the empty scroll - iframe auto-height

Owner: "the iframe is too long empty space scrolling." Root fix, not
padding tweaks: make the iframe fit its content. The kit CSP allows inline
script; add a tiny kit script that reports the document scrollHeight to the
parent via postMessage (throttled, on load/resize/mutation), and have
CanvasFrame listen (validate event.source is this iframe; origin is "null"
for sandboxed srcdoc so match on source identity) and set the iframe height,
within a sane min (e.g. 320px) and no max in page mode. Fullscreen mode keeps
viewport height. Result: no inner scrollbar, no dead space, the page scrolls
as one document. Update kit fixtures/tests if any assert on the old shell.

## Item 3: freshness cluster presentation + settings split

Owner screenshots show: (a) sometimes only "Updated about 1 hour ago." with
no Checked-part (run info missing or loading - make the line render
coherently in every state: while loading show nothing rather than half a
sentence; when run info is genuinely unavailable show just Updated); (b) a
stray native tooltip "Canvas preview" overlaps the text - that is the
iframe's title attribute (CanvasFrame.tsx:136); switch to aria-label so
screen readers keep the name but no native tooltip floats over the header.

Restructure per owner: "fullscreen mode should be an icon outside. we should
split the updating settings and keep it nearby the indicator. and maybe
presenting in a slightly better way would be nice":
- Fullscreen: icon-only ActionIcon with tooltip, placed at the canvas frame
  (top-right of the frame or header right, NOT inside the ... menu).
- The stays-live-until chip + checked/updated line + a small edit affordance
  (subtle icon button right next to them) form ONE cluster under the title;
  the edit affordance opens the existing expiry/cadence popover. Remove
  those two entries from the ... menu; the menu keeps pause/resume + refresh
  now (and dies entirely if only two items feel better as visible subtle
  buttons - your call, justify in the report).
- Present the cluster with intention: chip, then the sentence in one quiet
  line, consistent type ramp steps (no adjacent sizes), sentence case,
  nothing overlapping.

## QA

Gates: frontend tsc, biome lint, lingui extract+compile; server untouched
(unless kit script needs sanitize allowances - if so, whole-tree ruff +
canvas tests). Playwright fixtures: screenshot the header cluster and an
auto-height canvas (short content = short iframe, long content = full
height, no inner scrollbar) to wave18-shots/ (no git-add). Check the
CSP/sandbox still blocks external refs (postMessage needs no CSP change).

No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave18-REPORT.md (this worktree).
