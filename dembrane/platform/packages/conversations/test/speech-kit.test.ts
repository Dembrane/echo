import { describe, expect, test } from "bun:test";
import { type LlmSettings, PROFILES } from "@dembrane/llm";
import { buildSpeechKit } from "../src";

const SETTINGS: LlmSettings = {
  provider: "openai-compatible",
  baseUrl: "https://scaleway.test/v1",
  apiKey: "k",
  searchGrounding: false,
  textFast: ["gemini-a"],
  multiModalFast: ["gemini-a"],
  multiModalPro: ["gemini-a"],
  compatTextFast: ["glm-5.3"],
  compatMultiModalFast: ["glm-5.3"],
  compatMultiModalPro: ["glm-5.3"],
  vertexProject: "",
  vertexLocation: "eu",
  embeddingModel: "text-embedding-004",
  compatEmbeddingModel: "qwen3-embedding-8b",
  embeddingLocation: "europe-west4",
  embeddingDimensions: 8,
};

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** Whisper answers with a stretch it is doubtful about, and every request is counted. */
function doubtfulWhisper() {
  const seen = { requests: 0 };
  const compatFetch = (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/audio/transcriptions")) return new Response("{}", { status: 404 });
    seen.requests++;
    return new Response(
      JSON.stringify({
        text: "hello",
        duration: 5,
        segments: [{ start: 0, end: 5, text: "hello", compression_ratio: 3.5 }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { seen, compatFetch };
}

describe("the second listen belongs to the worker", () => {
  const listen = async (withFinal: boolean) => {
    const { seen, compatFetch } = doubtfulWhisper();
    const kit = buildSpeechKit({
      settings: SETTINGS,
      profile: PROFILES["dembrane-26-10-whisper-eu"],
      hooks: { transport: { compatFetch } },
      logger: quiet,
      withFinal,
    });
    await kit.transcriber.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      language: "en",
      cutSpan: async () => new Uint8Array([1]),
    });
    return seen.requests;
  };

  test("the worker listens again to a doubtful stretch", async () => {
    expect(await listen(true)).toBeGreaterThan(1);
  });

  test("the API sends the audio once", async () => {
    expect(await listen(false)).toBe(1);
  });
});
