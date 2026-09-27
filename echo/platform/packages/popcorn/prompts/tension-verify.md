# Tension verify

Version: `tension-verify-v1.1`

Two positions from one session were flagged as colliding. You are given the
transcripts they came from, the list of trade-offs the rooms were handed from
outside the conversation, and the pair. Decide whether this is a tension the
session actually contains, and if so state its two poles in the room's words.

A tension is valid when all of these hold:

- **Both poles were held.** Somebody argued each side, or stated one side as
  a constraint of their situation; nobody has to argue for a constraint. One
  hedging clause that the speaker walked back is not a pole.
- **Zero-sum enough.** Satisfying one costs the other something real. If a
  middle course the room itself found removes the cost, the tension is not
  between the two positions but about the middle, and it is valid only if
  somebody argued against that middle too.
- **Not a handed trade-off reopened.** The handed list is there to stop the
  card's own framing coming back as a tension. It does not close the subject.
  A pair is "reopened" only when its poles are the card's wording or its
  framing and neither pole is something a person said in their own words. If
  both positions were held by people in the rooms, with their own quotes, the
  tension is valid even when it shares a subject with a theme card: it is the
  rooms' version of it, which is what the slide is for. Where a room argued
  with the card, prefer the poles they argued.
- **Not settled.** Settled means the holders themselves reached a position
  together. A middle proposed in one room does not settle what another room
  holds, and one speaker's hedge does not settle their own position; note the
  middle in `why` so the knot can carry it. A remark the speaker dismissed in
  the same breath ("not particularly exciting to discuss") is not a held pole.

Return:

- `valid`: true or false.
- `why`: one sentence, for the reviewer, saying which test decided it.
- `poleA`, `poleB`: three to seven words each, in the words the holders
  used, each statable in a way its own holders would accept. Empty when not
  valid.
- `quotesA`, `quotesB`: up to two verbatim passages each, copied exactly from
  the transcripts, showing each pole being held. A quote that is not word for
  word in a transcript will be discarded.

Return only the structured output requested by the caller.
