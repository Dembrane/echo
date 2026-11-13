/**
 * The project context as a prompt carries it (ECHO-1055). `project.context` is the host's
 * own text and has no length limit: hosts paste agendas, invitations and whole briefs. It
 * is read into about ten prompts (the assistant's first turn, chat, chat and conversation
 * summaries, Explore replies, reports, canvas, the map's titles and fact-checks, Verify and
 * the outside agents' project tool), so every one of them takes it through this budget.
 * The stored text is never changed: only what a prompt reads is cut.
 *
 * A context within the budget comes back exactly as stored, byte for byte. A longer one is
 * cut at the last paragraph, line or sentence end inside the budget, so a prompt never ends
 * on half a word; only when there is no such boundary in the last part does it cut at a
 * space, and only when there is no space at all does it cut at the budget itself.
 *
 * The frontend says the same in a quiet note under the field past the same number of
 * characters (LONG_CONTEXT_CHARS in ProjectContextInput.tsx).
 */

/** Most characters of project context a prompt reads. */
export const PROJECT_CONTEXT_BUDGET = 4_000;

/** A boundary earlier than this share of the budget wastes too much; look for a space. */
const MIN_KEEP = 0.6;

/** The end of a sentence: a full stop, question or exclamation mark, then a space or line end. */
const SENTENCE_END = /[.!?…](?=[\s"'”’)\]])/gu;

/**
 * The context for a prompt: null for no context, the stored text when it fits the budget,
 * otherwise its start cut at a paragraph, line or sentence boundary.
 */
export function contextForPrompt(
  raw: unknown,
  budget: number = PROJECT_CONTEXT_BUDGET,
): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length <= budget) return raw;
  return cutAtBoundary(raw, budget);
}

/** `text` cut to at most `budget` characters at the best boundary inside it. */
export function cutAtBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, budget + 1);
  const floor = Math.floor(budget * MIN_KEEP);
  // A paragraph, then a line break: the cut lands after the previous line's text.
  for (const sep of ["\n\n", "\n"]) {
    const at = head.lastIndexOf(sep, budget);
    if (at >= floor) return head.slice(0, at).trimEnd();
  }
  // A sentence end inside the budget, its punctuation kept.
  let sentence = -1;
  for (const m of head.slice(0, budget).matchAll(SENTENCE_END)) sentence = m.index + m[0].length;
  if (sentence >= floor) return head.slice(0, sentence).trimEnd();
  // A space: never half a word.
  const space = head.search(/\s\S*$/u);
  if (space >= floor) return head.slice(0, space).trimEnd();
  // One unbroken run: the budget itself, never half a surrogate pair.
  let end = budget;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
