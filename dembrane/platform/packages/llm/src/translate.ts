import type { Completer } from "./complete";
import type { ModelGroup } from "./models";

/**
 * Batched translation on the model groups, shared by every feature that translates short
 * texts: popcorn's room translations and the frontend catalog filler
 * (scripts/translate-catalogs.ts). The model answers `{translations: [{i, text}]}` for a
 * numbered list, so a batch that comes back short leaves only its gaps untranslated.
 */

/** The platform's languages by the code the product stores, named the way prompts say them. */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  uk: "Ukrainian",
  cs: "Czech",
};

export const TRANSLATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, text: { type: "string" } },
        required: ["i", "text"],
      },
    },
  },
  required: ["translations"],
};

export interface TranslateOptions {
  /** The instructions; the user message is the JSON payload. */
  readonly system: string;
  /** The target language as the prompt names it ("Dutch"). */
  readonly target: string;
  readonly group?: ModelGroup;
  /** Texts per call, and calls at once. */
  readonly batch?: number;
  readonly parallel?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  /** Fields sent beside `target` and `texts`, such as a glossary. */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** A note per text the model reads beside it (where the text appears, what it means). */
  readonly notes?: readonly (string | undefined)[];
  /** How the payload becomes the user message; JSON by default. */
  readonly render?: (payload: Record<string, unknown>) => string;
  /** Called after each batch with its texts and answers, in batch order within a wave. */
  readonly onBatch?: (batch: string[], answers: (string | null)[]) => Promise<void>;
  /** Told about a batch that failed; its texts come back null. */
  readonly warn?: (message: string) => void;
}

class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

function jsonObject(text: string): Record<string, unknown> {
  let cleaned = text.trim();
  if (cleaned.startsWith("```"))
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("the translation answer was not a JSON object");
  return parsed as Record<string, unknown>;
}

/** One translation per text, in order; null where the model gave none. */
export async function translateTexts(
  completer: Completer,
  texts: readonly string[],
  opts: TranslateOptions,
): Promise<(string | null)[]> {
  const size = opts.batch ?? 40;
  const parallel = opts.parallel ?? 4;
  const slots = new Slots(parallel);
  const render = opts.render ?? ((p: Record<string, unknown>) => JSON.stringify(p));
  const one = async (start: number): Promise<(string | null)[]> => {
    const chunk = texts.slice(start, start + size);
    const payload: Record<string, unknown> = {
      target: opts.target,
      ...opts.extra,
      texts: chunk.map((text, i) => {
        const note = opts.notes?.[start + i];
        return note ? { i, text, note } : { i, text };
      }),
    };
    const out: (string | null)[] = chunk.map(() => null);
    let answer: Record<string, unknown>;
    try {
      const response = await slots.run(() =>
        completer.complete({
          group: opts.group ?? "multi_modal_fast",
          system: opts.system,
          user: render(payload),
          temperature: 0,
          maxTokens: opts.maxTokens ?? 16000,
          jsonSchema: TRANSLATION_SCHEMA,
          thinkingBudget: 0,
          timeoutMs: opts.timeoutMs ?? 120_000,
        }),
      );
      answer = jsonObject(response.text);
    } catch (exc) {
      opts.warn?.((exc as Error).message);
      return out;
    }
    for (const entry of Array.isArray(answer.translations) ? answer.translations : []) {
      const e = entry as Record<string, unknown>;
      const index = e.i;
      if (
        typeof index === "number" &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < chunk.length &&
        typeof e.text === "string"
      )
        out[index] = e.text.trim() || null;
    }
    if (opts.onBatch) await opts.onBatch([...chunk], out);
    return out;
  };
  // Bounded both in flight and in scheduled work, as a long list may owe thousands.
  const results: (string | null)[][] = [];
  const wave = size * parallel;
  for (let w = 0; w < texts.length; w += wave) {
    const starts: number[] = [];
    for (let i = w; i < Math.min(texts.length, w + wave); i += size) starts.push(i);
    results.push(...(await Promise.all(starts.map(one))));
  }
  return results.flat();
}
