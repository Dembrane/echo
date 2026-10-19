import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { Models } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type { Sentence } from "./final";

/** A sentence with the id the editor must give back, and the times that never change. */
export interface EditStats {
  readonly sentences: number;
  /** Sentences whose text the editor changed and the guard let through (casing and punctuation count). */
  readonly edited: number;
  /** Wording changes kept inside sentences: a key term spelled, a word moved a letter or two. */
  readonly changedWords: number;
  /** Wording changes the guard put back, plus answers with an id the editor was not given. */
  readonly rejected: number;
  /** Batches that failed and were left as Whisper wrote them. */
  readonly failedBatches: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const BATCH = 30;
const CONTEXT = 3;

// The model sees the sentences as a numbered list and answers with the same ids; it never
// sees or changes a time. The rules are why the output stays a transcript and not a rewrite.
const SYSTEM = `You correct a speech-to-text transcript. You get numbered sentences; some are only context.
Return every sentence you were asked to correct, with its id, in the same order.
Edit only inside a sentence: spell the key terms the way they are listed, fix words that are clearly misheard given the sentences around them, and fix casing and punctuation.
Never merge, split, move, add, drop or translate a sentence. Keep the language of each sentence: the speakers switch between languages, and a sentence in Dutch stays Dutch.
Never answer, summarise or explain. If you are unsure, return the sentence unchanged.`;

const SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, text: { type: "string" } },
        required: ["id", "text"],
      },
    },
  },
  required: ["sentences"],
} as const;

const core = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .replace(/^'+|'+$/g, "");

/** Character edit distance between two words. */
export function charDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] as number;
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return row[b.length] as number;
}

/**
 * How far one word may move to another. Two letters at most, and never more than a third of
 * the longer word: a word of six letters or more may lose two (a spelling slip), three to five
 * letters one, and a word of one or two letters none, since those are the small grammar words
 * (ze and hij, a and an) whose swap changes who did what. Every edit that broke a sentence in
 * the audit was a short word swapped, a word added, or several words rewritten as one.
 */
export const maxWordDistance = (a: string, b: string) =>
  Math.min(2, Math.floor(Math.max(a.length, b.length) / 3));

export interface GuardResult {
  readonly text: string;
  /** Wording changes kept: a word spelled as a key term, or moved by a letter or two. */
  readonly kept: number;
  /** Wording changes refused and put back as Whisper wrote them. */
  readonly refused: number;
}

/**
 * Takes the editor's sentence and keeps from it only what a text pass is for. Casing and
 * punctuation are always kept. A changed word is kept when it is spelled as a key term (or
 * words that join into one, like "dem brane" and Dembrane, within half the term's length),
 * or when it is within maxWordDistance of the word it replaces. Anything else (a word
 * added or dropped, several words rewritten, a swap of a small word) is put back as it was.
 */
