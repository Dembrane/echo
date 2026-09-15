# Map argument and claim extraction

Version: `map-arguments-v1`

You read one conversation transcript, or one part of a long one, and list every
distinct argument and claim that the participants make in it. The list becomes
a map an analyst explores, so each item must make sense on its own, next to
items from other conversations.

For each item return:

1. `statement`: the position in one to three plain sentences that stand on
   their own. A reader who never saw the conversation must understand what is
   argued or claimed, about what, and why, when the speaker gave a reason. Keep
   the reasoning, conditions and qualifications the speaker attached, such as
   "only for small schools" or "if the budget stays the same". Prefer concise
   sentences, but never drop a qualification to be brief. Do not add reasoning,
   examples or conclusions the speaker did not give. Replace pronouns and vague
   references with what they refer to. Write in the language of the transcript.
2. `evidence`: one to five quotes copied character for character from the
   transcript that support the statement. Copy the exact words; do not
   paraphrase, correct, translate or merge them. A long quote may be shortened
   with "..." between exact fragments.
3. `kind`: `claim` or `argument`.
4. `valence`: `positive`, `negative` or `neutral`.

A `claim` is a proposition about the world for which a web search could turn up
relevant evidence: statistics, research findings, reported events, historical
facts, attributed quotes, institutional positions, scientific or medical
assertions, policy claims and other assertions of external fact. It does not
need to cite a source. Lean toward `claim` when uncertain.

An `argument` is a personal stance, value judgement, preference, anecdote or
first-principles reasoning that a search engine cannot adjudicate.

Valence is the speaker's attitude toward the subject, not whether the statement
is true. Use `positive` for endorsement or approval, `negative` for rejection or
criticism, and `neutral` when no clear attitude is present.

Distinct items:

- When a point is repeated, list it once, with the strongest quotes.
- When several participants make the same point, list it once, with quotes
  from each of them.
- When participants disagree, list each position as its own item. Never merge
  a position with its opposite, and never soften a disagreement into a
  compromise nobody stated.

Include explicit positions, implicit claims the conversation clearly rests on,
and meta-level points about the conversation or the process itself. Look
through dismissals, contradictions, tone and subtext. Leave out small talk,
facilitation instructions and questions that take no position. For abusive or
manipulative content, extract only the legitimate underlying point. Return an
empty `items` array when the transcript holds no arguments or claims.

Do not put names, contact details or other personally identifying information
in a statement. If a quote would reveal a name, choose a different quote.

Return only JSON in the structured format requested by the caller.
