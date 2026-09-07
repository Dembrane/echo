# Popcorn ontology

Version: `popcorn-ontology-v1`, September 5th 2026.

A popcorn is a phrase on a screen with no punctuation and no speaker, so the
room cannot tell from the phrase alone whether it was a question, a proposal,
a complaint, a method somebody uses, or a thing the room agreed. The
extractor's "faithful status" rule asks it to preserve that, and the human
rubric scores it, but the screen had no way to show it. This ontology gives
each popcorn a kind, each kind a Phosphor icon, and the icon goes in front of
the phrase. It was built in two diamonds against the Insight Loop corpus: the
108 phrases of the fable benchmark (61 tier A, 47 tier B), Astra's 90 with
their status field, and the 94 phrases of the v1.4 and v1.5 runs.

## Diamond one: what kinds of thing are popcorns?

### Discover (diverge)

Every distinct thing a speaker was doing when a benchmark phrase was said,
with an example from the corpus:

| what the speaker was doing | example |
|---|---|
| asking an open question and leaving it open | Collective intelligence accessible, for what; At what stage, if at all, do you introduce the tool; Who holds the story, and who holds the narrative |
| floating a proposal | Separate meetings for big questions from meetings for getting stuff done; Record every group, then show what the other rooms talked about; Don't record the conversation, record the move to synthesis |
| describing a practice from elsewhere | Leaders speak last; A leader's face steers the room: stay deadpan to every idea; Sit in a circle, no head of the table; Ask why five times |
| describing a practice they use | One-two-four-all, so the first speaker doesn't dominate; Plenary feedback is so often biased (so I don't do much of it) |
| pushing back on a claim, a framing, or the tool | The trade-off we were given is a false binary; An action list is not the summary of a conversation; What is this black box telling us which trade-off to discuss; Swift decisions are only a small part of what hierarchy does |
| stating how things are | The organisation knows more than it knows it knows; As soon as a leader speaks, everybody follows; Records of everything that's happened, but not joined up |
| admitting something in the first person | Being recorded has a chilling effect when you speak in first draft; We never made time for it; We struggle more with accountability than with emergent ideas; Two volunteers knew what was going on, and it went with them |
| naming what has to be true first | People have to feel safe before they'll share what they know; Decide you value it, and then there's time for it; Clarity of purpose, and making time: that's the combination |
| naming a pull between two things | The elephant in the room is time: productivity versus intrinsic value; Push people to share, or make sharing part of the work routine |
| drawing a distinction that changes the question | Separate decision making from decision taking; Probably more about creating collective intelligence than accessing it; A personal angle and a power angle |
| stating a principle or value | Diversity in the room trumps the ability of the people in it; Less telling, more listening; Perfect is not the game here; Right when it preserves the beauty, integrity and diversity of the whole |
| reporting a position the room reached | Some meetings for thinking and reflecting, others for getting things started (T8: "we've said") |
| warning of a risk | Metrics turn sharing into something performative; How it's used will support trust over time, or erode it |
| commenting on the conversation itself | We've talked about the concepts and not about actions; Theme two was us |
| provenance rather than act | a chat line read aloud; a sentence the recording cut off; a document read aloud |

Fifteen. Astra's status field, made independently, lands on much the same
list: participant_position, open_question, tentative_proposal,
practice_endorsement, explicit_rejection, first_person_experience,
action_shaped_need, reported_practice, unimplemented_prior_proposal,
qualified_argument, personal_heuristic, read_out_chat, unfinished_position,
tentative_observation, unresolved_single_voice.

### Define (converge)

What the icon is for decides what the categories are. It is for the room, at
a glance, so that a floated idea is not read as a decision and a question is
not read as a claim. That is a distinction between what the speaker was
doing, not between what the phrase is about. Four tests, applied to every
candidate category:

1. **Speech act, not topic.** "Tension" and "reframing" and "principle"
   describe what a claim is about or how it is shaped; they are claims. Out as
   categories, kept as words in the definition of claim.
2. **Not provenance.** A chat line read aloud, a cut-off sentence, a document
   read aloud: those are facts about where the words came from, and the
   extractor already handles the last one by exclusion. Out.
