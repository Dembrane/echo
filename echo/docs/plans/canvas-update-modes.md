# Canvas update modes: what "update the canvas" should actually mean

Research note, 2026-07-08. Evidence: the 13th-week retrospective session
(project fcdb3a85, report 11 "Wednesday Check in", chat 431338d7): 12 brief
revisions in ~100 minutes, brief size swinging 336 -> 3368 -> 988 -> 1758
chars, oscillating between clean instructions and full content snapshots.
Every host intent was forced through one channel: full brief replacement.

## What hosts actually said, sorted by what they meant

Reading every update request from the live session, four distinct intents:

1. SHAPE - "add an Open Issues section", "person-by-person cards",
   "include the goal and key terms". The canvas's durable structure.
   Changes rarely. Wants: revise (clean rewrite), small, stable.
2. PIN - "add Cesare's reflection", "Jorim's comment on it", "hearts per
   person: Jorim rational red, emotional green...". Point-in-time content
   the room produced: judgments, statuses, decisions. Gathering cannot
   reproduce these (they are interpretations, not transcript text). Wants:
   APPEND, itemized, individually removable. THIS is the missing mode -
   without it the agent stuffed pins into the brief, which is why the brief
   bloated and the canvas stopped feeling alive.
3. LENS - "focus on individual reflections", "strip the tooling talk and
   the check-in framework". What to gather and what matters. Instructions,
   revise-mode, but distinct from shape.
4. TASTE - "no dividers", "smaller heading", "generous spacing". Standing
   presentation constraints. Append-with-dedup (already exists as standing
   edits from editCanvas, wave 25).

## The model

Split the single brief into two config surfaces plus the existing two:

- SKELETON (shape + lens): the durable instruction set. Replace-mode with a
  hard norm: rewritten clean on every revision, target under ~1000 chars,
  never contains gathered or pinned content. Revision history as today.
- PINBOARD: an append-only ledger of pinned items on the canvas config
  (id, text, optional person/label, pinned_at, source chat/message id).
  Chat verbs: pin (append), unpin (remove by reference), amend (replace one
  item). The generation contract: render every pinned item faithfully in
  the appropriate section, weave gathered live data around them. Pins
  survive refreshes by definition; no more brief bloat.
- STANDING EDITS (taste): as shipped in wave 25, folded into the skeleton
  on the next clean rewrite.
- DIRECT EDIT: one-shot surgical HTML change (wave 25), for wording or
  removing an element right now.

Chat mapping: proposeCanvas revises the skeleton (proposal card);
pinToCanvas/unpinFromCanvas act immediately like editCanvas does (a pin is
the host's own content, stated in the chat - no proposal ceremony), each
echoed in one sentence. The wall shows pins on the next nudge.

## Why this is the experience fix

In the retro, "add the hearts" should have been: agent pins six one-line
statuses -> wall shows them within seconds -> loop keeps refreshing live
reflections around them. Instead it was: rewrite a 3k brief -> proposal ->
apply -> full regeneration -> hope. The pinboard makes the wall feel like a
shared surface the room writes on, while the loop stays the narrator of
live material.

## The recipe loop (owner's meta-ask)

Once pins exist, "research in the chat -> results on the canvas -> extract
a recipe" becomes a natural methodology: ask the question in chat, pin the
findings as they emerge, let the loop keep live context around them, then
extract the way-of-working as a methodology (the agent already suggests
extraction after substantial artifacts). Tonight's retrospective is the
first recipe candidate: seeded as a draft "live retrospective wall"
methodology on echo-next for the team to edit.

## Decision needed (owner)

1. Ship the pinboard as designed (recommended)?
2. Pin verbs act immediately vs. behind proposal cards?
3. Should pins expire with the canvas or outlive it (my lean: they live in
   config revisions like everything else, so they archive with the canvas)?
