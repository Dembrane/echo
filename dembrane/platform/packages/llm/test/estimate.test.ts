import { describe, expect, test } from "bun:test";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import {
  AUDIO_TOKENS_PER_SECOND,
  audioSecondsOf,
  estimateInput,
  estimateText,
  markNotSent,
  reachedProvider,
} from "../src/estimate";

const cl = new Tiktoken(cl100k);

// Fastest of three runs, so a GC pause or a busy CI runner can't fail a cost bound.
function fastestMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

// Transcript-like text: mixed English and Dutch words, numbers and punctuation, seeded.
const WORDS =
  'the residents said that buses should run later at night because many people work late shifts in the hospital and harbour; others asked for more cycle lanes, safer crossings near schools and better lighting in parks. Bewoners zeiden dat de bussen later moeten rijden omdat velen laat werken. 2026-11-04 12:30 EUR 5,00 #42 (Table 3) "yes"'.split(
    " ",
  );
function transcript(chars: number, seed: number): string {
  let x = seed;
  const out: string[] = [];
  let len = 0;
  while (len < chars) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const w = WORDS[x % WORDS.length] as string;
    out.push(w);
    len += w.length + 1;
  }
  return out.join(" ");
}
// Japanese clauses shuffled at their punctuation, seeded.
const JA =
  "住民は、病院や港で遅い時間まで働く人が多いので、夜はバスをもっと遅くまで運行してほしいと言いました。ほかの人は、自転車道を増やし、学校の近くに安全な横断歩道を作り、公園の照明を良くしてほしいと求めました。".split(
    /(?<=[、。])/,
  );
function japanese(chars: number, seed: number): string {
  let x = seed;
  let out = "";
  while (out.length < chars) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += JA[x % JA.length] as string;
  }
  return out.slice(0, chars);
}
const exact = (texts: string[]) => texts.reduce((n, t) => n + cl.encode(t, [], []).length, 0);

