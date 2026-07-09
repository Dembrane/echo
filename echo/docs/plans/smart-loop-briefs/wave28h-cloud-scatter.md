# Brief: Wave 28h — the cloud scatters like a room, not a spreadsheet

Start AFTER the 28g fix-back is merged: `git fetch origin && git checkout
-b sameer/cloud-scatter origin/main` (verify the 28g/trace-audit work is
in main; if not, report and stop).

Owner evidence: side-by-side with the reference wall (Oren's), our
concept cloud reads mechanical. Three concrete causes in
_render_cloud/_concept_tile CSS:

1. Rotation is binary: exactly -1.2deg or +1.2deg alternating by index.
2. Float is in unison: one shared `tabbedFloat 7s` with no per-tile
   delay or duration variance ("off phase AND different velocity per
   tile" is the owners' explicit ask from 2026-07-08).
3. Order is strictly size-sorted, so XL tiles clump at the top instead
   of being distributed through the flow.

## The fix: deterministic per-tile randomness

Derive per-tile values from a STABLE hash of the concept id (never
random(), never time-based — a tile must keep its personality across
re-renders and ticks):

- rotation: continuous in [-1.2, +1.2] deg
- float delay: [0, 7)s; float duration: [6, 9]s
- tiny translate offsets / margin variance within handoff spacing tiers
- ordering: deterministic hash-shuffle of the ~20 tiles with a
  constraint that the 3 XL tiles are spread (no two XL adjacent);
  size tiers keep their font-size classes (12px -> clamp(24px, 2.8vw,
  34px) per the handoff)

Implementation: inline per-tile style attributes (or generated CSS
classes) computed in Python at render time. Must survive the sanitizer
(round-trip test — style attributes with transform/animation-delay may
need the sanitizer allowlist extended narrowly; keep it to the exact
properties needed). `prefers-reduced-motion: reduce` still kills all
animation.

## QA gates

- Unit tests: same ledger state renders IDENTICAL html across two calls
  (determinism); different concept ids get different rotations/delays;
  no two XL adjacent in the rendered order; sanitizer round-trip keeps
  the style attributes.
- cd echo/server && uv run ruff check . ; FULL canvas pytest suite (all
  test_canvas_*.py + bff + agentic api).
- Report -> echo/docs/plans/smart-loop-briefs/wave28h-REPORT.md.
