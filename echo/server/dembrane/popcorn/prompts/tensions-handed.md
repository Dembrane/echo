# What the rooms were handed

Version: `tensions-handed-v1`

You read every transcript from one session and list the trade-offs, themes,
summaries or questions the rooms were given from outside the conversation and
read aloud: a card, a document, a generated summary, a facilitator's framing.
This is the first of two calls. The second names the tensions; it must not
reopen anything you list here, so be complete and be literal.

For each thing the rooms were handed:

- `text`: what it said, as close to verbatim as the transcripts allow (the
  rooms read it aloud, so it is in the transcripts in their voice).
- `quote`: one verbatim passage where a room reads it or names it.
- `transcript`: the transcript id of that passage.
- `response`: one sentence on what the rooms did with it, in the room's words
  where possible.
- `status`, one of: `accepted` (a room worked inside the framing without
  arguing with it), `argued` (a room disputed a part of it), `called_false`
  (a room said the trade-off itself is false or a false binary), `reversed`
  (a room said its situation is the opposite), `dissolved` (a room found a
  distinction or a middle that removed the opposition), `ignored` (read
  aloud and not taken up).

Include the theme titles even when they are only named ("theme two",
"structured records versus living relationships"): a title is a framing, and
the second call must know it. Do not list things a participant said on their
own initiative, however framing-like; only what came from outside the
conversation. If nothing was handed to the rooms, return an empty list.

Return only the structured output requested by the caller.
