import { describe, expect, test } from "bun:test";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { completeWith, FallbackModel, type ModelCall, TRACE_KEY, withTrace } from "../src";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

/** A model that remembers the options it was called with. */
function model(seen: LanguageModelV4CallOptions[]): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "m",
    supportedUrls: {},
    async doGenerate(o) {
      seen.push(o);
      return {
        content: [{ type: "text", text: "hi" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      } as never;
    },
    async doStream(o) {
      seen.push(o);
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "hi" },
        { type: "text-end", id: "1" },
        { type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } },
      ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      } as never;
    },
  };
}

const trace = {
  step: "verify.generate",
  promptRef: "generate_artifact",
  promptVersion: "abc123",
  targetType: "conversation_artifact",
  targetId: "t1",
};

describe("call trace", () => {
  test("a generated call is observed with its trace, which never reaches the provider", async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const calls: ModelCall[] = [];
    const m = new FallbackModel("g", [{ label: "a", model: model(seen) }], {
      observe: (c) => calls.push(c),
    });
    await generateText({
      model: m,
      prompt: "x",
      providerOptions: withTrace(trace, { vertex: { thinkingConfig: { thinkingBudget: 1 } } }),
    });
    expect(seen[0]?.providerOptions?.[TRACE_KEY]).toBeUndefined();
    expect(seen[0]?.providerOptions?.vertex).toEqual({ thinkingConfig: { thinkingBudget: 1 } });
    expect(calls[0]?.trace).toEqual(trace);
  });

  test("a stream carries its trace too", async () => {
    const calls: ModelCall[] = [];
    const m = new FallbackModel("g", [{ label: "a", model: model([]) }], {
      observe: (c) => calls.push(c),
    });
    const result = streamText({ model: m, prompt: "x", providerOptions: withTrace(trace) });
    expect(await result.text).toBe("hi");
    expect(calls[0]).toMatchObject({ kind: "stream", status: "ok", trace });
  });

  test("an untraced call has no trace", async () => {
    const calls: ModelCall[] = [];
    const m = new FallbackModel("g", [{ label: "a", model: model([]) }], {
      observe: (c) => calls.push(c),
    });
    await generateText({ model: m, prompt: "x" });
    expect(calls[0] && "trace" in calls[0]).toBe(false);
  });

  test("completeWith carries the request's trace", async () => {
    const calls: ModelCall[] = [];
    const m = new FallbackModel("g", [{ label: "a", model: model([]) }], {
      observe: (c) => calls.push(c),
    });
    await completeWith(m, { group: "text_fast", user: "x", trace: { step: "report" } });
    expect(calls[0]?.trace).toEqual({ step: "report" });
  });
});
