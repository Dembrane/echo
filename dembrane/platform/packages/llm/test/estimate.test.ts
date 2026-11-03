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
