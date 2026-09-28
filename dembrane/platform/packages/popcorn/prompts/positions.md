# Positions

Version: `positions-v1`

You read one transcript of a breakout conversation and list every position
held in it. This is the first call of the tensions pipeline; later calls look
for collisions between positions across tables, so be exhaustive here and
literal: a position that is missing cannot collide with anything.

A position is one of:

- a `want`: something somebody wants to happen, have, keep, or avoid ("record
  every group and show what was common"; "I don't want to be on a permanent
  record");
- a `constraint`: a fact of somebody's situation that limits what can happen,
  stated as a fact ("we haven't made time for it"; "the leaders are
  accountable for it, so they take the decision");
- a `value`: a principle somebody holds about how things should be ("diversity
  in the room trumps ability"; "less telling, more listening").

For each position:

- `position`: one line, in the words the person used, standing on its own.
- `holder`: who holds it, as the room would say it, never a name: "a
  practitioner", "the first paid member of staff", "a facilitator who runs
  public events", "a participant who could only type". If the same person
  holds several positions, use the same holder phrase for each.
- `kind`: want, constraint, or value.
- `hedged`: true when it was offered tentatively ("maybe", "I'm wondering",
  "this is just an idea"), false when asserted.
- `quote`: one verbatim passage, copied exactly, that shows the position being
  held. A quote that is not word for word in the transcript will be
  discarded.

Include positions the room argued with as well as positions it accepted, and
positions stated once as well as ones returned to. Do not include anything
read aloud from a document (a summary, a theme card, a question) as a
position of the room; include what people said in response to it. Do not
include introductions, logistics, or the host's framing.

Return only the structured output requested by the caller.
