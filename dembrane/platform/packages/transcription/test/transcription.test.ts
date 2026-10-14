import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { FallbackModel } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import {
  GeminiTranscriber,
  isRecoverableTranscriptionError,
  parseTranscriptJson,
  regexRedactPii,
  TranscriptParseError,
  TranscriptRefusedError,
  transcriptionFailureReason,
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

function refusing(id: string, answers: (string | "refused")[], seen: LanguageModelV4CallOptions[]) {
  const m = model([], seen);
  return {
    ...m,
    modelId: id,
    async doGenerate(o: LanguageModelV4CallOptions) {
      seen.push(o);
      const next = answers.shift() ?? "refused";
      // What prod saw: finish_reason SAFETY with no text at all.
      if (next === "refused")
        return {
          content: [],
          finishReason: { unified: "content-filter", raw: "SAFETY" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          response: { modelId: id },
          warnings: [],
        } as never;
      return {
        content: [{ type: "text", text: next }],
        finishReason: { unified: "stop", raw: "STOP" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        response: { modelId: id },
        warnings: [],
      } as never;
    },
  } satisfies LanguageModelV4;
}

const noWait = { backoffMs: 0, sleep: async () => {} };

test("a refused chunk goes to the next deployment, with safety filters off", async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const group = new FallbackModel(
    "multi_modal_pro",
    [
      { label: "a", model: refusing("gemini-a", ["refused"], seen) },
      {
        label: "b",
        model: refusing("gemini-b", ['{"corrected_transcript": "hallo", "note": ""}'], seen),
      },
    ],
    noWait,
  );
  const t = new GeminiTranscriber({ model: () => group, embedding: () => ({}) as never }, logger);
  const out = await t.transcribe({ audio: new Uint8Array([1]) });
  expect(out.transcript).toBe("hallo");
  expect(out.models).toEqual(["gemini-b"]);
  expect(seen.map((o) => o.providerOptions?.vertex)).toEqual([
    { threshold: "OFF" },
    { threshold: "OFF" },
  ]);
});

test("a chunk every deployment refuses ends with a refusal, not a parse error", async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const group = new FallbackModel(
    "multi_modal_pro",
    [
      { label: "a", model: refusing("gemini-a", ["refused"], seen) },
      { label: "b", model: refusing("gemini-b", ["refused"], seen) },
    ],
    noWait,
  );
  const t = new GeminiTranscriber({ model: () => group, embedding: () => ({}) as never }, logger);
  const err = await t.transcribe({ audio: new Uint8Array([1]) }).catch((e) => e);
  expect(err).toBeInstanceOf(TranscriptRefusedError);
  expect(err).not.toBeInstanceOf(TranscriptParseError);
  expect(isRecoverableTranscriptionError(err)).toBe(true);
  expect(transcriptionFailureReason(err)).toBe("refused");
  // One call per deployment: no same-model retry, no detour through multi_modal_fast.
  expect(seen).toHaveLength(2);
});

test("a refusal on the multi_modal_fast detour is a refusal too", async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const overloaded = {
    ...model([], seen),
    async doGenerate() {
      throw Object.assign(new Error("503"), { statusCode: 503, isRetryable: true });
    },
  } satisfies LanguageModelV4;
  const pro = new FallbackModel("multi_modal_pro", [{ label: "p", model: overloaded }], {
    ...noWait,
    attemptsPerDeployment: 1,
  });
  const fast = new FallbackModel(
    "multi_modal_fast",
    [{ label: "f", model: refusing("gemini-f", ["refused"], seen) }],
    noWait,
  );
  const t = new GeminiTranscriber(
    { model: (g) => (g === "multi_modal_pro" ? pro : fast), embedding: () => ({}) as never },
    logger,
  );
  const err = await t.transcribe({ audio: new Uint8Array([1]) }).catch((e) => e);
  expect(err).toBeInstanceOf(TranscriptRefusedError);
});
