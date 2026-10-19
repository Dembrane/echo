import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { FallbackModel } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import {
  DEFAULT_RETRY,
  doubtful,
  editSentences,
  GeminiTranscriber,
  guardEdit,
  isoOf,
  isRecoverableTranscriptionError,
  lowWordSpans,
  maxWordDistance,
  parseSegments,
  parseTranscriptJson,
  regexRedactPii,
  rescaleToPiece,
  spansOf,
  splitLong,
  TranscriptParseError,
  TranscriptRefusedError,
  tidy,
  toSeconds,
  transcribeChecked,
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

test("with a speech-to-text model its words are the transcript and no chat model runs", async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const heard: { language?: string | null; prompt?: string; priority?: string }[] = [];
  const t = new GeminiTranscriber(
    {
      model: () => model([], seen),
      embedding: () => ({}) as never,
      speechToText: {
        model: "whisper-fake",
        transcribe: async (_audio, o = {}) => {
          heard.push(o);
          return "Ik ben Jan en ik werk bij Dembrane.";
        },
        transcribeSegments: async () => ({ text: "", segments: [], seconds: null }),
      },
    },
    logger,
  );
  const out = await t.transcribe({
    audio: new Uint8Array([1]),
    language: "nl",
    hotwords: ["Dembrane"],
  });
  expect(out).toEqual({
    transcript: "Ik ben Jan en ik werk bij Dembrane.",
    note: "",
    models: ["whisper-fake"],
  });
  expect(seen).toHaveLength(0);
  expect(heard).toEqual([{ language: "nl", prompt: "Dembrane", priority: "live" }]);
});

test("with a speech-to-text model, redaction is one text-only pass with reasoning off", async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const t = new GeminiTranscriber(
    {
      model: () => model(['{"corrected_transcript": "Ik ben <redacted_name>", "note": "n"}'], seen),
      embedding: () => ({}) as never,
      speechToText: {
        model: "whisper-fake",
        transcribe: async () => "Ik ben Jan",
        transcribeSegments: async () => ({ text: "", segments: [], seconds: null }),
      },
    },
    logger,
  );
  const out = await t.transcribe({ audio: new Uint8Array([1]), usePiiRedaction: true });
  expect(out.transcript).toBe("Ik ben <redacted_name>");
  expect(out.models).toEqual(["whisper-fake", "gemini-fake"]);
  expect(seen).toHaveLength(1);
  const user = seen[0]?.prompt[1] as { content: { type: string; text?: string }[] };
  expect(user.content).toEqual([{ type: "text", text: "Ik ben Jan" }]);
  expect(seen[0]?.providerOptions?.openaiCompatible).toEqual({ reasoningEffort: "none" });
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

test("typed text is redacted like a transcript: regex first, then one text-only model pass", async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const t = new GeminiTranscriber(
    {
      model: () =>
        model(
          ['{"corrected_transcript": "Ik ben <redacted_name>, <redacted_email>", "note": "n"}'],
          seen,
        ),
      embedding: () => ({}) as never,
    },
    logger,
  );
  const out = await t.redactText({
    text: "Ik ben Jan, jan@example.nl",
    anonymizeTranscripts: true,
  });
  expect(out.transcript).toBe("Ik ben <redacted_name>, <redacted_email>");
  expect(seen).toHaveLength(1);
  const user = seen[0]?.prompt[1] as { content: { type: string; text?: string }[] };
  expect(user.content).toEqual([{ type: "text", text: "Ik ben Jan, <redacted_email>" }]);
});

test("typed text with both redaction flags off is returned as typed and calls no model", async () => {
  const seen: LanguageModelV4CallOptions[] = [];
  const t = new GeminiTranscriber(
    {
      model: () => model(['{"corrected_transcript": "x", "note": ""}'], seen),
      embedding: () => ({}) as never,
    },
    logger,
  );
  const out = await t.redactText({ text: "mail jan@example.nl" });
  expect(out.transcript).toBe("mail jan@example.nl");
  expect(seen).toHaveLength(0);
});

test("a piece whose last sentence ends after the audio is pulled back to its length", () => {
  const out = rescaleToPiece(
    [
      { start: 0, end: 30, text: "a" },
      { start: 30, end: 72, text: "b" },
    ],
    60,
    true,
  );
  expect(out[1]?.end).toBeCloseTo(60);
  expect(out[0]?.end).toBeCloseTo(25);
  // Inside the audio, or switched off: untouched.
  const early = [{ start: 0, end: 50, text: "a" }];
  expect(rescaleToPiece(early, 60, true)).toEqual(early);
  expect(rescaleToPiece([{ start: 0, end: 80, text: "a" }], 60, false)[0]?.end).toBe(80);
});

