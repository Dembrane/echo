import { describe, expect, test } from "bun:test";
import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { embed, generateText, streamText } from "ai";
import { FallbackModel, type ModelCall } from "../src";
import { errorLabel, observedEmbedding } from "../src/observe";

type Behaviour = "ok" | "safety" | 429 | 400 | 503 | "stream-error";

const usage = {
  inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 40, text: 40, reasoning: 0 },
};

function model(id: string, script: Behaviour[]): LanguageModelV4 {
  const next = () => script.shift() ?? "ok";
  const fail = (b: Behaviour) =>
    Object.assign(new Error(`${b}`), { statusCode: b, isRetryable: b !== 400 });
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate(_o: LanguageModelV4CallOptions) {
      const b = next();
      if (typeof b === "number") throw fail(b);
      return {
        content: b === "safety" ? [] : [{ type: "text" as const, text: `answer from ${id}` }],
        finishReason:
          b === "safety"
            ? { unified: "content-filter" as const, raw: "SAFETY" }
            : { unified: "stop" as const, raw: "STOP" },
        usage:
          b === "safety" ? { ...usage, outputTokens: { ...usage.outputTokens, total: 0 } } : usage,
        warnings: [],
      } as never;
    },
    async doStream(_o: LanguageModelV4CallOptions) {
      const b = next();
      if (typeof b === "number") throw fail(b);
      const parts: LanguageModelV4StreamPart[] =
        b === "stream-error"
          ? [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "half" },
              { type: "error", error: Object.assign(new Error("boom"), { statusCode: 503 }) },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", modelId: "ignored-by-metering" },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "hello " },
              { type: "text-delta", id: "t", delta: "world" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "STOP" }, usage },
            ];
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async pull(controller) {
            await Bun.sleep(2);
            const p = parts.shift();
            if (!p) controller.close();
            else controller.enqueue(p);
          },
        }),
      } as never;
    },
  };
}

const fast = { attemptsPerDeployment: 2, backoffMs: 0, sleep: async () => {} };

function group(script: Record<string, Behaviour[]>, calls: ModelCall[]) {
  return new FallbackModel(
    "text_fast",
    Object.entries(script).map(([id, s]) => ({ label: id, model: model(id, s) })),
    { ...fast, observe: (c) => calls.push(c) },
  );
}

describe("observe", () => {
  test("a generate call reports its tokens, time, model and finish reason", async () => {
    const calls: ModelCall[] = [];
    await generateText({ model: group({ "gemini-a": ["ok"] }, calls), prompt: "hi" });
    expect(calls).toHaveLength(1);
    const [c] = calls as [ModelCall];
    expect(c).toMatchObject({
      group: "text_fast",
      model: "gemini-a",
      kind: "generate",
      status: "ok",
      error: null,
      finishReason: "stop",
      inputTokens: 120,
      outputTokens: 40,
      attempt: 1,
      fallback: false,
    });
    expect(c.ms).toBeGreaterThanOrEqual(0);
    expect(c.startedAt).toBeInstanceOf(Date);
  });

  test("a refusal is an ok call with the vendor's reason and no output", async () => {
    const calls: ModelCall[] = [];
    await generateText({ model: group({ "gemini-a": ["safety"] }, calls), prompt: "hi" });
    expect(calls[0]).toMatchObject({ status: "ok", finishReason: "safety", outputTokens: 0 });
  });

  test("every attempt is one call; the fallback deployment is marked", async () => {
    const calls: ModelCall[] = [];
    const m = group({ "gemini-a": [429, 503], "gemini-b": ["ok"] }, calls);
    const { text } = await generateText({ model: m, prompt: "hi" });
    expect(text).toBe("answer from gemini-b");
    expect(calls.map((c) => [c.model, c.status, c.error, c.attempt, c.fallback])).toEqual([
      ["gemini-a", "error", "http_429", 1, false],
      ["gemini-a", "error", "http_503", 2, false],
      ["gemini-b", "ok", null, 3, true],
    ]);
  });

  test("a bad request is reported once and not retried", async () => {
    const calls: ModelCall[] = [];
    const m = group({ "gemini-a": [400], "gemini-b": ["ok"] }, calls);
    await expect(generateText({ model: m, prompt: "hi" })).rejects.toThrow("400");
    expect(calls.map((c) => c.error)).toEqual(["http_400"]);
  });

  test("a stream reports when its last part has passed, with the finish usage", async () => {
    const calls: ModelCall[] = [];
    const result = streamText({ model: group({ "gemini-a": ["ok"] }, calls), prompt: "hi" });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("hello world");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "stream",
      model: "gemini-a",
      status: "ok",
      finishReason: "stop",
      inputTokens: 120,
      outputTokens: 40,
    });
    expect((calls[0] as ModelCall).ms).toBeGreaterThanOrEqual(10);
  });

  test("a stream that fails after its first part is one failed call", async () => {
    const calls: ModelCall[] = [];
    const result = streamText({
      model: group({ "gemini-a": ["stream-error"] }, calls),
      prompt: "hi",
      onError: () => {},
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("half");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "stream", status: "error", error: "http_503" });
  });

  test("a stream the reader abandons is reported as cancelled", async () => {
    const calls: ModelCall[] = [];
    const m = group({ "gemini-a": ["ok"] }, calls);
    const { stream } = await m.doStream({ prompt: [] });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("gone");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "stream", status: "error", error: "error" });
  });

  test("an embedding reports its input tokens", async () => {
    const calls: ModelCall[] = [];
    const raw: EmbeddingModelV4 = {
      specificationVersion: "v4",
      provider: "fake",
      modelId: "embed-1",
      maxEmbeddingsPerCall: 1,
      supportsParallelCalls: false,
      async doEmbed() {
        return { embeddings: [[0.1, 0.2]], usage: { tokens: 7 }, warnings: [] } as never;
      },
    };
    const m = observedEmbedding(raw, "embedding", (c) => calls.push(c));
    await embed({ model: m, value: "hi" });
    expect(calls[0]).toMatchObject({
      group: "embedding",
      model: "embed-1",
      kind: "embed",
      inputTokens: 7,
      outputTokens: null,
      status: "ok",
    });
  });

  test("an error label is a code or a class, never a message", () => {
    expect(errorLabel(Object.assign(new Error("secret prompt"), { statusCode: 429 }))).toBe(
      "http_429",
    );
    expect(errorLabel(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("econnreset");
    expect(errorLabel(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(
      "timeouterror",
    );
    expect(errorLabel(new Error("plain"))).toBe("error");
    expect(errorLabel(new RangeError("plain"))).toBe("RangeError");
    expect(errorLabel("string")).toBe("error");
  });
});
