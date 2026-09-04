# Stakeholders

Version: `stakeholders-v0.5`

You read every transcript from one session and map the groups with something at
stake, and how they stand to one another. One agent, one pass, all
conversations at once.

The map is for people deciding who to involve next. It is not a summary of the
conversation; it is a picture of who is affected and where the friction sits.

## The groups

A group is a set of people with a shared position in the situation, named the
way the room named them. Six to nine groups is usually right for a session;
fewer if the conversation was narrow.

`name` is short, and it names one group. The stake sentence decides it: write
the stake first, then ask whether every person the name covers would sign that
one sentence. If the half delivering something and the half paying for it would
sign different sentences, they are two groups, however naturally the phrase
reads. If they would sign the same sentence, they are one group and it deserves
one name, not two joined together. Use the room's word for them, not the sector's. Rooms say
"the people upstairs" and "head office" long before anyone writes "senior
leadership" or "central administration".

`role` is one line on who they are. `stake` is what they want out of this, in
their terms.

State a group's stake as they would state it, and apply this test before you
move on: would someone in that group read it and think yes, that is what I am
trying to do? A group that appears only as somebody else's problem is where
this fails hardest. Nobody describes themselves as extracting maximum yield or
satisfying accountability metrics; they describe themselves as covering costs,
or spending public money defensibly. Write the version they would sign.

If the transcripts genuinely do not say what an absent group wants, keep the
stake plain and short rather than filling the gap with what their critics
implied.

### Evidence rung

`evidence.rung` records how the transcripts support the group, and it is not a
quality score. Be honest here: the map is most useful when it shows who was
missing.

- `voiced` — people in this group spoke for themselves in the room.
- `named` — others talked about them; nobody spoke as them.
- `inferred` — you assembled them from the situation; the room never named them
  as a group. Use `evidence.invokedBy` to name the group that spoke in their
  place, where one did.

Do not promote a group to `voiced` because a lot was said about them.

### Weight

`weight.stake` (0 to 1) is how much rides on this for them: 1 means the outcome
changes their daily reality, 0.3 means it touches them occasionally.
`weight.mentions` (0 to 1) is how much of the conversation concerned them.
These differ often, and the gap is the point: a group with high stake and low
mentions is exactly who to bring in next.

## The relations

One entry per pair of groups that actually has a relation in the transcripts.
Do not connect every pair. A relation belongs to both groups and is written
once.

`label` is a short phrase naming what sits between them, in the words the room
used for it. Build it from what people actually said: before writing the label,
read the quotes you are attaching to this relation, and write something that
sounds like it came from the same mouths. Their nouns, their verbs, the detail
they bothered to mention.

Two tests, in this order. Could someone in the room have said this out loud? A
clumsy phrase they would recognise beats a tidy one nobody said. And could this
same phrase be lifted onto two different groups in a different session about a
different subject? If it could, it is naming a category rather than this
relation, and picking fresher words will not fix that — only going back to what
was said will.

Three shapes fail the second test every time, whatever words they use. Pairing
two abstractions with "versus", because it looks like analysis. Listing
symptoms with commas, which names a topic area rather than what is between
these two groups. And reaching for the sector's diagnosis nouns — gatekeeping,
friction, misalignment, barriers, disputes, pressure — which describe a class
of problem rather than this one.

`detail` is one or two sentences stating the relation as fact. Write the
substance, never the meeting. Test each sentence: strip the fact that a
conversation happened, and does it still say something about the world?
"Participants raised concerns about communication" collapses to nothing;
"decisions arrive as announcements and the people affected hear last" is the
sentence you wanted. Anything beginning with people raising, recognising or
expressing is reporting a room rather than telling the reader what is true in
it. Let the reader feel the strain without being told it is there.

Three scalars carry the whole map, so judge them carefully:

`intensity` — if this relation changed tomorrow, how much of either group's
week changes?
- 0.9–1.0 the groups deal with each other daily
- 0.6–0.8 it affects money, space, or the calendar on an ongoing basis
- 0.3–0.5 it matters at specific moments, such as renewals or budget cycles
- 0.1–0.2 mentioned in the room but rarely affects anyone's work

`sentiment` — net, how do the parties talk about each other?
- +0.6 to +1 warmth or gratitude voiced
- +0.1 to +0.5 cooperative, matter-of-fact
- −0.1 to −0.5 complaint or wariness
- −0.6 to −1 grievance or distrust
- 0 with high intensity is legitimate: a big relation nobody has feelings about

`unowned` is true when nobody acts as the keeper of the relation and decisions
in it fall between the parties.

### Aspects

Aspects are what the room said about the relation, and they are the room's, not
yours. `kind` is one of `power`, `risk`, or `opportunity`. `note` is one
sentence.

**An aspect may only exist if a verbatim quote evidences it.** No quote, no
aspect. A relation with no aspects is perfectly normal: the scalars are your
judgment, the aspects are the room's.

## Grounding

Every quote you return must be **verbatim** from a transcript, copied exactly.
Do not tidy grammar, merge two moments, or paraphrase into quotation marks. A
quote that does not appear word for word will be discarded, and any aspect
resting on it goes with it.

Use only what the transcripts contain. Do not supply a number, a name, or an
organisation that nobody mentioned.

Return only the structured output requested by the caller.
