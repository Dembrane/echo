import type { Completion } from "@dembrane/llm";
import type { Json } from "../contracts";
import extractionPrompt from "../prompts/map-arguments-v2.md" with { type: "text" };
import type { ProducerServices } from "./services";

/**
 * Model calls shared by Map and the producers. A prompt iteration is a new file and a new
 * version constant, never an edit in place, so a saved result names the prompt that
 * produced it. Untrusted text reaches a model only inside START/END data blocks.
 */

export const EXTRACTION_PROMPT = "map-arguments-v2";
export const EXTRACTION_PROMPT_TEXT: string = extractionPrompt;
export const DATA_BLOCKS = ["TRANSCRIPT", "PROJECT", "ARGUMENTS", "CLAIM", "EVIDENCE", "ANALYSIS"];
const BLOCK_MARKER = new RegExp(`\\b(?:${DATA_BLOCKS.join("|")})\\s+(?:START|END)\\b`, "g");

/** Untrusted text between markers; a marker inside it is blanked so it cannot close its block. */
export const dataBlock = (name: string, text: string) =>
  `${name} START\n${text.replace(BLOCK_MARKER, "[...]")}\n${name} END`;

export const EXTRACTION_MAX_TOKENS = 32_000;
export const EXTRACTION_TIMEOUT_MS = 300_000;
/** One retry on top of the group's own retries, for answers that did not parse or timed out. */
export const EXTRACTION_ATTEMPTS = 2;

export const ARGUMENTS_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "statement", "evidence", "valence"],
        properties: {
          kind: { type: "string", enum: ["argument", "claim"] },
          statement: { type: "string", minLength: 1 },
          evidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          valence: { type: "string", enum: ["positive", "negative", "neutral"] },
        },
      },
    },
  },
};

export class AnswerDidNotParse extends Error {}

/** The model's answer as a JSON object: fences stripped, else the outermost braces. */
export function jsonFromText(text: string): Json {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new AnswerDidNotParse("model answer was not JSON");
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new AnswerDidNotParse("model answer was not JSON");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AnswerDidNotParse("model answer was not a JSON object");
  return parsed as Json;
}

const facts = (c: Completion) =>
  `finish_reason=${c.finishReason}, ${c.text.length} chars, usage=${JSON.stringify(c.usage)}`;

/** One extraction call over one transcript window; retried once on a timeout or an unparsable answer. */
export async function extractArguments(
  services: ProducerServices,
  o: { conversationId: string; window: string; windowIndex: number; windowCount: number },
): Promise<[Json, Record<string, number>]> {
  const part = o.windowCount > 1 ? `Part ${o.windowIndex + 1} of ${o.windowCount}.\n` : "";
  const userText = `Conversation id: ${o.conversationId}\n${part}\n${dataBlock("TRANSCRIPT", o.window)}`;
  let last: unknown;
  for (let attempt = 1; attempt <= EXTRACTION_ATTEMPTS; attempt++) {
    try {
      const response = await services.complete({
        system: EXTRACTION_PROMPT_TEXT,
        user: userText,
        temperature: 0,
        maxTokens: EXTRACTION_MAX_TOKENS,
        jsonSchema: ARGUMENTS_SCHEMA,
        timeoutMs: EXTRACTION_TIMEOUT_MS,
      });
      try {
        return [jsonFromText(response.text), { ...response.usage }];
      } catch {
        throw new AnswerDidNotParse(`answer did not parse (${facts(response)})`);
      }
    } catch (err) {
      const retryable = err instanceof AnswerDidNotParse || (err as Error)?.name === "TimeoutError";
      if (!retryable) throw err;
      last = err;
      if (attempt < EXTRACTION_ATTEMPTS) await Bun.sleep(2000 * attempt);
    }
  }
  throw last;
}
