import { describe, expect, test } from "bun:test";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { generateText } from "ai";
import { FallbackModel, isRetryable } from "../src";

type Behaviour = "ok" | 429 | 400 | 503;

function model(id: string, script: Behaviour[], calls: string[]): LanguageModelV4 {
  const result = {
    content: [{ type: "text" as const, text: `answer from ${id}` }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 4, text: 4, reasoning: 0 },
    },
    warnings: [],
  };
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate(_o: LanguageModelV4CallOptions) {
      const next = script.shift() ?? "ok";
      calls.push(`${id}:${next}`);
      if (next !== "ok")
        throw Object.assign(new Error(`${next}`), { statusCode: next, isRetryable: next !== 400 });
      return result as never;
    },
    async doStream() {
      throw new Error("not used");
    },
  };
}

const fast = { attemptsPerDeployment: 2, backoffMs: 0, sleep: async () => {} };

describe("fallback", () => {
  test("the primary answers when healthy", async () => {
    const calls: string[] = [];
    const m = new FallbackModel(
      "text_fast",
      [
        { label: "a", model: model("a", ["ok"], calls) },
        { label: "b", model: model("b", [], calls) },
      ],
      fast,
    );
    const { text } = await generateText({ model: m, prompt: "hi" });
    expect(text).toBe("answer from a");
    expect(calls).toEqual(["a:ok"]);
  });

  test("a rate-limited primary is retried once, then the next deployment answers", async () => {
    const calls: string[] = [];
    const m = new FallbackModel(
      "g",
      [
        { label: "a", model: model("a", [429, 429], calls) },
        { label: "b", model: model("b", ["ok"], calls) },
      ],
      fast,
    );
    const { text } = await generateText({ model: m, prompt: "hi", maxRetries: 0 });
    expect(text).toBe("answer from b");
    expect(calls).toEqual(["a:429", "a:429", "b:ok"]);
  });

  test("a bad request is not retried anywhere", async () => {
    const calls: string[] = [];
    const m = new FallbackModel(
      "g",
      [
        { label: "a", model: model("a", [400], calls) },
        { label: "b", model: model("b", ["ok"], calls) },
      ],
      fast,
    );
    await expect(generateText({ model: m, prompt: "hi", maxRetries: 0 })).rejects.toThrow("400");
    expect(calls).toEqual(["a:400"]);
  });

  test("a deployment that failed three times within a minute is skipped until the cooldown passes", async () => {
    let now = 0;
    const calls: string[] = [];
    const m = new FallbackModel(
      "g",
      [
        { label: "a", model: model("a", [503, 503, 503, "ok"], calls) },
        { label: "b", model: model("b", [], calls) },
      ],
      { ...fast, attemptsPerDeployment: 3, now: () => now },
    );
    await generateText({ model: m, prompt: "1", maxRetries: 0 });
    expect(calls).toEqual(["a:503", "a:503", "a:503", "b:ok"]);
    calls.length = 0;
    await generateText({ model: m, prompt: "2", maxRetries: 0 });
    expect(calls).toEqual(["b:ok"]);
    now = 61_000;
    calls.length = 0;
    await generateText({ model: m, prompt: "3", maxRetries: 0 });
    expect(calls).toEqual(["a:ok"]);
  });

  test("when every deployment fails, the last error surfaces", async () => {
    const calls: string[] = [];
    const m = new FallbackModel("g", [{ label: "a", model: model("a", [503, 503], calls) }], fast);
    await expect(generateText({ model: m, prompt: "hi", maxRetries: 0 })).rejects.toThrow("503");
  });

  test("retryable classification", () => {
    expect(isRetryable({ statusCode: 429 })).toBe(true);
    expect(isRetryable({ statusCode: 503 })).toBe(true);
    expect(isRetryable({ statusCode: 404 })).toBe(false);
    expect(isRetryable({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryable(new Error("x"))).toBe(false);
  });
});
