import { afterEach, describe, expect, test } from "bun:test";
import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { payer, withPayer } from "@dembrane/observability";
import { embed, generateText, streamText } from "ai";
import {
  CompatLanguageModel,
  FallbackModel,
  type ModelCall,
  resetObserverFaults,
  takeObserverFaults,
} from "../src";
import { MAX_AUDIO_BYTES } from "../src/compat";
import { estimateText } from "../src/estimate";
import {
  type CallMeta,
  errorLabel,
  generateCall,
  observedEmbedding,
  observedStream,
  observeSafely,
} from "../src/observe";

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
    const m = observedEmbedding(raw, "embedding", (make) => calls.push(make()));
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

describe("every billable unit", () => {
  const billed = {
    inputTokens: { total: 1000, noCache: 800, cacheRead: 200, cacheWrite: undefined },
    outputTokens: { total: 500, text: 100, reasoning: 400 },
    raw: {
      promptTokensDetails: [
        { modality: "AUDIO", tokenCount: 960 },
        { modality: "TEXT", tokenCount: 40 },
      ],
    },
  };
  const grounded = { vertex: { groundingMetadata: { webSearchQueries: ["a", "b"] } } };
  const meta: CallMeta = {
    group: "multi_modal_pro",
    provider: "vertex",
    model: "gemini-a",
    attempt: 1,
    fallback: false,
  };
  const units = {
    provider: "vertex",
    inputTokens: 1000,
    cachedInputTokens: 200,
    audioInputTokens: 960,
    outputTokens: 500,
    reasoningTokens: 400,
    audioSeconds: null,
    searchQueries: 2,
    usageEstimated: false,
  };
  const generated = (over: Record<string, unknown>) =>
    generateCall(meta, new Date(), performance.now(), {
      content: [],
      finishReason: { unified: "stop", raw: "STOP" },
      usage: billed,
      warnings: [],
      ...over,
    } as never);

  test("a generate call reports cached, audio and reasoning tokens and search lookups", () => {
    expect(generated({ providerMetadata: grounded })).toMatchObject(units);
  });

  test("search lookups are read under every Google metadata key, and are null when absent", () => {
    const queries = { groundingMetadata: { webSearchQueries: ["a", "b", "c"] } };
    expect(generated({ providerMetadata: { googleVertex: queries } }).searchQueries).toBe(3);
    expect(generated({ providerMetadata: { google: queries } }).searchQueries).toBe(3);
    expect(generated({}).searchQueries).toBeNull();
    expect(
      generated({ providerMetadata: { vertex: { groundingMetadata: null } } }).searchQueries,
    ).toBeNull();
  });

  test("audio tokens are null without Google's prompt details, zero when none were audio", () => {
    const { raw: _, ...plain } = billed;
    expect(generated({ usage: plain }).audioInputTokens).toBeNull();
    const text = { ...billed, raw: { promptTokensDetails: [{ modality: "TEXT", tokenCount: 9 }] } };
    expect(generated({ usage: text }).audioInputTokens).toBe(0);
  });

  test("a stream reports the same units from its finish part", async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: "text-delta", id: "t", delta: "hi" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "STOP" },
        usage: billed,
        providerMetadata: grounded,
      },
    ];
    const calls: ModelCall[] = [];
    const stream = observedStream(
      new ReadableStream({
        pull(c) {
          const p = parts.shift();
          if (p) c.enqueue(p);
          else c.close();
        },
      }),
      meta,
      new Date(),
      performance.now(),
      (make) => calls.push(make()),
      [],
    );
    for await (const _ of stream);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ...units, kind: "stream", status: "ok" });
  });

  test("an embedding names its provider and counts input tokens only", async () => {
    const calls: ModelCall[] = [];
    const raw: EmbeddingModelV4 = {
      specificationVersion: "v4",
      provider: "fake",
      modelId: "embed-1",
      maxEmbeddingsPerCall: 1,
      supportsParallelCalls: false,
      async doEmbed() {
        return { embeddings: [[0.1]], usage: { tokens: 7 }, warnings: [] } as never;
      },
    };
    const m = observedEmbedding(raw, "embedding", (make) => calls.push(make()), "vertex");
    await embed({ model: m, value: "hi" });
    expect(calls[0]).toMatchObject({
      provider: "vertex",
      inputTokens: 7,
      cachedInputTokens: null,
      audioInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      audioSeconds: null,
      searchQueries: null,
      usageEstimated: false,
    });
  });

  test("a failed call has no units and names its provider", async () => {
    const calls: ModelCall[] = [];
    await expect(
      generateText({ model: group({ "gemini-a": [400] }, calls), prompt: "hi" }),
    ).rejects.toThrow("400");
    expect(calls[0]).toMatchObject({
      provider: "fake",
      status: "error",
      inputTokens: null,
      cachedInputTokens: null,
      audioInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      audioSeconds: null,
      searchQueries: null,
      usageEstimated: false,
    });
  });
});