export function guardEdit(
  before: string,
  after: string,
  keyTerms: readonly string[] = [],
): GuardResult {
  const terms = new Set(keyTerms.map((k) => core(k.replace(/\s+/g, ""))).filter(Boolean));
  const B = before.split(/\s+/).filter(Boolean);
  const A = after.split(/\s+/).filter((t) => core(t));
  const bc = B.map(core);
  const ac = A.map(core);
  // Alignment on words that are equal ignoring casing and punctuation (longest common subsequence).
  const n = B.length;
  const m = A.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        bc[i] === ac[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
  const out: string[] = [];
  let kept = 0;
  let refused = 0;
  const block = (bs: number, be: number, as: number, ae: number) => {
    const bw = B.slice(bs, be);
    const aw = A.slice(as, ae);
    if (!bw.length && !aw.length) return;
    const bj = bc.slice(bs, be).join("");
    const aj = ac.slice(as, ae).join("");
    if (bj === aj) {
      out.push(...aw); // only spaces or hyphens moved
      if (terms.has(aj)) kept++;
      return;
    }
    if (terms.has(aj) && charDistance(bj, aj) <= Math.ceil(aj.length / 2)) {
      out.push(...aw);
      kept++;
      return;
    }
    if (bw.length === aw.length) {
      bw.forEach((b, k) => {
        const a = aw[k] as string;
        const x = bc[bs + k] as string;
        const y = ac[as + k] as string;
        if (charDistance(x, y) <= maxWordDistance(x, y)) {
          out.push(a);
          kept++;
        } else {
          out.push(b);
          refused++;
        }
      });
      return;
    }
    out.push(...bw);
    refused++;
  };
  let i = 0;
  let j = 0;
  let bs = 0;
  let as = 0;
  while (i < n || j < m) {
    if (
      i < n &&
      j < m &&
      bc[i] === ac[j] &&
      (lcs[i] as number[])[j] === ((lcs[i + 1] as number[])[j + 1] as number) + 1
    ) {
      block(bs, i, as, j);
      out.push(A[j] as string);
      i++;
      j++;
      bs = i;
      as = j;
    } else if (
      j < m &&
      (i >= n || ((lcs[i] as number[])[j + 1] as number) >= ((lcs[i + 1] as number[])[j] as number))
    )
      j++;
    else i++;
  }
  block(bs, n, as, m);
  return { text: out.join(" "), kept, refused };
}

export interface EditInput {
  readonly language?: string | null;
  readonly keyTerms?: readonly string[] | null;
}

export interface Proposals {
  /** The model's text for each sentence, or null where it gave none (failed batch, missing or foreign id). */
  readonly proposals: (string | null)[];
  readonly failedBatches: number;
  /** Answers with an id the editor was not given, a repeated id or no text. */
  readonly strayIds: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The model's side of the text pass: what it would write for each sentence, before any guard. */
export async function proposeEdits(
  models: Models,
  sentences: readonly Sentence[],
  input: EditInput,
  logger: Logger,
): Promise<Proposals> {
  const proposals: (string | null)[] = sentences.map(() => null);
  let failedBatches = 0;
  let strayIds = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const terms = input.keyTerms?.length
    ? `Key terms, spelled exactly like this: ${input.keyTerms.join(", ")}.`
    : "No key terms are given.";
  for (let from = 0; from < sentences.length; from += BATCH) {
    const to = Math.min(from + BATCH, sentences.length);
    const lines = [
      terms,
      input.language ? `Main language of the project: ${input.language}.` : "",
      "",
      "Context only, do not return:",
    ];
    for (let i = Math.max(0, from - CONTEXT); i < from; i++)
      lines.push(`${i}: ${sentences[i]?.text}`);
    lines.push("", "Correct these:");
    for (let i = from; i < to; i++) lines.push(`${i}: ${sentences[i]?.text}`);
    try {
      const r: LanguageModelV4GenerateResult = await models.model("text_fast").doGenerate({
        prompt: [
          { role: "system", content: SYSTEM },
          { role: "user", content: [{ type: "text", text: lines.join("\n") }] },
        ],
        responseFormat: { type: "json", schema: SCHEMA as never },
        providerOptions: { openaiCompatible: { reasoningEffort: "none" } },
      });
      const usage = r.usage as unknown as {
        inputTokens?: { total?: number };
        outputTokens?: { total?: number };
      };
      inputTokens += usage?.inputTokens?.total ?? 0;
      outputTokens += usage?.outputTokens?.total ?? 0;
      const raw = r.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const parsed = JSON.parse(raw) as { sentences?: { id?: unknown; text?: unknown }[] };
      if (!Array.isArray(parsed.sentences)) throw new Error("no sentences in the answer");
      const seen = new Set<number>();
      for (const e of parsed.sentences) {
        const id = Number(e.id);
        if (
          !Number.isInteger(id) ||
          id < from ||
          id >= to ||
          seen.has(id) ||
          typeof e.text !== "string"
        ) {
          strayIds++;
          continue;
        }
        seen.add(id);
        proposals[id] = e.text.replaceAll("\u0000", "").trim();
      }
    } catch (err) {
      failedBatches++;
      logger.warn(
        { err: (err as Error).message, from, to },
        "text pass failed for a batch; Whisper's words stay",
      );
    }
  }
  return { proposals, failedBatches, strayIds, inputTokens, outputTokens };
}

/** The guard over every proposal: sentences keep their ids and times and take only what guardEdit lets through. */
export function applyProposals(
  sentences: readonly Sentence[],
  p: Proposals,
  keyTerms: readonly string[] = [],
): { sentences: Sentence[]; stats: EditStats } {
  const out = sentences.map((s) => ({ ...s }));
  let edited = 0;
  let changedWords = 0;
  let rejected = p.strayIds;
  sentences.forEach((s, i) => {
    const proposal = p.proposals[i];
    if (!proposal || proposal === s.text.trim()) return;
    const g = guardEdit(s.text, proposal, keyTerms);
    changedWords += g.kept;
    rejected += g.refused;
    if (g.text.trim() !== s.text.trim()) {
      (out[i] as Sentence) = { start: s.start, end: s.end, text: g.text };
      edited++;
    }
  });
  return {
    sentences: out,
    stats: {
      sentences: sentences.length,
      edited,
      changedWords,
      rejected,
      failedBatches: p.failedBatches,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
    },
  };
}

/**
 * One text pass over a transcript's sentences. The result has the same sentences in the same
 * order with the same times; only text inside a sentence can differ, and only by what the
 * guard accepts. A batch that fails (the model errors, or answers without parseable ids)
 * stays as Whisper wrote it, so the pass can only improve a transcript or leave it alone.
 */
export async function editSentences(
  models: Models,
  sentences: readonly Sentence[],
  input: EditInput,
  logger: Logger,
): Promise<{ sentences: Sentence[]; stats: EditStats }> {
  return applyProposals(
    sentences,
    await proposeEdits(models, sentences, input, logger),
    input.keyTerms ?? [],
  );
}
