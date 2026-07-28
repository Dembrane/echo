# Brief: Wave 20 - what you approved is what goes live (preview primes the loop)

You are in the solve-queue-issues worktree. Start:
`git fetch origin && git checkout -b sameer/preview-primer origin/main`.

Owner evidence (live session, chat fca458cb-1787-4dc9-aaff-97cdb6eca690,
project 14f853a6-5653-4323-8f28-45c631888d1c on echo-next): a social designer
iterated a canvas through three update proposals (typography, spacing,
pet-only emoticons), previewed with "Try it out", applied - then: "the live
version and the one u showed in chat (after try now) is completely diff.
maybe the context isnt passed from the trial run to the canvas as a primer."

Exactly right. Today the preview HTML is discarded on Apply; the next
scheduled tick regenerates from the OLD previous frame + new brief, so the
live canvas drifts away from what the host approved. Read
echo/server/dembrane/canvas/ticks.py (previous-frame selection + sanitize),
echo/server/dembrane/canvas/service.py (create/update), bff/canvases.py
(preview + create + PATCH), and CanvasSuggestionCard.tsx (previewHtml state,
apply paths) first.

## The fix: applied preview becomes the newest frame

1. SERVER: canvas create AND canvas update endpoints accept optional
   `applied_preview_html`. When present: run it through the SAME sanitize
   path as tick output (extract_body_fragment, external-ref strip, size cap),
   store it as a generation row (trigger value that reads honestly, e.g.
   "applied", status ok) so it becomes the latest frame, and publish the
   Redis generation nudge so every open reader (the wall) updates
   immediately. Result: Apply -> the live canvas shows the approved design
   within seconds, and the next scheduled tick evolves FROM it (confirm the
   previous-frame selection in ticks.py picks the newest generation
   regardless of trigger; fix if it filters by trigger).
2. FRONTEND (CanvasSuggestionCard): when the host generated a preview on the
   card, Apply sends that exact previewHtml as applied_preview_html on both
   the create and the update path. No preview generated -> field omitted,
   behavior unchanged. The applied-state card copy can say what happened:
   "Applied. The canvas now shows this design and keeps it fresh." (brand
   voice, lingui).
3. HONESTY: the applied generation must carry its provenance (the detail
   field or equivalent: applied from a chat preview + chat id if cheaply
   available) so the version strip and any debugging reads truthfully.
4. TESTS: server - sanitize is applied (a preview with an external script/
   img must be stripped), the generation row lands as latest, tick after an
   applied generation uses it as previous frame; frontend - apply with
   preview sends the field, apply without omits it.

## QA

Gates: server whole-tree ruff + canvas test files; frontend tsc, biome lint,
lingui extract+compile. curl QA: create a canvas with applied_preview_html
locally and show GET generations returns it as latest with trigger
"applied".

No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave20-REPORT.md (this worktree).