test("timed sentences are parsed from seconds or a clock and tidied into the piece", () => {
  const parsed = parseSegments(
    JSON.stringify({
      segments: [
        { start: "00:02.5", end: "00:04", text: " Hallo. " },
        { start: 1, end: 3, text: "Tweede" },
        { start: 3, end: 99, text: "" },
      ],
    }),
    "stop",
  );
  expect(parsed.map((s) => [s.start, s.end, s.text])).toEqual([
    [2.5, 4, "Hallo."],
    [1, 3, "Tweede"],
  ]);
  expect(tidy(parsed, 3.5).map((s) => [s.start, s.end])).toEqual([
    [1, 3],
    [3, 3.5],
  ]);
  expect(toSeconds("1:02:03")).toBe(3723);
  expect(toSeconds("abc")).toBeNull();
});

function editModel(answer: (prompt: string) => unknown, seen: string[] = []): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "edit-fake",
    supportedUrls: {},
    async doGenerate(opts: LanguageModelV4CallOptions) {
      const user = (opts.prompt[1] as { content: { text: string }[] }).content[0]?.text ?? "";
      seen.push(user);
      return {
        content: [{ type: "text", text: JSON.stringify(answer(user)) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      } as never;
    },
    async doStream() {
      throw new Error("not used");
    },
  };
}

const sentenceList = [
  { start: 0, end: 4, text: "ik werk bij dem brane en praat met jorim" },
  { start: 4.5, end: 9, text: "we hebben het over de roadmap voor volgende maand" },
  { start: 9.5, end: 12, text: "salam aleikum" },
];

test("the text pass keeps ids and times and takes a small edit, refusing a rewrite and a made-up id", async () => {
  const seen: string[] = [];
  const models = {
    model: () =>
      editModel(
        () => ({
          sentences: [
            { id: 0, text: "Ik werk bij Dembrane en praat met Jorim." },
            {
              id: 1,
              text: "Completely different: here is a summary of the roadmap discussion and next steps.",
            },
            { id: 2, text: "Salam aleikum." },
            { id: 7, text: "made up" },
          ],
        }),
        seen,
      ),
    embedding: () => ({}) as never,
  } as never;
  const out = await editSentences(
    models,
    sentenceList,
    { language: "nl", keyTerms: ["Dembrane", "Jorim"] },
    logger,
  );
  expect(out.sentences.map((s) => [s.start, s.end])).toEqual(
    sentenceList.map((s) => [s.start, s.end]),
  );
  expect(out.sentences[0]?.text).toBe("Ik werk bij Dembrane en praat met Jorim.");
  expect(out.sentences[1]?.text).toBe(sentenceList[1]?.text);
  expect(out.sentences[2]?.text).toBe("Salam aleikum.");
  expect(out.stats).toMatchObject({ sentences: 3, edited: 2, changedWords: 1, failedBatches: 0 });
  expect(out.stats.rejected).toBeGreaterThanOrEqual(2);
  expect(seen[0]).toContain("Dembrane, Jorim");
  expect(seen[0]).toContain("0: ik werk bij dem brane");
});

test("a batch the model fails on stays as Whisper wrote it", async () => {
  const models = {
    model: () => editModel(() => ({ nothing: true })),
    embedding: () => ({}) as never,
  } as never;
  const out = await editSentences(models, sentenceList, {}, logger);
  expect(out.sentences).toEqual(sentenceList);
  expect(out.stats.failedBatches).toBe(1);
});

