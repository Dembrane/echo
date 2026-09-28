import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { createLogger } from "@dembrane/observability";
import {
  GeminiTranscriber,
  isRecoverableTranscriptionError,
  parseTranscriptJson,
  regexRedactPii,
  TranscriptParseError,
} from "../src";

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

test("transcript JSON with a stray \\u is repaired, a truncated one is not retried", () => {
  expect(parseTranscriptJson('{"corrected_transcript": "a \\u b", "note": ""}', "stop")).toEqual({
    corrected_transcript: "a \\u b",
    note: "",
  });
  const truncated = (() => {
    try {
      parseTranscriptJson('{"corrected_transcript": "a', "length");
    } catch (e) {
      return e;
    }
  })();
  expect(truncated).toBeInstanceOf(TranscriptParseError);
  expect((truncated as TranscriptParseError).isTruncated).toBe(true);
  expect(isRecoverableTranscriptionError(truncated)).toBe(true);
  expect(isRecoverableTranscriptionError(new Error("No spoken audio detected"))).toBe(true);
  expect(isRecoverableTranscriptionError(new Error("vertex 503"))).toBe(false);
});

test("regex redaction runs the patterns in the Python order", () => {
  expect(regexRedactPii("mail jan@example.nl or call 06-12345678, postcode 1234 AB")).toBe(
    "mail <redacted_email> or call <redacted_phone>, postcode <redacted_postcode>",
  );
});

function model(answers: string[], seen: LanguageModelV4CallOptions[]): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "gemini-fake",
    supportedUrls: {},
    async doGenerate(o) {
      seen.push(o);
      return {
        content: [{ type: "text", text: answers.shift() ?? "" }],
        finishReason: { unified: "stop", raw: "STOP" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        response: { modelId: "gemini-fake" },
        warnings: [],
      } as never;
    },
    async doStream() {
      throw new Error("not used");
    },
  };
}

test("redaction runs a second pass on the audio plus the first transcript", async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const m = model(
    [
      '{"corrected_transcript": "Ik ben Jan, jan@example.nl", "note": "first"}',
      '{"corrected_transcript": "Ik ben <redacted_name>, <redacted_email>", "note": "second"}',
    ],
    seen,
  );
  const t = new GeminiTranscriber({ model: () => m, embedding: () => ({}) as never }, logger);
  const out = await t.transcribe({
    audio: new Uint8Array([1, 2, 3]),
    language: "nl",
    anonymizeTranscripts: true,
  });
  expect(out).toEqual({
    transcript: "Ik ben <redacted_name>, <redacted_email>",
    note: "second",
    models: ["gemini-fake", "gemini-fake"],
  });
  expect(seen).toHaveLength(2);
  // The regex pass ran before the model's redaction pass, on the first transcript.
  const second = seen[1]?.prompt[1] as { content: { type: string; text?: string }[] };
  expect(second.content[0]?.text).toBe("Ik ben Jan, <redacted_email>");
  expect(seen[0]?.responseFormat).toMatchObject({ type: "json" });
});

test("an empty transcript becomes the placeholder the dashboard shows", async () => {
  const t = new GeminiTranscriber(
    {
      model: () => model(['{"corrected_transcript": "", "note": ""}'], []),
      embedding: () => ({}) as never,
    },
    logger,
  );
  expect((await t.transcribe({ audio: new Uint8Array([1]) })).transcript).toBe(
    "[Nothing to transcribe]",
  );
});