describe("estimate", () => {
  test("text is counted with tiktoken cl100k", () => {
    expect(estimateText("hello world")).toBe(cl.encode("hello world").length);
    expect(estimateText("")).toBe(0);
  });

  test("special-token text is counted as plain text, never a throw", () => {
    const text = "people said <|endoftext|> about bikes <|fim_prefix|>";
    expect(estimateText(text)).toBe(cl.encode(text, [], []).length);
  });

  test("a prompt can be counted without its audio", () => {
    const prompt: LanguageModelV4Prompt = [
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this." },
          {
            type: "file",
            mediaType: "audio/mp3",
            data: { type: "data", data: new Uint8Array(80_000) },
          },
        ],
      },
    ];
    const text = cl.encode("Transcribe this.").length;
    expect(estimateInput(prompt)).toEqual({ inputTokens: text + 320, audioInputTokens: 320 });
    expect(estimateInput(prompt, { audio: false })).toEqual({
      inputTokens: text,
      audioInputTokens: 0,
    });
  });

  test("audio is billed at Gemini's 32 tokens per second", () => {
    expect(AUDIO_TOKENS_PER_SECOND).toBe(32);
    expect(audioSecondsOf(new Uint8Array(80_000))).toBe(10);
  });

  test("an mp3 is timed from its frames, not its size", () => {
    // One MPEG1 layer III frame header: 128 kbps, 44.1 kHz, stereo, padded to 16,000 bytes.
    const mp3 = new Uint8Array(16_000);
    mp3.set([0xff, 0xfb, 0x90, 0x00]);
    expect(audioSecondsOf(mp3)).toBeCloseTo((16_000 * 8) / 128_000, 5);
  });

  test("the input counts every text part and the audio's seconds", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: "system", content: "You transcribe." },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this." },
          {
            type: "file",
            mediaType: "audio/mp3",
            data: { type: "data", data: new Uint8Array(80_000) },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Sure." }] },
    ];
    const text = cl.encode("You transcribe.").length + cl.encode("Transcribe this.").length;
    expect(estimateInput(prompt)).toEqual({
      inputTokens: text + cl.encode("Sure.").length + 320,
      audioInputTokens: 320,
    });
  });

  test("base64 audio is decoded before it is timed", () => {
    const b64 = Buffer.from(new Uint8Array(80_000)).toString("base64");
    const prompt: LanguageModelV4Prompt = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "audio/mpeg", data: { type: "data", data: b64 } }],
      },
    ];
    expect(estimateInput(prompt)).toEqual({ inputTokens: 320, audioInputTokens: 320 });
  });

  test("tool calls and results count as text", () => {
    const prompt: LanguageModelV4Prompt = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c", toolName: "find", input: { q: "bikes" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "find",
            output: { type: "text", value: "three results" },
          },
        ],
      },
    ];
    expect(estimateInput(prompt).inputTokens).toBe(
      cl.encode(JSON.stringify({ q: "bikes" })).length + cl.encode("three results").length,
    );
  });

  test("a prompt within the cost budget is counted exactly, part by part", () => {
    const parts = [transcript(1_500, 1), transcript(2_000, 2), "Summarise.", transcript(1_200, 3)];
    const prompt: LanguageModelV4Prompt = [
      { role: "system", content: parts[0] as string },
      ...parts.slice(1).map((t) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: t }],
      })),
    ];
    expect(estimateInput(prompt).inputTokens).toBe(exact(parts));
  });

  test("a huge prompt is sampled: a few ms, within 3% of the exact count", () => {
    estimateInput([{ role: "system", content: transcript(40_000, 9) }]);
    const system = transcript(8_000, 2);
    const turns = Array.from({ length: 40 }, (_, i) => transcript(50_000, 10 + i));
    const prompt: LanguageModelV4Prompt = [
      { role: "system", content: system },
      ...turns.map((t) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: t }],
      })),
    ];
    const got = estimateInput(prompt).inputTokens;
    const ms = fastestMs(() => estimateInput(prompt));
    const want = exact([system, ...turns]);
    expect(Math.abs(got - want) / want).toBeLessThan(0.03);
    // Encoding all 2 MB takes ~250 ms here; sampling takes ~5 ms (bound left loose for CI).
    expect(ms).toBeLessThan(30);
  });

  test("English and Japanese blocks together stay within 8% either way, in a few ms", () => {
    estimateInput([{ role: "system", content: japanese(5_000, 1) }]);
    for (const seed of [11, 12, 13]) {
      const blocks = Array.from({ length: 6 }, (_, i) =>
        i % 2 ? japanese(10_000, seed * 10 + i) : transcript(20_000, seed * 10 + i),
      );
      const prompt: LanguageModelV4Prompt = [
        { role: "system", content: transcript(4_000, seed) },
        { role: "user", content: [{ type: "text", text: blocks.join("\n") }] },
      ];
      const want = exact([transcript(4_000, seed), blocks.join("\n")]);
      const got = estimateInput(prompt).inputTokens;
      const ms = fastestMs(() => estimateInput(prompt));
      expect(got / want).toBeGreaterThan(0.92);
      expect(got / want).toBeLessThan(1.08);
      expect(ms).toBeLessThan(30);
    }
  });

  test("a long run with no word breaks stays cheap", () => {
    const run = japanese(300_000, 5).replace(/[、。]/g, "");
    const prompt: LanguageModelV4Prompt = [{ role: "user", content: [{ type: "text", text: run }] }];
    const got = estimateInput(prompt).inputTokens;
    // Encoding it whole would take minutes: BPE cost grows with the square of a word.
    expect(fastestMs(() => estimateInput(prompt))).toBeLessThan(30);
    expect(got / run.length).toBeGreaterThan(0.8);
    expect(got / run.length).toBeLessThan(1.6);
  });

  test("many short turns past the sample size stay within 3%", () => {
    const turns = Array.from({ length: 3_000 }, (_, i) => transcript(200, 100 + i));
    const prompt: LanguageModelV4Prompt = turns.map((t) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: t }],
    }));
    const want = exact(turns);
    expect(Math.abs(estimateInput(prompt).inputTokens - want) / want).toBeLessThan(0.03);
  });

  test("symbol, box-drawing and blank-line runs and many tiny parts stay cheap", () => {
    estimateInput([{ role: "system", content: transcript(40_000, 9) }]);
    // 10 MB each: encoding one whole takes 350-700 ms, sampling about 10 ms whatever the size.
    const row = (s: string) => s.repeat(Math.ceil(10_000_000 / s.length)).slice(0, 10_000_000);
    const cases: LanguageModelV4Prompt[] = [
      ...[
        `|${"-".repeat(78)}|\n| a | 1 |\n`,
        `┌${"─".repeat(78)}┐\n`,
        "。",
        "\n",
        "\t",
        "\ud800",
      ].map(
        (s): LanguageModelV4Prompt => [{ role: "user", content: [{ type: "text", text: row(s) }] }],
      ),
    ];
    for (const prompt of cases) {
      expect(estimateInput(prompt).inputTokens).toBeGreaterThan(0);
      expect(fastestMs(() => estimateInput(prompt))).toBeLessThan(30);
    }
    // Every part is visited, so this one grows with the part count: about 20 ms here.
    const tiny: LanguageModelV4Prompt = Array.from({ length: 200_000 }, () => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "a" }],
    }));
    expect(estimateInput(tiny).inputTokens).toBeGreaterThan(0);
    expect(fastestMs(() => estimateInput(tiny))).toBeLessThan(100);
  });

  test("a call the provider never accepted: a 4xx or a connection error", () => {
    expect(reachedProvider({ statusCode: 400 })).toBe(false);
    expect(reachedProvider({ statusCode: 429 })).toBe(false);
    expect(reachedProvider({ code: "ECONNREFUSED" })).toBe(false);
    // Bun's own fetch failure, and the AI SDK's wrapper around one.
    expect(reachedProvider(Object.assign(new TypeError("x"), { code: "ConnectionRefused" }))).toBe(
      false,
    );
    expect(reachedProvider({ cause: { code: "ENOTFOUND" } })).toBe(false);
    // Thrown before the model request left (the compat speech step), whatever its status.
    expect(reachedProvider(markNotSent(Object.assign(new Error("x"), { statusCode: 503 })))).toBe(
      false,
    );
    expect(reachedProvider({ cause: markNotSent(new Error("transcription 500")) })).toBe(false);
  });

  test("a call the provider accepted: a 5xx, an abort or a timeout", () => {
    expect(reachedProvider({ statusCode: 500 })).toBe(true);
    expect(reachedProvider({ statusCode: 503 })).toBe(true);
    expect(reachedProvider(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(reachedProvider(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(reachedProvider(new Error("unknown"))).toBe(true);
  });
});
