import { readFileSync } from "node:fs";
import { popcornShared } from "@echo/analysis";
import { assetPath } from "@echo/core";
import type { Completer, Completion } from "@echo/llm";
import { type Json, pyJson } from "../py";
import { KIND_SCHEMA, QUESTION_SCHEMA, VALIDATE_SCHEMA } from "./enrichment";
import { POPCORN_SCHEMA, STAKEHOLDERS_SCHEMA } from "./shapes";
import { AnswerError, PROMPT_NAMES as TENSION_PROMPTS } from "./tensions";
import { Semaphore, withTimeout } from "./util";

/**
 * Model calls for popcorn (popcorn model.py). The prompt files under packages/popcorn/
 * prompts are the versions in use; a prompt iteration is a new file and a new version
 * constant, never an edit in place. Every call goes through the fast multimodal group,
 * temperature 0, a JSON schema, and a timeout per kind of call.
 */

export const POPCORN_PROMPT = "popcorn-v1.7";
export const VALIDATE_PROMPT = "popcorn-validate";
const KIND_PROMPT = "popcorn-kind";
const QUESTION_PROMPT = "popcorn-question";
const STAKEHOLDERS_PROMPT = "stakeholders-v0.9";
const TRANSLATE_PROMPT = "popcorn-translate";

/** Every prompt file a tick reads, for the boot check of the app that runs ticks. */
export const POPCORN_TICK_ASSETS: readonly string[] = [
  POPCORN_PROMPT,
  VALIDATE_PROMPT,
  KIND_PROMPT,
  QUESTION_PROMPT,
  STAKEHOLDERS_PROMPT,
  TRANSLATE_PROMPT,
  ...TENSION_PROMPTS,
].map((name) => `popcorn/prompts/${name}.md`);

// Gemini counts thinking against maxOutputTokens; 65,536 is the model's own ceiling.
const ANALYSIS_MAX_TOKENS = 65536;
const ENRICH_MAX_TOKENS = 8000;
const EXTRACT_TIMEOUT_MS = 60_000;
const ENRICH_TIMEOUT_MS = 120_000;
const ANALYSIS_TIMEOUT_MS = 300_000;
const TRANSLATE_TIMEOUT_MS = 120_000;
/** Texts per translation call, and calls at once. */
const TRANSLATE_BATCH = 40;
const TRANSLATE_PARALLEL = 4;
const TRANSLATE_MAX_TOKENS = 16000;

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  uk: "Ukrainian",
  cs: "Czech",
};