3. **A small model can tell them apart from the transcript.** Each category
   needs surface cues (a question form; "we should", "what if"; "I", "we
   haven't"; "you've got to", "before"; "I don't think", "false") that the
   transcript carries.
4. **The room would agree.** The person who said it should recognise the
   icon as what they were doing.

Warning of a risk fails test 1 (a conditional claim). Commenting on the
conversation is rare and reads as a claim about the room. Practice from
elsewhere and practice they use are one act with a provenance difference,
which the recommendations prompt tracks in `why`; on a screen they are one
icon.

## Diamond two: which set, and which icons?

### Develop (diverge)

Three candidate sets tested against tier A.

**Four** (question, idea, claim, practice). Too coarse: objection and
admission fall into claim, and those are the corpus's two most valuable
kinds. "The trade-off we were given is a false binary" as a claim loses the
fact that the room was pushing back on the screen.

**Twelve** (every row of the discover table that passed test 2). Twelve
icons is a legend nobody reads from the back; and tension, reframing,
principle and warning are shapes of claim, so a model assigning them is
sorting by topic, which is what test 1 forbids.

**Eight** (below). Every tier A phrase lands in exactly one with the
priority rule, and the two acts that matter most on this corpus, objection
and admission, keep their own icon.

Edge cases that decided the priority rule:

| phrase | acts present | kind |
|---|---|---|
| We never made time for it, and making time is step one | admission, condition | admission: the confession is what the room recognises |
| Can't keep generating good ideas and expect somebody else to follow through | claim, admission in context | claim: the phrase itself is not first person |
| Interested in the experiment, not convinced a tech solution is needed | objection, admission | objection: the pushback is the act |
| Is recording worse than the other inhibitions, and does anonymising change it | question, objection | question: it opens rather than rejects |
| Some meetings for thinking, others for getting things started | idea, agreement | agreement in T8 ("we've said"), idea in T3 ("I'm wondering") |
| Leaders speak last | practice, idea | practice: described as a method, from elsewhere |
| Decide you value it, and then there's time for it | condition, principle | condition: it names what must be true first |
| Separate decision making from decision taking | claim (reframing) | claim |
| Being recorded has a chilling effect when you speak in first draft | admission, claim | admission: first person, costs the speaker |

### Deliver (converge)

Eight kinds. When more than one applies, the first in this order wins; the
more specific act beats the more general, and claim is the default.

| kind | icon (Phosphor) | the speaker was | cues | example |
|---|---|---|---|---|
| `agreement` | `check-circle` | reporting a position the room reached | "we've said", "we agreed", "so we'll", the group restating one line | Some meetings for thinking and reflecting, others for getting things started |
| `objection` | `hand-palm` | pushing back on a claim, a framing, or the tool | "I don't think", "false", "not convinced", "questionable", "is it saying" | The trade-off we were given is a false binary |
| `question` | `question` | asking something and leaving it open | question form; "for what", "at what stage", "who holds" | Collective intelligence accessible, for what |
| `admission` | `hand-heart` | saying something first person that costs them: what we have not done, how I feel, what we struggle with | "I", "we haven't", "we struggle", "for me" | Being recorded has a chilling effect when you speak in first draft |
| `idea` | `lightbulb` | floating a proposal, however tentatively | "what if", "we should", "maybe", "could be" | Separate meetings for big questions from meetings for getting stuff done |
| `practice` | `wrench` | describing a method, their own or from elsewhere | a named method; "they always", "I use", "the way X did it" | Leaders speak last |
| `condition` | `key` | naming what has to be true first | "you've got to", "before", "needs", "step one" | People have to feel safe before they'll share what they know |
| `claim` | `eye` | stating how things are, a distinction, a principle, a pull between two things | everything else | The organisation knows more than it knows it knows |

The icons are Phosphor regular weight, MIT, inlined as SVG paths in
`assets/app.js` so the deck stays a single file that works without a network.

### The question mark

The extractor strips terminal punctuation, and the gate fails a phrase that
keeps it, because a stray full stop on a projector looks like a typo and a
stray question mark turns a claim into a doubt. That rule stays. The kind
carries what the punctuation carried: a `question` popcorn is drawn with its
question mark restored on the screen, from the phrase's own form, and the
icon says the same thing twice for the back of the room.

## Where the kind comes from

`tools/classify_popcorn.py` assigns a kind to each phrase of an existing run
with one model call per phrase, the transcript in view, using
`PROMPTS/popcorn-kind.md`. It writes `kinds.json` beside the run and can
apply the kinds to a deck's data folder. The extractor prompt can carry the
same field later; keeping the two calls apart for now means the kind is
judged on its own, which is the whole point of one judgement per call.

## First run, September 5th 2026

`tools/classify_popcorn.py` over the 49 phrases of `popcorn-v1.5-insight-loop`,
one call each: claim 26, idea 5, practice 5, objection 4, condition 4,
question 3, admission 2, agreement 0; two phrases in question form.

Reading the assignments against the transcripts: the seven specific kinds
fire where they should (the four objections are the room's four pushbacks;
the five practices are the Mandela methods and one-two-four-all; the two
admissions are the chilling effect and "we haven't made time for it").
Three are arguable: "Turning ideas into which of these ideas are happening"
as condition where the room stated it as what they do; "Bring out what
people know but do not know they know" as condition where it is closer to a
need; "Creating collective intelligence rather than just accessing it" as
objection, which is defensible (the speaker was pushing back on the word in
the question) and would surprise the room less as a claim.

Claim takes over half, and the default absorbing that much is the thing to
watch. Two readings, not yet decided between: the corpus is practitioners
stating how things are, so half is right; or claim wants splitting into
observation (how things are) and principle (how they should be), the one
split the converge step declined. Ben's labels on this run decide it.

## Version 2, September 5th 2026, late evening: Astra's scheme adopted

Astra's answer to "are the categories MECE?" was a better ontology than the
eight above, and it is the one in use now. The eight had flattened three
axes into one list: the act, the room's status of it, and whether it was
said in the first person. Astra separates them. The type is what the
contribution is doing in the conversation; qualifications such as tentative,
personal experience, already practised or not implemented are kept apart;
provenance (a chat line read aloud, a cut-off sentence) is a third thing
and not part of either.

| type | what it does | icon (Phosphor bold) | example |
|---|---|---|---|
| `observation` | reports an experience, a situation, an event or an existing practice | `binoculars` | Being recorded stops me speaking in first draft |
| `interpretation` | explains something, connects ideas or introduces a distinction | `signpost` | Making a decision is different from taking it |
| `need` | identifies a desired condition or a principle, without the how | `key` | Knowledge needs to be somewhere everybody can access |
| `idea` | offers an action, a method or an option to consider | `lightbulb` | Perhaps record the synthesis after an unrecorded conversation |
| `objection` | challenges a proposal, an assumption or a framing, including a reason for caution | `hand-palm` | Complete data versus uninhibited honesty is a false binary |
| `question` | seeks information or leaves a substantive choice open | `question` | Who can access the data and hear it later? |
| `decision` | records an explicit choice or commitment by the room | `handshake` | none in this corpus |

How the eight map onto the seven: claim splits into observation and
interpretation (the split the converge step declined, made along a better
line than observation against principle); condition is need; admission is
observation with the personal-experience qualifier; practice is idea or
observation with the already-practised qualifier; agreement is decision.

The boundary rules are Astra's and are in `popcorn-kind.md` verbatim in
substance: reporting harm is not objecting; a condition is not a method; an
option offered with a question mark is an idea; a distinction is an
interpretation unless its purpose is to challenge; enthusiasm is not a
commitment. Two rules reach past the classifier. An objection carries its
target, so the phrase must say what is being objected to. And the
contribution is classified before it is shortened, because a compressed
phrase sounds more directive than the contribution was; our classifier reads
the transcript first and is told to judge from it, and the extractor will
carry the type itself in its next version so the phrase can be written to
read as its type.

Icons, decided with Jorim: the recommended glyphs for objection, question,
decision and idea; signpost for interpretation; key for need; binoculars for
observation, because the eye looked like the all-seeing kind (note-pencil is
the swap if binoculars reads as surveillance). Qualifiers are classified and
stored on each item and not drawn, for now. On hover the deck shows the type
and the classifier's one line on the moment, with names from the
introductions scrubbed to "a participant" before it reaches the screen.

First run of v2 over the same 49 phrases: interpretation 20, observation 9,
idea 7, need 6, objection 4, question 3, decision 0; qualifiers tentative
17, personal experience 11, already practised 4, not implemented 1 (the
monthly story-sharing). The residual moved from claim to interpretation,
which is at least a real act rather than a default; whether twenty of
forty-nine phrases are distinctions and explanations, or the classifier is
reaching for interpretation where observation would do, is the thing to read
in the reasons.

Two things to read in that first v2 run before trusting it. The same
practice landed as idea in one room (leaders speaking last, T4) and as
interpretation in another (T6, where the speaker explained the power of a
leader's timing): the boundary between "offers a method" and "explains why it
works" wants a rule. And "accessible, for what?" landed as objection with the
framing as its target, where Astra's table has it as a question; the
classifier read the challenge, which is defensible, and the tooltip carries
the target either way.

## Version 3, September 5th 2026, late evening: practice back, interpretation narrowed

The first v2 run showed two things Jorim named. The practice-against-idea
difference had become an undrawn qualifier and the room lost it; worse, the
practised methods scattered across three types (leaders speaking last as
idea in one room and interpretation in another, circles as observation,
one-two-four-all as idea with no qualifier). And observation against
interpretation was straining: "reports" and "explains" overlap in nearly
every sentence, and interpretation's wide definition made it the new
residual, twenty of forty-nine.

Version 3 keeps Astra's separation of type from qualifier and changes the
type set on those two points. Practice is a type again: offering a method
that exists somewhere (a name, or a place it is done) is a different act from
floating something new. Interpretation is narrowed to its one crisp part,
distinction: setting two named things apart, which has a visible shape and
which the rooms were proudest of. Everything else that says how things are
is observation. The already-practised qualifier goes, since practice is a
type.

| type | icon (Phosphor bold) | test, applied in this order |
|---|---|---|
| `decision` | `handshake` | the room committed |
| `objection` | `hand-palm` | its central purpose is to challenge something on the table |
| `question` | `question` | leaves a substantive choice open and offers no option |
| `practice` | `signpost` | offers a method that exists: a name, or a place it is done |
| `idea` | `lightbulb` | offers something new to try, with a how |
| `need` | `flag` | says what has to be true, without the how |
| `distinction` | `arrows-split` | sets two named things apart |
| `observation` | `binoculars` | how things are, seen or explained; what remains |

Icons decided with Jorim: flag for need (the state to reach), signpost for
practice (it points to a thing that exists), two diverging arrows for
distinction. Qualifiers stay stored and undrawn: tentative, personal
experience, not implemented.