describe("a failed or cancelled call keeps or estimates its usage", () => {
  const meta: CallMeta = {
    group: "text_fast",
    provider: "vertex",
    model: "gemini-a",
    attempt: 1,
    fallback: false,
  };
  const prompt: LanguageModelV4Prompt = [
    { role: "system", content: "You answer questions about the town." },
    { role: "user", content: [{ type: "text", text: "What did people say about bikes?" }] },
  ];
  const promptTokens =
    estimateText("You answer questions about the town.") +
    estimateText("What did people say about bikes?");

  function observed(parts: LanguageModelV4StreamPart[], calls: ModelCall[]) {
    return observedStream(
      new ReadableStream({
        pull(c) {
          const p = parts.shift();
          if (p) c.enqueue(p);
          else c.close();
        },
      }),
      meta,
      new Date(),
      performance.now(),
      (make) => calls.push(make()),
      prompt,
    );
  }

  test("a stream cancelled mid-answer estimates its input and the text streamed so far", async () => {
    const calls: ModelCall[] = [];
    const reader = observed(
      [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Hello" },
        { type: "text-delta", id: "t", delta: " there" },
        { type: "text-delta", id: "t", delta: " never read" },
      ],
      calls,
    ).getReader();
    for (let i = 0; i < 3; i++) await reader.read();
    await reader.cancel("user pressed stop");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      status: "error",
      usageEstimated: true,
      inputTokens: promptTokens,
      audioInputTokens: 0,
      outputTokens: estimateText("Hello there"),
      reasoningTokens: null,
      cachedInputTokens: null,
    });
    expect((calls[0] as ModelCall).inputTokens).toBeGreaterThan(0);
  });

  test("a stream that errors without a finish part estimates the same way", async () => {
    const calls: ModelCall[] = [];
    const stream = observed(
      [
        { type: "text-delta", id: "t", delta: "Hello" },
        { type: "error", error: Object.assign(new Error("boom"), { statusCode: 503 }) },
      ],
      calls,
    );
    for await (const _ of stream);
    expect(calls[0]).toMatchObject({
      status: "error",
      error: "http_503",
      usageEstimated: true,
      inputTokens: promptTokens,
      outputTokens: estimateText("Hello"),
    });
  });

  test("a stream that ends cleanly without a finish part estimates its usage", async () => {
    const calls: ModelCall[] = [];
    const stream = observed([{ type: "text-delta", id: "t", delta: "Hello there" }], calls);
    for await (const _ of stream);
    expect(calls[0]).toMatchObject({
      status: "ok",
      error: null,
      usageEstimated: true,
      inputTokens: promptTokens,
      outputTokens: estimateText("Hello there"),
    });
  });

  test("a stream that errors after its finish part keeps the provider's usage", async () => {
    const calls: ModelCall[] = [];
    const stream = observed(
      [
        { type: "text-delta", id: "t", delta: "Hello" },
        { type: "finish", finishReason: { unified: "stop", raw: "STOP" }, usage },
        { type: "error", error: Object.assign(new Error("boom"), { statusCode: 503 }) },
      ],
      calls,
    );
    for await (const _ of stream);
    expect(calls[0]).toMatchObject({
      status: "error",
      error: "http_503",
      usageEstimated: false,
      inputTokens: 120,
      outputTokens: 40,
      reasoningTokens: 0,
    });
  });

  test("a generate the provider accepted and then failed estimates its input, output 0", async () => {
    const calls: ModelCall[] = [];
    const m = group({ "gemini-a": [503, 503] }, calls);
    await expect(m.doGenerate({ prompt })).rejects.toThrow("503");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      status: "error",
      error: "http_503",
      usageEstimated: true,
      inputTokens: promptTokens,
      audioInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
    });
  });

  test("a generate the provider refused costs nothing", async () => {
    const calls: ModelCall[] = [];
    const m = group({ "gemini-a": [400] }, calls);
    await expect(m.doGenerate({ prompt })).rejects.toThrow("400");
    expect(calls[0]).toMatchObject({
      status: "error",
      error: "http_400",
      usageEstimated: false,
      inputTokens: null,
      outputTokens: null,
    });
  });

  test("a stream that fails to open is a failed generate: 5xx estimated, 4xx free", async () => {
    const calls: ModelCall[] = [];
    await expect(group({ "gemini-a": [503, 400] }, calls).doStream({ prompt })).rejects.toThrow(
      "400",
    );
    expect(calls.map((c) => [c.kind, c.inputTokens, c.outputTokens, c.usageEstimated])).toEqual([
      ["stream", promptTokens, 0, true],
      ["stream", null, null, false],
    ]);
  });

  test("special-token text in the prompt or the answer is still estimated", async () => {
    const calls: ModelCall[] = [];
    const special: LanguageModelV4Prompt = [
      { role: "user", content: [{ type: "text", text: "people said <|endoftext|> about bikes" }] },
    ];
    const reader = observedStream(
      new ReadableStream<LanguageModelV4StreamPart>({
        start(c) {
          c.enqueue({ type: "text-delta", id: "t", delta: "they said <|endoftext|>" });
        },
      }),
      meta,
      new Date(),
      performance.now(),
      (make) => calls.push(make()),
      special,
    ).getReader();
    await reader.read();
    await reader.cancel("stop");
    expect(calls[0]).toMatchObject({
      usageEstimated: true,
      inputTokens: estimateText("people said <|endoftext|> about bikes"),
      outputTokens: estimateText("they said <|endoftext|>"),
    });
    expect((calls[0] as ModelCall).outputTokens).toBeGreaterThan(0);
  });

  test("a stream cancelled through the fallback model estimates from the caller's prompt", async () => {
    const calls: ModelCall[] = [];
    const { stream } = await group({ "gemini-a": ["ok"] }, calls).doStream({ prompt });
    const reader = stream.getReader();
    for (let i = 0; i < 4; i++) await reader.read();
    await reader.cancel("gone");
    expect(calls[0]).toMatchObject({
      status: "error",
      usageEstimated: true,
      inputTokens: promptTokens,
      outputTokens: estimateText("hello "),
    });
  });
});

