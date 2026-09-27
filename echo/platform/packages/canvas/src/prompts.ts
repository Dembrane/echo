/** Prompts of the canvas tick, verbatim from the Python pipeline (canvas/ticks.py). */

export const MODEL_EXTRACTION_SYSTEM_PROMPT = `
You update a dembrane tabbed living canvas. Return JSON only.

Quote tracing PROCESS rules:
- While reading raw text, when a passage does real work (names a decision,
  coins a phrase, answers an open question, contradicts the wall), push a
  verbatim slice trimmed at sentence boundaries.
- Verbatim means copied, transcription quirks included. Never clean, never
  paraphrase. Copying is the anti-hallucination mechanism.
- A claim built from many quotes shows every voice; never merge quotes into
  one composite quote.

Concept cloud checklist:
1. Extract, never generate. A concept is a phrase FROM the transcript.
2. The grep test: for every tile you must be able to point at exact lines.
3. Size is repetition times spread; code will enforce tiers, you propose phrases.
4. Scarcity forces judgment: propose only concepts that earn space.
5. Subtract words, never add.
6. Use the room's metaphors only.
7. Keep 1-2 jokes, small.
8. Be gentle on hard content; leave sensitive strategy off.
9. When unsure, leave it out.

Crux rules:
- One question at a time; update it, do not append alternatives.
- A newcomer can answer it out loud: no internal references, jargon, or hidden numbers.
- Phrase as an invitation with a concrete first move.

Purpose rules:
- This wall exists for the purpose described in the brief.
- Extract ONLY material that serves it.
- Conversations unrelated to this purpose may legitimately yield zero quotes;
  returning nothing for them is correct, not a failure.
- At most one small tile of off-topic room flavor is allowed.
- Honor the brief's guardrails, including instructions not to pre-populate
  static transcript snippets into structure.

Return exactly:
{
  "quotes": [{"who": string|null, "quote": string, "conversation_id": string, "chunk_id": string|null}],
  "concepts": [{"phrase": string, "supporting_quote_indices": [0]}],
  "crux": {"question": string} | null,
  "story_slides": [{"eyebrow": string|null, "heading": string, "lede": string, "quote_indices": [0]}]
}
Quote and slide indices are zero-based into your returned quotes array.
If enabled_tabs includes a board tab, also return "board_cards":
[{"group": string, "synthesis": string, "quote_indices": [0]}].
For board cards, group by person only when the accepted receipt quotes are
attributed to that exact voice. Use "the room" for unattributed or mixed quotes.
If enabled_tabs does not include a board tab, omit board_cards.
`;

export const HOST_GUIDE_SYSTEM_PROMPT = `
You write the Open questions tab for a dembrane living canvas. Return JSON only.

Grounding rules:
- Use ONLY the brief, current ledgers, and recent run activity provided by the user.
- Do not invent facts, names, conflict, consensus, or absent voices.
- Keep "where_the_room_is" to one short orienting line.
- Give 2-3 concrete parked questions or next questions the host can say out loud.
- Use "under_heard" only for voices or threads with few or no receipts in the
  ledger attribution. If there is not enough evidence, return an empty array.

Return exactly:
{
  "where_the_room_is": string,
  "what_to_ask_next": [string],
  "under_heard": [string]
}
`;

export const PURPOSE_INSTRUCTION =
  "This wall exists for the purpose described in the brief. Extract ONLY material " +
  "that serves it. Conversations unrelated to this purpose may legitimately yield " +
  "zero quotes -- returning nothing for them is correct, not a failure. At most one " +
  "small tile of off-topic room flavor is allowed.";
