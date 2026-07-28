# Brief: Wave 28f — rename Open questions, story spacing, + button opens chat

Start AFTER the 28e reconcile is merged: `git fetch origin && git checkout
-b sameer/canvas-render-polish origin/main` (verify 28e is in main first;
if not, say so in the report and stop). Server-side render/ledger files.

Owner feedback on the live wall (2026-07-09 morning):

## 1. Rename: Host guide -> Open questions

The tab's generated content reads as open questions to the room, and
"Open questions" was the owners' original name for this surface. Rename
the visible tab label (and any user-visible copy) to "Open questions".
Keep internal field names (canvas_host_guide) as-is to avoid a migration;
add a code comment noting the label/field split. Adjust the tab prompt so
the content leans into the name: parked questions + what to ask next;
"where the room is" stays as one short orienting line, not a section.

## 2. Story tab spacing per the handoff

Owner: "in story the spacings are off." The model already returns
structured slides (no raw HTML) — the spacing bug is OURS, in the
deterministic renderer. Bring _render_story/_story_slide in line with
echo/docs/plans/canvas-ux-handoff.md exactly:
- each slide `min-height: 80vh`, centered column, one idea per screen
- eyebrow (max ONE kicker per slide) + display heading (weight 500,
  `clamp(32px, 4.6vw, 48px)`, tracking -0.015em, text-wrap balance)
- lede max-width ~620px, 16px, soft ink with re-inked key phrases
- section breathing 22-30px; card padding tiers; never below 9px or above
  26px; middot separators; tabular-nums timestamps
Sweep the other tabs against the handoff spacing tiers while in there
(cloud 1060px measure, trace cards 15px 18px, etc.) — one pass, no
redesign.

## 3. The + tab button becomes a door to chat

The + in the tab bar currently does nothing. Make it a link (target=_top)
to `/{lang}/w/{workspace_id}/projects/{project_id}/chats/new?prefill=<t>`
where t = "I need a new tab in the {report name} canvas: " urlencoded.
The frontend prefill route ships in wave 31 (may land before or after —
the link format is agreed). workspace/project ids are available at render
time (loop/report context); language segment: use the same one the portal
links use or default en-US if unavailable. The sanitizer must keep the
anchor + target attribute — round-trip test it.

## QA gates

- cd echo/server && uv run ruff check . ; focused canvas pytest incl.
  sanitizer round-trip for the + anchor.
- Rendered-fragment snapshot/assertion tests updated for the new label.
- cd echo/agent && uv run pytest -q ONLY if agent copy references "host
  guide" (grep first).
- Report -> echo/docs/plans/smart-loop-briefs/wave28f-REPORT.md.
