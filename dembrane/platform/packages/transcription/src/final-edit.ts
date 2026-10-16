import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { Models } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type { Sentence } from "./final";

/** A sentence with the id the editor must give back, and the times that never change. */
export interface EditStats {
  readonly sentences: number;
  /** Sentences whose text the editor changed and the guard accepted. */
  readonly edited: number;
  /** Changes the guard refused: too different (a paraphrase), empty, or an id it was not given. */
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

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Word-level edit distance over the longer of the two, 0 for equal text and 1 for nothing shared. */
export function editRatio(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length && !y.length) return 0;
  const row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = row[j] as number;
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        prev + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return (row[y.length] as number) / Math.max(x.length, y.length);
}

/** A change inside a sentence is kept only when it is small: a spelling, a word or two, a comma. */
export function acceptable(before: string, after: string): boolean {
  const text = after.trim();
  if (!text) return false;
  const ratio = words(text).length / Math.max(words(before).length, 1);
  return ratio >= 0.6 && ratio <= 1.5 && editRatio(before, text) <= 0.4;
}

export interface EditInput {
  readonly language?: string | null;
  readonly keyTerms?: readonly string[] | null;
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
  const out = sentences.map((s) => ({ ...s }));
  const stats = {
    sentences: sentences.length,
    edited: 0,
    rejected: 0,
    failedBatches: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const terms = input.keyTerms?.length
    ? `Key terms, spelled exactly like this: ${input.keyTerms.join(", ")}.`
    : "No key terms are given.";
  for (let from = 0; from < sentences.length; from += BATCH) {
    const to = Math.min(from + BATCH, sentences.length);
    const ctxFrom = Math.max(0, from - CONTEXT);
    const lines = [
      terms,
      input.language ? `Main language of the project: ${input.language}.` : "",
      "",
      "Context only, do not return:",
    ];
    for (let i = ctxFrom; i < from; i++) lines.push(`${i}: ${out[i]?.text}`);
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
      stats.inputTokens += usage?.inputTokens?.total ?? 0;
      stats.outputTokens += usage?.outputTokens?.total ?? 0;
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
          stats.rejected++;
          continue;
        }
        seen.add(id);
        const before = sentences[id]?.text ?? "";
        const text = e.text.replaceAll("\u0000", "").trim();
        if (text === before.trim()) continue;
        if (acceptable(before, text)) {
          (out[id] as Sentence) = { start: out[id]?.start ?? 0, end: out[id]?.end ?? 0, text };
          stats.edited++;
        } else stats.rejected++;
      }
    } catch (err) {
      stats.failedBatches++;
      logger.warn(
        { err: (err as Error).message, from, to },
        "text pass failed for a batch; Whisper's words stay",
      );
    }
  }
  return { sentences: out, stats };
}
