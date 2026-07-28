# Brief: Wave 12 - canvas polish: brand, QR, freshness control, breadcrumbs

Owner feedback from live echo-next usage (three messages, verbatim quotes
below). Branch: sameer/agent-portal-link. Wave 11 lands before you; rebase your
mental model on the tree as you find it. Read echo/brand/STYLE_GUIDE.md,
echo/server/dembrane/canvas/skill.md, echo/frontend/src/components/canvas/
(kit.ts, kit.css, CanvasFrame), and the D-decisions in
echo/docs/plans/smart-loop.md first.

## Item 1: the canvas wears dembrane's brand (or the host's whitelabel)

"in the canvas can we add dembrane / whitelabel logo branding / dmsans font
correct brand guidelines from documentation / code if possible?"

- Kit fonts: the canvas iframe must render DM Sans (the brand font). The kit
  CSP is default-src 'none' with font-src data:, so the font must ship as an
  inline data: URI in the kit css (subset if size demands; check what the
  frontend already bundles for DM Sans and reuse).
- Kit palette: reconcile kit.css tokens against brand/STYLE_GUIDE.md and
  src/colors.ts (Royal Blue #4169e1, Parchment, Graphite, the accent set).
  Fix any off-brand values. The skill's taste layer should name the palette
  tokens, not hex, so generations stay on-brand.
- Logo: a quiet dembrane wordmark (lowercase, per brand) in the canvas shell,
  assembler-side (kit), never model-generated. Whitelabel: find how the
  dashboard resolves a workspace/host whitelabel logo (grep whitelabel in
  frontend + user_settings.py) and use the same resolution: whitelabel logo
  when configured, dembrane wordmark otherwise. Inline as data: URI at
  assembly time (CSP img-src data: already allows it).
- This is assembler/kit territory (client owns the shell, D-decisions);
  generations must not gain the ability to fetch anything external.

## Item 2: QR codes in the canvas

"also give a way to create and add custom qr codes (with skip onboarding for
example) or some autofilled tags and create different canvasses or something"

- FIRST investigate what the participant portal start route actually supports
  as query params (skip onboarding? preselected tags?). Grep the participant
  router/start flow. Offer ONLY parameters that exist; if none exist yet, the
  QR is the plain portal link and you report the param gap instead of
  inventing it.
- Kit primitive: a canvas-qr element the assembler resolves into an inline
  SVG/data-URI QR at assembly time (the dashboard already renders portal QR
  codes; reuse that generator). The model emits <div class="canvas-qr"
  data-url="..."> with the portal link; the assembler validates the URL is
  the project's own portal link (origin + project id must match, nothing
  else becomes a QR) and renders it. Skill: document the primitive and when
  to use it (e.g. a wall inviting passersby to contribute).
- Agent: the canvas proposal/brief flow can mention the portal QR (it knows
  the link via getPortalLink). Keep it optional, host-requested.

## Item 3: freshness the host can read AND edit

"STAYS UP TO DATE UNTIL 09:59 -> idk till which date and how i can edit these
things!" and "for example live - but i dont know how frequent the updates
are!"

- The chip must say when in full: today -> "stays up to date until 09:59";
  another day -> include the day ("until tomorrow 09:59" / "until Fri Jul 10,
  09:59"). Also surface the rhythm in plain words: "updates every 5 minutes"
  (from cadence_minutes), near the chip or inside its popover.
- Make the chip an affordance: clicking opens a small popover to change how
  long it stays live (a few honest choices: 8 hours, 24 hours, 3 days, plus
  custom) and how often it updates (5 / 15 / 60 minutes). Wire through a BFF
  PATCH on the loop (expiry + cadence). Respect existing loop semantics
  (mandatory expiry stays mandatory; extending resets the window, never
  infinite). The chat remains able to do the same via tools; this is the
  direct-manipulation path.
- Experience-first copy, no cron jargon, sentence case, lingui.

## Item 4: canvas breadcrumbs + Library highlight

"the bread crumbs is wrong on the canvas (and library doesnt get highlighted)
basically check it"

Evidence (screenshot): on a canvas page the breadcrumb reads Home > dembrane >
Internal > sam > "Canvas" (generic, no Library, no canvas name) and the
Library sidebar item is not highlighted. Fix: breadcrumb ... > sam > Library >
<canvas name> (Library crumb links to the library route); the Library NavItem
active state must match both /library and /canvases/* routes (find how other
NavItems compute active state and extend the matcher). Check the Monitor/
Report items for the same class of bug while you are there and fix if present.

## Item 5: track, do not build

"i would LOVE to embed monitor in the canvasses, and the latest conversations
in a performant way without polling (but this can come later)"

Add these two to the tracked v1.5 list in echo/docs/plans/smart-loop.md
(embed live monitor as a canvas element; live latest-conversations element
via SSE, no polling). One line each. No implementation.

## QA

- Gates: server whole-tree ruff + focused pytest; agent uv run pytest -q;
  frontend tsc, biome lint, lingui extract+compile.
- Playwright with fixtures: canvas shows DM Sans + logo (screenshot), QR
  element renders from a valid portal URL and refuses a foreign URL, chip
  shows day+time and popover PATCHes, breadcrumb + Library highlight on a
  canvas route. Screenshots to wave12-shots/ (no git-add).
- No git write commands. Report ->
  echo/docs/plans/smart-loop-briefs/wave12-REPORT.md.