test("the guard puts back the swaps that broke sentences and keeps spellings, key terms, casing and punctuation", () => {
  const dutch = guardEdit("ik zag ze lopen", "ik zag hij lopen");
  expect(dutch.text).toBe("ik zag ze lopen");
  expect(dutch.refused).toBe(1);
  expect(guardEdit("het verhaal achter de film", "het mooie de film").text).toBe(
    "het verhaal achter de film",
  );
  expect(guardEdit("the uproar'd crowd", "the arose crowd").text).toBe("the uproar'd crowd");
  expect(guardEdit("i find it so", "he found it so").text).toBe("i find it so");
  // What it is for.
  const terms = ["Dembrane", "Jorim", "Toki Pona"];
  expect(guardEdit("ik werk bij dem brane", "Ik werk bij Dembrane.", terms)).toMatchObject({
    text: "Ik werk bij Dembrane.",
    kept: 1,
  });
  expect(guardEdit("soy yorim aqui", "Soy Jorim aquí.", terms).text).toBe("Soy Jorim aquí.");
  expect(guardEdit("maybe toki ponna works", "Maybe Toki Pona works.", terms).text).toBe(
    "Maybe Toki Pona works.",
  );
  expect(guardEdit("we wich restaraunt", "we which restaurant").text).toBe("we which restaurant");
  expect(guardEdit("hola buenas tardes", "Hola, buenas tardes.").text).toBe("Hola, buenas tardes.");
  // A key term never replaces a different word.
  expect(guardEdit("the sea is calm", "Sameer sea is calm", terms).text).toBe("the sea is calm");
  expect([
    maxWordDistance("ze", "zo"),
    maxWordDistance("find", "found"),
    maxWordDistance("restaraunt", "restaurant"),
  ]).toEqual([0, 1, 2]);
});

const seg = (
  start: number,
  end: number,
  text: string,
  avgLogprob = -0.3,
  compressionRatio = 1.4,
) => ({
  start,
  end,
  text,
  avgLogprob,
  compressionRatio,
});

// Whisper's own confidence as the trigger, with the language and loudness triggers off.
const SIGNALS = {
  ...DEFAULT_RETRY,
  minLogprob: -1,
  language: false,
  lowWords: null,
  attempts: [
    { temperature: 0.2, language: "auto" as const },
    { temperature: 0.4, language: "detected" as const },
  ],
};

test("doubtful stretches are found from Whisper's own confidence and merged with a pad", () => {
  const segments = [
    seg(0, 5, "fine"),
    seg(5, 9, "unsure", -1.4),
    seg(9.5, 12, "looping looping looping", -0.5, 3.1),
    seg(12, 20, "fine"),
    seg(28, 29, "x", -1.2),
  ];
  const spans = spansOf(segments, { ...SIGNALS, minGap: 0 }, 30);
  expect(spans.map((s) => [s.start, s.end, s.indexes])).toEqual([
    [4.7, 12.3, [1, 2]],
    [27.7, 29.3, [4]],
  ]);
  expect(doubtful(seg(0, 3, "a", -0.4, 1.2), SIGNALS)).toBe(false);
});

test("a retry replaces a doubtful stretch only when the signals say it is better, and every retry is counted", async () => {
  const calls: { temperature?: number | undefined; forceLanguage?: string | undefined }[] = [];
  const stt = {
    model: "w",
    transcribe: async () => "",
    transcribeSegments: async (
      _a: Uint8Array,
      o: { temperature?: number; forceLanguage?: string } = {},
    ) => {
      calls.push({ temperature: o.temperature, forceLanguage: o.forceLanguage });
      if (o.temperature === undefined)
        return {
          text: "",
          seconds: 20,
          language: "nl",
          segments: [seg(0, 6, "fine"), seg(6, 12, "garbled", -1.6), seg(12, 20, "fine")],
        };
      // The retry hears it: a clean reading of the span, in the language it reports.
      return {
        text: "",
        seconds: 6,
        language: "nl",
        segments: [seg(0, 6, "heard properly", -0.4)],
      };
    },
  } as never;
  const cut = async () => new Uint8Array([1]);
  const out = await transcribeChecked(stt, new Uint8Array([0]), {}, 20, cut, SIGNALS);
  expect(out.result.segments.map((s) => s.text)).toEqual(["fine", "heard properly", "fine"]);
  expect(out.stats).toMatchObject({ spans: 1, attempts: 1, improved: 1, kept: 0, failed: 0 });
  expect(calls[1]?.temperature).toBe(0.2);

  // A retry that is no better leaves the first reading and says so.
  const worse = {
    model: "w",
    transcribe: async () => "",
    transcribeSegments: async (_a: Uint8Array, o: { temperature?: number } = {}) => ({
      text: "",
      seconds: 20,
      language: "nl",
      segments:
        o.temperature === undefined
          ? [seg(0, 8, "a", -1.5), seg(8, 20, "t")]
          : [seg(0, 8, "b", -1.9)],
    }),
  } as never;
  const kept = await transcribeChecked(worse, new Uint8Array([0]), {}, 20, cut, SIGNALS);
  expect(kept.result.segments.map((s) => s.text)).toEqual(["a", "t"]);
  expect(kept.stats).toMatchObject({ spans: 1, attempts: 2, improved: 0, kept: 1 });

  // No cutter or no policy: one plain call, no retries.
  const plain = await transcribeChecked(worse, new Uint8Array([0]), {}, 20, undefined, SIGNALS);
  expect(plain.stats.attempts).toBe(0);
});

