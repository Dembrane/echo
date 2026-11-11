import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { withPayer } from "@dembrane/observability";
import { embed, generateText, streamText } from "ai";
import {
  FakeCompleter,
  FakeEmbedder,
  fakeCalls,
  fakeLanguageModel,
  fakeModels,
  lastPayer,
  type ModelCall,
  resetObserverFaults,
  takeObserverFaults,
  takeUnscopedFakeCalls,
} from "../src";

const ask = (text = "hi"): LanguageModelV4CallOptions => ({
  prompt: [{ role: "user", content: [{ type: "text", text }] }],
});
const project = { ref: "project", id: "p1" } as const;

beforeEach(() => {
  takeUnscopedFakeCalls();
});

describe("payer of fake calls", () => {
  test("a model call outside a scope is taken as unscoped", async () => {
    await fakeModels().model("multi_modal_pro").doGenerate(ask());
    expect(takeUnscopedFakeCalls()).toEqual([
      { kind: "generate", model: "fake/multi_modal_pro", payer: undefined },
    ]);
    expect(takeUnscopedFakeCalls()).toEqual([]);
    expect(fakeCalls()).toEqual([]);
  });

  test("inside withPayer the call is scoped and lastPayer names the payer", async () => {
    await withPayer(project, () => fakeModels().model("multi_modal_pro").doGenerate(ask()));
    expect(lastPayer()).toEqual(project);
    expect(fakeCalls()).toEqual([
      { kind: "generate", model: "fake/multi_modal_pro", payer: project },
    ]);
    expect(takeUnscopedFakeCalls()).toEqual([]);
    expect(lastPayer()).toBeUndefined();
  });

  test("FakeCompleter records the same way", async () => {
    const fake = new FakeCompleter().on("hi", "hello");
    await fake.complete({ group: "text_fast", user: "hi" });
    expect(takeUnscopedFakeCalls()).toEqual([
      { kind: "generate", model: "fake/text_fast", payer: undefined },
    ]);
    await withPayer(project, () => fake.complete({ group: "text_fast", user: "hi" }));
    expect(lastPayer()).toEqual(project);
    expect(takeUnscopedFakeCalls()).toEqual([]);
  });

  test("FakeEmbedder, streams and embeddings record their kind", async () => {
    await withPayer(project, async () => {
      await new FakeEmbedder().embed("a");
      const models = fakeModels();
      await embed({ model: models.embedding().model, value: "a" });
      const s = streamText({ model: models.model("text_fast"), prompt: "hi" });
      await s.text;
    });
    expect(fakeCalls().map((c) => [c.kind, c.model, c.payer])).toEqual([
      ["embed", "fake/embedding", project],
      ["embed", "fake/embedding", project],
      ["stream", "fake/text_fast", project],
    ]);
  });
});

describe("fakeLanguageModel", () => {
  // These call fakes outside a scope on purpose.
  afterEach(() => {
    takeUnscopedFakeCalls();
  });

  test("answers text, a function of the prompt, or a stream, and keeps the call options", async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const m = fakeLanguageModel({
      text: (p) => `echo ${JSON.stringify(p).includes("bus")}`,
      stream: ["a", "b"],
      calls,
    });
    expect((await generateText({ model: m, prompt: "bus" })).text).toBe("echo true");
    expect(await streamText({ model: m, prompt: "x" }).text).toBe("ab");
    expect(calls).toHaveLength(2);
  });

  test("a stream of parts carries tool calls and finishes with tool-calls", async () => {
    const call: LanguageModelV4StreamPart = {
      type: "tool-call",
      toolCallId: "a",
      toolName: "t",
      input: "{}",
    };
    const m = fakeLanguageModel({ stream: () => [call] });
    const r = await m.doStream(ask());
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const p of r.stream) parts.push(p);
    expect(parts.find((p) => p.type === "tool-call")).toEqual(call);
    expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls" } });
  });

  test("null text is a refusal, fail throws, and a delay honours the abort signal", async () => {
    const refused = await fakeLanguageModel({ text: () => null }).doGenerate(ask());
    expect(refused.content).toEqual([]);
    expect(refused.finishReason).toEqual({ unified: "content-filter", raw: "SAFETY" });
    const boom = new Error("boom");
    await expect(fakeLanguageModel({ fail: boom }).doGenerate(ask())).rejects.toBe(boom);
    const ctl = new AbortController();
    const hang = fakeLanguageModel({ delayMs: Number.POSITIVE_INFINITY }).doGenerate({
      ...ask(),
      abortSignal: ctl.signal,
    });
    ctl.abort(new Error("stop"));
    await expect(hang).rejects.toThrow("stop");
  });

  test("fakeModels reports each call to an observer with provider fake", async () => {
    const seen: ModelCall[] = [];
    const models = fakeModels({ observe: (c) => seen.push(c), usage: { input: 7, output: 3 } });
    await generateText({ model: models.model("multi_modal_fast"), prompt: "hi" });
    await embed({ model: models.embedding().model, value: "hi" });
    expect(seen.map((c) => [c.provider, c.kind, c.model, c.inputTokens])).toEqual([
      ["fake", "generate", "fake/multi_modal_fast", 7],
      ["fake", "embed", "fake/embedding", 1],
    ]);
    expect(models.embedding().dimensions).toBe(8);
  });
});

describe("FakeCompleter and FakeEmbedder report to an observer", () => {
  test("each call is one ModelCall with provider fake, a failed answer an error", async () => {
    const seen: ModelCall[] = [];
    const observe = (c: ModelCall) => seen.push(c);
    const fake = new FakeCompleter(undefined, { observe }).on("hi", {
      text: "hello",
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    await withPayer(project, async () => {
      await fake.complete({ group: "text_fast", user: "hi" });
      await expect(fake.complete({ group: "text_fast", user: "nope" })).rejects.toThrow();
      await new FakeEmbedder(8, "fake/embedding", { observe }).embed("a");
    });
    expect(seen.map((c) => [c.provider, c.kind, c.model, c.status, c.inputTokens])).toEqual([
      ["fake", "generate", "fake/text_fast", "ok", 7],
      ["fake", "generate", "fake/text_fast", "error", null],
      ["fake", "embed", "fake/embedding", "ok", 1],
    ]);
    expect(seen[0]).toMatchObject({ outputTokens: 3, finishReason: "stop" });
  });

  test("an observer fault reaches onObserverFault and never the caller", async () => {
    const faults: unknown[] = [];
    const observing = {
      observe: () => {
        throw new Error("sink down");
      },
      onObserverFault: (e: unknown) => faults.push(e),
    };
    resetObserverFaults();
    const text = await withPayer(project, () =>
      new FakeCompleter(undefined, observing)
        .on("hi", "hello")
        .complete({ group: "text_fast", user: "hi" }),
    );
    expect(text.text).toBe("hello");
    expect(faults).toHaveLength(1);
    expect(takeObserverFaults()).toHaveLength(1);
  });
});