const TRANSLATE_SCHEMA: Json = {
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

const prompts = new Map<string, string>();

export function promptText(name: string): string {
  let text = prompts.get(name);
  if (text === undefined) {
    text = readFileSync(assetPath("popcorn", "prompts", `${name}.md`), "utf8");
    prompts.set(name, text);
  }
  return text;
}

function jsonFromText(text: string): Json {
  let cleaned = text.trim();
  if (cleaned.startsWith("```"))
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Popcorn model response was not a JSON object");
  return parsed as Json;
}

/** finish_reason and the token counts, for the outcome line about a bad answer. */
function answerFacts(c: Completion): string {
  const completion = c.usage.completion_tokens ?? "None";
  return `finish_reason=${c.finishReason ?? "None"}, ${[...c.text].length} chars, completion_tokens=${completion}, reasoning_tokens=None`;
}

export interface Structured {
  readonly system: string;
  readonly user: string;
  readonly schema: Json;
  readonly maxTokens: number;
  /** Thinking off: the first pass is a latency product. */
  readonly fast: boolean;
  readonly timeoutMs: number;
}

export async function structured(completer: Completer, s: Structured): Promise<Json> {
  const response = await withTimeout(
    (signal) =>
      completer.complete({
        group: "multi_modal_fast",
        system: s.system,
        user: s.user,
        temperature: 0,
        maxTokens: s.maxTokens,
        jsonSchema: s.schema,
        ...(s.fast && { thinkingBudget: 0 }),
        signal,
      }),
    s.timeoutMs,
  );
  try {
    return jsonFromText(response.text);
  } catch (exc) {
    // A cut-off answer (the budget went to thinking) reads as a JSON error; say which.
    throw new AnswerError(
      `model answer did not parse (${answerFacts(response)}): ${(exc as Error).message}`,
    );
  }
}

export const { transcriptMessage } = popcornShared;

const phraseMessage = (tid: string, transcript: string, phrase: string, label: string) =>
  `TRANSCRIPT id: ${tid}\n${transcript}\nEND TRANSCRIPT\n\n${label}:\n${phrase}`;

export interface PhraseArgs {
  readonly transcriptId: string;
  readonly transcript: string;
  readonly phrase: string;
}

export class PopcornModel {
  constructor(readonly completer: Completer) {}

  /** One fast extractor per transcript; the raw `{items: [...]}`. */
  extract(o: { transcriptId: string; transcript: string; hostNote: string }) {
    return structured(this.completer, {
      system: promptText(POPCORN_PROMPT),
      user: transcriptMessage(o.transcriptId, o.transcript, o.hostNote),
      schema: POPCORN_SCHEMA,
      maxTokens: 2000,
      fast: true,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
  }

  private phrase(prompt: string, schema: Json, label: string, o: PhraseArgs) {
    return structured(this.completer, {
      system: promptText(prompt),
      user: phraseMessage(o.transcriptId, o.transcript, o.phrase, label),
      schema,
      maxTokens: ENRICH_MAX_TOKENS,
      fast: false,
      timeoutMs: ENRICH_TIMEOUT_MS,
    });
  }

  validate = (o: PhraseArgs) => this.phrase(VALIDATE_PROMPT, VALIDATE_SCHEMA, "POPCORN PHRASE", o);
  classify = (o: PhraseArgs) => this.phrase(KIND_PROMPT, KIND_SCHEMA, "PHRASE", o);
  rewrite = (o: PhraseArgs) =>
    this.phrase(QUESTION_PROMPT, QUESTION_SCHEMA, "POPCORN PHRASE (written as a statement)", o);

  /** One judgement of the analysis kind: the caller's prompt and schema. */
  analysis = (o: { system: string; user: string; schema: Json; thinking: boolean }) =>
    structured(this.completer, {
      system: o.system,
      user: o.user,
      schema: o.schema,
      maxTokens: ANALYSIS_MAX_TOKENS,
      fast: !o.thinking,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
    });

  /** The stakeholders slide over the whole session, with the checks a previous answer failed. */
  stakeholders(corpus: string, feedback: readonly string[] = []) {
    let system = promptText(STAKEHOLDERS_PROMPT);
    if (feedback.length) {
      const lines = feedback.map((x) => `- ${x}\n`).join("");
      system = `${system}\n\n## Your previous answer failed these checks\n\n${lines}\nFix every one of them and return the complete output again.`;
    }
    return structured(this.completer, {
      system,
      user: transcriptMessage("session", corpus),
      schema: STAKEHOLDERS_SCHEMA,
      maxTokens: ANALYSIS_MAX_TOKENS,
      fast: false,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
    });
  }

  /**
   * `texts` in the target language, in order; a text left out comes back null and is asked
   * for again next tick. `onBatch` is awaited as each batch lands; a failed batch skips it.
   */
  async translate(
    texts: readonly string[],
    target: string,
    onBatch?: (batch: string[], answers: (string | null)[]) => Promise<void>,
    warn: (msg: string) => void = () => {},
  ): Promise<(string | null)[]> {
    const slots = new Semaphore(TRANSLATE_PARALLEL);
    const batch = async (start: number): Promise<(string | null)[]> => {
      const chunk = texts.slice(start, start + TRANSLATE_BATCH);
      const payload = {
        target: LANGUAGE_NAMES[target],
        texts: chunk.map((text, i) => ({ i, text })),
      };
      const out: (string | null)[] = chunk.map(() => null);
      let answer: Json;
      try {
        answer = await slots.run(() =>
          structured(this.completer, {
            system: promptText(TRANSLATE_PROMPT),
            user: pyJson(payload),
            schema: TRANSLATE_SCHEMA,
            maxTokens: TRANSLATE_MAX_TOKENS,
            fast: true,
            timeoutMs: TRANSLATE_TIMEOUT_MS,
          }),
        );
      } catch (exc) {
        // One failed batch leaves its texts in the original until the next tick.
        warn(`popcorn translation batch failed: ${(exc as Error).message}`);
        return out;
      }
      for (const entry of Array.isArray(answer.translations) ? answer.translations : []) {
        const e = entry as Json;
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
      if (onBatch) await onBatch([...chunk], out);
      return out;
    };
    // Bounded both in flight and in scheduled work, as a long deck may owe hundreds.
    const results: (string | null)[][] = [];
    const wave = TRANSLATE_BATCH * TRANSLATE_PARALLEL;
    for (let w = 0; w < texts.length; w += wave) {
      const starts: number[] = [];
      for (let i = w; i < Math.min(texts.length, w + wave); i += TRANSLATE_BATCH) starts.push(i);
      results.push(...(await Promise.all(starts.map(batch))));
    }
    return results.flat();
  }
}