test("a stretch where Whisper wrote nothing is read again and kept only when it holds speech", async () => {
  const cut = async () => new Uint8Array([1]);
  const mk = (retried: string) =>
    ({
      model: "w",
      transcribe: async () => "",
      transcribeSegments: async (_a: Uint8Array, o: { temperature?: number } = {}) => ({
        text: "",
        seconds: 30,
        language: "nl",
        segments:
          o.temperature === undefined
            ? [seg(0, 18, "ik denk dat het goed is")]
            : [seg(0, 12, retried, -0.5)],
      }),
    }) as never;
  const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  const full = await transcribeChecked(mk(words), new Uint8Array([0]), {}, 30, cut, SIGNALS);
  expect(full.result.segments.map((s) => s.text)).toEqual(["ik denk dat het goed is", words]);
  expect(full.result.segments[1]?.start).toBeCloseTo(17.7);
  expect(full.stats).toMatchObject({ spans: 1, improved: 1 });
  // A few words over twenty seconds are what Whisper invents on silence.
  const halluc = await transcribeChecked(
    mk("bedankt voor het kijken"),
    new Uint8Array([0]),
    {},
    30,
    cut,
    SIGNALS,
  );
  expect(halluc.result.segments.map((s) => s.text)).toEqual(["ik denk dat het goed is"]);
  expect(halluc.stats).toMatchObject({ spans: 1, improved: 0, kept: 1 });
});

test("a piece in another language than the project's is read again in the project's language", async () => {
  const seen: (string | undefined)[] = [];
  const stt = {
    model: "w",
    transcribe: async () => "",
    transcribeSegments: async (_a: Uint8Array, o: { forceLanguage?: string } = {}) => {
      seen.push(o.forceLanguage);
      return o.forceLanguage
        ? {
            text: "",
            seconds: 10,
            language: "en",
            segments: [seg(0, 10, "ten words in the language of the project, said clearly", -0.3)],
          }
        : { text: "", seconds: 10, language: "welsh", segments: [seg(0, 10, "gibberish", -1.5)] };
    },
  } as never;
  const cut = async () => new Uint8Array([1]);
  const out = await transcribeChecked(
    stt,
    new Uint8Array([0]),
    { language: "en-US" },
    10,
    cut,
    DEFAULT_RETRY,
  );
  expect(seen).toEqual([undefined, "en"]);
  expect(out.result.segments[0]?.text).toContain("project");
  expect(isoOf("English")).toBe("en");
});

test("a window of loud audio with few words is read again", () => {
  const spans = lowWordSpans(
    [seg(0, 4, "one two three four five six seven eight"), seg(12, 16, "one")],
    [{ start: 4, end: 12 }],
    16,
    { window: 4, minSpeech: 0.6, maxWps: 1 },
  );
  expect(spans.map((s) => [s.start, s.end])).toEqual([[12, 16]]);
});

test("a segment of half a minute is cut at its sentence ends, timed by share, and nothing else changes", () => {
  const long = {
    start: 10,
    end: 40,
    text: "We start with the budget for the new building. It is more than last year, but less than we feared! Then the schedule, which nobody likes. Done.",
  };
  const out = splitLong([
    { start: 0, end: 10, text: "Short one." },
    long,
    { start: 40, end: 42, text: "After." },
  ]);
  expect(out[0]?.text).toBe("Short one.");
  expect(out.at(-1)?.text).toBe("After.");
  const parts = out.slice(1, -1);
  expect(parts.length).toBeGreaterThanOrEqual(3);
  expect(parts.map((p) => p.text).join(" ")).toBe(long.text);
  expect(parts[0]?.start).toBe(10);
  expect(parts.at(-1)?.end).toBe(40);
  for (const p of parts) expect(p.end - p.start).toBeLessThan(15);
  for (let i = 1; i < parts.length; i++)
    expect((parts[i] as { start: number }).start).toBeCloseTo(
      (parts[i - 1] as { end: number }).end,
      1,
    );
  // A short segment is left alone, and so is a long one with no punctuation to cut at.
  expect(splitLong([{ start: 0, end: 5, text: "One. Two. Three." }])).toHaveLength(1);
  expect(
    splitLong([{ start: 0, end: 30, text: "no punctuation at all in this long run of words" }]),
  ).toHaveLength(1);
});
