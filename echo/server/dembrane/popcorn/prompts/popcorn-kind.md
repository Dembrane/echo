# Popcorn kind

Version: `popcorn-kind-v3`

You are given one transcript of a conversation and one short phrase that was
extracted from it for a live screen. Say what the contribution the phrase
paraphrases was doing in the conversation. Find the moment in the transcript
first and judge from the surrounding conversation, not from the phrase's
wording: the phrase has no punctuation and no speaker, and a compressed
phrase often sounds more directive than the contribution was.

## Type

Exactly one. Apply the tests in this order and stop at the first that holds;
observation is what remains.

- `decision`: the room committed to a choice. Support or enthusiasm is not a
  commitment.
- `objection`: its central purpose is to challenge something already on the
  table: a proposal, an assumption, a framing, the tool. Reporting harm is
  not objecting: "recording inhibited me" reports an experience; "that's why
  we shouldn't record exploration" challenges a practice.
- `question`: seeks information or leaves a substantive choice open, and
  offers no option. "Could we record only the synthesis?" offers a specific
  option, so it is an idea despite the question form.
- `practice`: offers a method that already exists somewhere: it has a name
  (one-two-four-all, five whys), or a place where it is done ("the way he did
  it", "in my work we", "they always sit in circles"). "Leaders speak last" is
  a practice.
- `idea`: offers something new to try, with a how: an action, a method or an
  option the speaker is proposing rather than reporting. "Perhaps record the
  synthesis after an unrecorded conversation."
- `need`: identifies a desired condition or a principle, without saying how
  to reach it. "Quiet people need space" is a need; "let everyone think
  individually before pairing up" is a method.
- `distinction`: sets two named things apart that were being treated as one:
  "X rather than Y", "X is different from Y", "there's the individual and the
  emergent", "a personal angle and a power angle". A distinction whose central
  purpose is to challenge something on the table is an objection.
- `observation`: says how things are, reported or explained, and does none
  of the above. "Being recorded stops me speaking in first draft." "The
  organisation knows more than it knows it knows."

## Qualifiers

Zero or more, kept separate from the type:

- `tentative`: offered with hedging ("this is just an idea", "maybe", "I'm
  wondering").
- `personal_experience`: reported in the first person about the speaker's own
  situation.
- `not_implemented`: something agreed or planned before and never done.

## Also return

- `question_form`: true when the phrase, read aloud, would end with a question
  mark. A phrase can be a question in form and an idea or objection by type.
- `target`: for an objection only, what it objects to, in at most eight
  words ("the summary's framing of theme one"); otherwise empty.
- `reason`: one sentence naming the moment in the transcript that decided the
  type, written without personal names (say "a participant"), because it may
  be shown on the screen.

Return only the structured output requested by the caller.
