import { describe, expect, test } from "bun:test";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { type CallRecord, completeWith, FallbackModel, TRACE_KEY, withTrace } from "../src";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

/** A model that remembers the options it was called with. */
function model(seen: LanguageModelV4CallOptions[], fail = false): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "m",
    supportedUrls: {},
    async doGenerate(o) {
      seen.push(o);
      if (fail) throw Object.assign(new Error("bad"), { statusCode: 400, isRetryable: false });
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
  test("a generated call is reported with its trace, and the trace never reaches the provider", async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const calls: CallRecord[] = [];
    const m = new FallbackModel("multi_modal_pro", [{ label: "a", model: model(seen) }], {
      onCall: (r) => calls.push(r),
    });
    await generateText({
      model: m,
      prompt: "x",
      providerOptions: withTrace(trace, { vertex: { thinkingConfig: { thinkingBudget: 1 } } }),
    });
    expect(seen[0]?.providerOptions?.[TRACE_KEY]).toBeUndefined();
    expect(seen[0]?.providerOptions?.vertex).toEqual({ thinkingConfig: { thinkingBudget: 1 } });
    expect(calls).toEqual([
      {
        group: "multi_modal_pro",
        deployment: "a",
        trace,
        status: "ok",
        streamed: false,
        inputTokens: 3,
        outputTokens: 4,
        latencyMs: expect.any(Number),
      },
    ]);
  });

  test("a failed call is reported as an error and still throws", async () => {
    const calls: CallRecord[] = [];
    const m = new FallbackModel("g", [{ label: "a", model: model([], true) }], {
      onCall: (r) => calls.push(r),
    });
    await expect(generateText({ model: m, prompt: "x", maxRetries: 0 })).rejects.toThrow();
    expect(calls.map((c) => [c.status, c.deployment, c.trace])).toEqual([["error", null, null]]);
  });

  test("a stream is reported when it ends, with the usage of its finish part", async () => {
    const calls: CallRecord[] = [];
    const m = new FallbackModel("g", [{ label: "a", model: model([]) }], {
      onCall: (r) => calls.push(r),
    });
    const result = streamText({ model: m, prompt: "x", providerOptions: withTrace(trace) });
    expect(await result.text).toBe("hi");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ streamed: true, status: "ok", inputTokens: 3, trace });
  });

  test("a broken log does not fail the call", async () => {
    const m = new FallbackModel("g", [{ label: "a", model: model([]) }], {
      onCall: () => {
        throw new Error("log down");
      },
    });
    const { text } = await generateText({ model: m, prompt: "x" });
    expect(text).toBe("hi");
  });

  test("completeWith carries the request's trace", async () => {
    const calls: CallRecord[] = [];
    const m = new FallbackModel("g", [{ label: "a", model: model([]) }], {
      onCall: (r) => calls.push(r),
    });
    await completeWith(m, { group: "text_fast", user: "x", trace: { step: "report" } });
    expect(calls[0]?.trace).toEqual({ step: "report" });
  });
});