describe("an openai-compatible chat call is billed for what its chat model got", () => {
  const audioPrompt = (bytes: number): LanguageModelV4Prompt => [
    {
      role: "user",
      content: [
        { type: "text", text: "Summarise what people said." },
        {
          type: "file",
          mediaType: "audio/mp3",
          data: { type: "data", data: new Uint8Array(bytes) },
        },
      ],
    },
  ];
  function compat(transcription: () => Response, chat: Behaviour[], calls: ModelCall[]) {
    const inner = model("glm-5.3", chat);
    const sent: unknown[] = [];
    const spy: LanguageModelV4 = {
      ...inner,
      doGenerate: (o) => {
        sent.push(o);
        return inner.doGenerate(o);
      },
      doStream: (o) => {
        sent.push(o);
        return inner.doStream(o);
      },
    };
    const m = new FallbackModel(
      "text_fast",
      [
        {
          label: "glm",
          provider: "openai-compatible",
          model: new CompatLanguageModel(spy, {
            baseUrl: "https://llm.example/v1",
            apiKey: "k",
            transcriptionModel: "whisper-large-v3",
            fetch: (async () => transcription()) as unknown as typeof fetch,
          }),
        },
      ],
      { ...fast, attemptsPerDeployment: 1, observe: (c) => calls.push(c) },
    );
    return { m, sent };
  }

  test("a failed speech step costs the chat call nothing", async () => {
    const calls: ModelCall[] = [];
    const { m, sent } = compat(() => new Response("down", { status: 500 }), ["ok"], calls);
    await expect(m.doGenerate({ prompt: audioPrompt(80_000) })).rejects.toThrow(
      "transcription 500",
    );
    await expect(m.doStream({ prompt: audioPrompt(80_000) })).rejects.toThrow("transcription 500");
    expect(sent).toHaveLength(0);
    expect(calls.map((c) => [c.kind, c.inputTokens, c.outputTokens, c.usageEstimated])).toEqual([
      ["generate", null, null, false],
      ["stream", null, null, false],
    ]);
  });

  test("audio too large for the speech endpoint costs the chat call nothing", async () => {
    const calls: ModelCall[] = [];
    const { m, sent } = compat(() => Response.json({ text: "never" }), ["ok"], calls);
    await expect(m.doGenerate({ prompt: audioPrompt(MAX_AUDIO_BYTES + 1) })).rejects.toThrow(
      "bytes",
    );
    expect(sent).toHaveLength(0);
    expect(calls[0]).toMatchObject({ inputTokens: null, usageEstimated: false });
  });

  test("a chat call that fails after the transcript is estimated without audio tokens", async () => {
    const calls: ModelCall[] = [];
    const { m, sent } = compat(() => Response.json({ text: "hello" }), [503], calls);
    await expect(m.doGenerate({ prompt: audioPrompt(80_000) })).rejects.toThrow("503");
    expect(sent).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: "openai-compatible",
      usageEstimated: true,
      inputTokens: estimateText("Summarise what people said."),
      audioInputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("a faulty observer never changes a call", () => {
  // These fault on purpose; the preload fails any test that leaves a fault behind.
  afterEach(() => {
    takeObserverFaults();
  });
  const boom = () => {
    throw new Error("metering is broken");
  };
  // A model whose scripted answers are consumed, so an untouched script proves no call.
  const scripted = (id: string, script: Behaviour[]) => ({ id, script, model: model(id, script) });

  test("generate keeps its result, the fallback stays untried, the fault is reported once", async () => {
    resetObserverFaults();
    const faults: unknown[] = [];
    const a = scripted("gemini-a", ["ok", "ok"]);
    const b = scripted("gemini-b", ["ok"]);
    const m = new FallbackModel(
      "text_fast",
      [
        { label: "a", model: a.model },
        { label: "b", model: b.model },
      ],
      { ...fast, observe: boom, onObserverFault: (err) => faults.push(err) },
    );
    expect((await generateText({ model: m, prompt: "hi" })).text).toBe("answer from gemini-a");
    expect((await generateText({ model: m, prompt: "hi" })).text).toBe("answer from gemini-a");
    expect(b.script).toEqual(["ok"]);
    expect(faults).toHaveLength(1);
    expect(String(faults[0])).toContain("metering is broken");
  });

  test("a failing call still fails with its own error, and retries as before", async () => {
    resetObserverFaults();
    const m = group({ "gemini-a": [429, "ok"] }, []);
    const faulty = new FallbackModel(
      "text_fast",
      [{ label: "a", model: model("gemini-a", [400]) }],
      {
        ...fast,
        observe: boom,
        onObserverFault: () => {},
      },
    );
    await expect(generateText({ model: faulty, prompt: "hi" })).rejects.toThrow("400");
    expect((await generateText({ model: m, prompt: "hi" })).text).toBe("answer from gemini-a");
  });

  test("a stream delivers every part and closes normally", async () => {
    resetObserverFaults();
    const m = new FallbackModel("text_fast", [{ label: "a", model: model("gemini-a", ["ok"]) }], {
      ...fast,
      observe: boom,
      onObserverFault: () => {},
    });
    const { stream } = await m.doStream({ prompt: [] });
    const parts: string[] = [];
    for await (const part of stream) parts.push(part.type);
    expect(parts).toEqual([
      "stream-start",
      "response-metadata",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const result = streamText({ model: m, prompt: "hi" });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("hello world");
  });

  test("an embedding keeps its vector", async () => {
    resetObserverFaults();
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
    const faults: unknown[] = [];
    const m = observedEmbedding(raw, "embedding", (make) =>
      observeSafely(boom, (err) => faults.push(err), make),
    );
    expect((await embed({ model: m, value: "hi" })).embedding).toEqual([0.1, 0.2]);
    expect(faults).toHaveLength(1);
  });

  test("a mapping fault on an odd provider result is held the same way", async () => {
    resetObserverFaults();
    const odd: LanguageModelV4 = {
      ...model("gemini-odd", ["ok"]),
      async doGenerate() {
        // No usage and no finish reason at all: the mapping must cope, and if it did not, the guard would.
        return { content: [{ type: "text", text: "odd" }], warnings: [] } as never;
      },
    };
    const calls: ModelCall[] = [];
    const m = new FallbackModel("text_fast", [{ label: "odd", model: odd }], {
      ...fast,
      observe: (c) => calls.push(c),
      onObserverFault: () => {},
    });
    // Straight to the model: the AI SDK itself refuses a result without usage.
    const r = await m.doGenerate({ prompt: [] });
    expect((r.content[0] as { text: string }).text).toBe("odd");
    expect(calls[0]).toMatchObject({ status: "ok", inputTokens: null, finishReason: null });
  });
});

describe("a stream reports in the scope it was created in", () => {
  const meta: CallMeta = {
    group: "multi_modal_pro",
    provider: "fake",
    model: "m",
    attempt: 1,
    fallback: false,
  };
  const scope = { ref: "chat", id: "c-1" } as const;
  const source = () =>
    new ReadableStream<LanguageModelV4StreamPart>({
      start(c) {
        c.enqueue({ type: "text-delta", id: "t", delta: "hi" });
        c.enqueue({ type: "text-delta", id: "t", delta: " there" });
        c.close();
      },
    });
  const created = (seen: unknown[]) =>
    withPayer(scope, () =>
      observedStream(
        source(),
        meta,
        new Date(),
        performance.now(),
        (make) => {
          seen.push(payer());
          make();
        },
        [],
      ),
    );

  test("read to the end from outside the scope", async () => {
    const seen: unknown[] = [];
    const stream = created(seen);
    expect(payer()).toBeUndefined();
    for await (const _ of stream);
    expect(seen).toEqual([scope]);
  });

  test("cancelled from outside the scope", async () => {
    const seen: unknown[] = [];
    const reader = created(seen).getReader();
    await reader.read();
    await reader.cancel();
    expect(seen).toEqual([scope]);
  });
});
