import { describe, expect, test } from "bun:test";
import type { ModelCall } from "@dembrane/llm";
import { type Payer, withCorrelation, withPayer } from "@dembrane/observability";
import {
  type ModelCallSink,
  modelCallRecorder,
  type PendingCall,
  type PriceRow,
  type PriceSnapshot,
  type SpendBucket,
  toRow,
} from "../src";

const call = (over: Partial<ModelCall> = {}): ModelCall => ({
  group: "multi_modal_pro",
  provider: "vertex",
  model: "gemini-3.8-flash",
  kind: "generate",
  startedAt: new Date("2026-10-11T12:00:00Z"),
  ms: 1234,
  inputTokens: 5000,
  cachedInputTokens: null,
  audioInputTokens: null,
  outputTokens: 300,
  reasoningTokens: null,
  audioSeconds: null,
  searchQueries: null,
  usageEstimated: false,
  finishReason: "stop",
  status: "ok",
  error: null,
  attempt: 1,
  fallback: false,
  ...over,
});

// One micro-euro per input token, two per output token: the default call costs 5,600.
const FLASH: PriceRow = {
  id: 7,
  provider: "vertex",
  model: "gemini-3.8-flash",
  source: "override",
  effectiveFrom: new Date("2026-10-01T00:00:00Z"),
  currency: "EUR",
  inputPerM: 1,
  cachedInputPerM: null,
  audioInputPerM: null,
  outputPerM: 2,
  longContext: null,
  perAudioSecond: null,
  perSearchQuery: null,
};

function stubBook(rows: PriceRow[] = [FLASH]) {
  const snap = (r: PriceRow[]): PriceSnapshot => ({
    prices: new Map(r.map((p) => [`${p.provider}/${p.model}`, p])),
    usdToEur: 1,
  });
  let current = snap(rows);
  return {
    current: () => current,
    set: (r: PriceRow[]) => {
      current = snap(r);
    },
  };
}

function fakeLogger() {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const at =
    (level: string) =>
    (fields: Record<string, unknown>, message = "") =>
      lines.push({ level, fields, message });
  return {
    lines,
    logger: { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") } as never,
  };
}

interface Written {
  batch: PendingCall[];
  spend: SpendBucket[];
}

function fakeSink(failTimes = 0): ModelCallSink & { writes: Written[] } {
  const writes: Written[] = [];
  let fails = failTimes;
  return {
    writes,
    async write(batch, spend) {
      if (fails > 0) {
        fails--;
        throw new Error("db down");
      }
      writes.push({ batch: [...batch], spend: [...spend.values()] });
    },
  };
}

const total = (spend: readonly SpendBucket[]) => spend.reduce((s, b) => s + b.costMicroEur, 0);
const project: Payer = { ref: "project", id: "0b7f3c1e-6d4a-4a8e-9f00-000000000001" };

describe("model call recorder", () => {
  test("logs one line per call and writes a batch per flush with the operation", async () => {
    const sink = fakeSink();
    const { logger, lines } = fakeLogger();
    const r = modelCallRecorder({
      sink,
      logger,
      service: "echo-worker",
      prices: stubBook(),
      flushMs: 60_000,
    });
    withCorrelation({ requestId: "job-1", operation: "conversations.chunk" }, () => {
      r.observe(call());
      r.observe(call({ attempt: 2, fallback: true, model: "gemini-3.7-flash" }));
    });
    r.observe(call({ status: "error", error: "http_429", inputTokens: null, outputTokens: null }));
    const calls = lines.filter((l) => l.message === "model call");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.fields).toMatchObject({
      signal: "model.call",
      operation: "conversations.chunk",
      group: "multi_modal_pro",
      model: "gemini-3.8-flash",
      ms: 1234,
      input_tokens: 5000,
      output_tokens: 300,
      finish_reason: "stop",
    });
    expect(calls[2]?.fields).toMatchObject({ operation: null, status: "error", error: "http_429" });
    expect(sink.writes).toHaveLength(0);
    await r.flush();
    expect(sink.writes).toHaveLength(1);
    const rows = sink.writes[0]?.batch.map((p) => p.row) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      service: "echo-worker",
      operation: "conversations.chunk",
      request_id: "job-1",
      model_group: "multi_modal_pro",
      model: "gemini-3.8-flash",
      attempt: 1,
      fallback: false,
    });
    expect(rows[1]).toMatchObject({ attempt: 2, fallback: true });
    expect(rows[2]).toMatchObject({ operation: null, request_id: null });
    await r.flush();
    expect(sink.writes).toHaveLength(1);
  });

  test("flushes by itself after flushMs", async () => {
    const sink = fakeSink();
    const r = modelCallRecorder({
      sink,
      logger: fakeLogger().logger,
      service: "x",
      prices: stubBook(),
      flushMs: 5,
    });
    r.observe(call());
    await Bun.sleep(30);
    expect(sink.writes).toHaveLength(1);
  });

  test("a write slower than flushMs never stalls the writes that follow", async () => {
    const writes: number[][] = [];
    let first = true;
    const sink: ModelCallSink = {
      async write(batch) {
        if (first) {
          first = false;
          await Bun.sleep(150);
        }
        writes.push(batch.map((p) => p.row.ms ?? -1));
      },
    };
    const r = modelCallRecorder({
      sink,
      logger: fakeLogger().logger,
      service: "x",
      prices: stubBook(),
      flushMs: 20,
    });
    r.observe(call({ ms: 1 }));
    await Bun.sleep(50);
    // Observed while the first write is still running.
    r.observe(call({ ms: 2 }));
    await Bun.sleep(60);
    r.observe(call({ ms: 3 }));
    await Bun.sleep(250);
    expect(writes.flat()).toEqual([1, 2, 3]);
  });

  test("flush also writes what was observed during a write in flight", async () => {
    const writes: number[][] = [];
    let release = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let first = true;
    const sink: ModelCallSink = {
      async write(batch) {
        if (first) {
          first = false;
          await gate;
        }
        writes.push(batch.map((p) => p.row.ms ?? -1));
      },
    };
    const r = modelCallRecorder({
      sink,
      logger: fakeLogger().logger,
      service: "x",
      prices: stubBook(),
      flushMs: 60_000,
    });
    withPayer(project, () => r.observe(call({ ms: 1 })));
    const running = r.flush();
    withPayer(project, () => r.observe(call({ ms: 2 })));
    const exit = r.flush();
    release();
    await Promise.all([running, exit]);
    expect(writes.flat()).toEqual([1, 2]);
  });

  test("a call priced without a price row is posted to Slack once per model", async () => {
    const posts: string[] = [];
    const slack = Bun.serve({
      port: 0,
      fetch: async (req) => {
        posts.push(((await req.json()) as { text: string }).text);
        return new Response("ok");
      },
    });
    try {
      const { logger, lines } = fakeLogger();
      const r = modelCallRecorder({
        sink: fakeSink(),
        logger,
        service: "echo-api",
        prices: stubBook(),
        flushMs: 60_000,
        slackUrl: `http://localhost:${slack.port}/hook`,
      });
      withPayer(project, () => {
        r.observe(call({ model: "gemini-unknown" }));
        r.observe(call({ model: "gemini-unknown" }));
        r.observe(call({ model: "gemini-other" }));
        r.observe(call());
      });
      await r.flush();
      await Bun.sleep(100);
      expect(posts).toHaveLength(2);
      expect(posts.some((p) => p.includes("vertex/gemini-unknown"))).toBe(true);
      expect(posts.some((p) => p.includes("vertex/gemini-other"))).toBe(true);
      expect(posts.join(" ")).not.toContain("\u2014");
      expect(
        lines.filter((l) => l.fields.signal === "metering.price_missing").map((l) => l.level),
      ).toEqual(["error", "error"]);
    } finally {
      slack.stop(true);
    }
  });

  test("an unreachable Slack never fails a call priced without a row", async () => {
    const sink = fakeSink();
    const r = modelCallRecorder({
      sink,
      logger: fakeLogger().logger,
      service: "x",
      prices: stubBook(),
      flushMs: 60_000,
      slackUrl: "http://127.0.0.1:1/hook",
    });
    expect(() =>
      withPayer(project, () => r.observe(call({ model: "gemini-unknown" }))),
    ).not.toThrow();
    await r.flush();
    await Bun.sleep(50);
    expect(sink.writes[0]?.batch[0]?.row.price_missing).toBe(true);
  });

  test("a call under a payer is priced and its cost lands in that payer's hour", async () => {
    const sink = fakeSink();
    const r = modelCallRecorder({
      sink,
      logger: fakeLogger().logger,
      service: "x",
      prices: stubBook(),
      flushMs: 60_000,
    });
    withPayer(project, () => {
      r.observe(call({ startedAt: new Date("2026-10-11T12:10:00Z") }));
      r.observe(call({ startedAt: new Date("2026-10-11T12:59:59Z"), outputTokens: 0 }));
      r.observe(call({ startedAt: new Date("2026-10-11T13:00:00Z") }));
    });
    await r.flush();
    const [w] = sink.writes;
    expect(w?.batch[0]?.payer).toEqual(project);
    expect(w?.batch[0]?.row).toMatchObject({
      cost_micro_eur: 5600,
      price_id: 7,
      price_missing: false,
    });
    expect(w?.batch[1]?.row.cost_micro_eur).toBe(5000);
    expect(w?.spend).toEqual([
      { payer: project, hour: new Date("2026-10-11T12:00:00Z"), costMicroEur: 10_600 },
      { payer: project, hour: new Date("2026-10-11T13:00:00Z"), costMicroEur: 5600 },
    ]);
  });

  test("a model the book does not know is charged at the highest price and marked", async () => {
    const sink = fakeSink();
    const r = modelCallRecorder({
      sink,
      logger: fakeLogger().logger,
      service: "x",
      prices: stubBook(),
      flushMs: 60_000,
    });
    withPayer(project, () => r.observe(call({ model: "gemini-unknown" })));
    await r.flush();
    expect(sink.writes[0]?.batch[0]?.row).toMatchObject({
      cost_micro_eur: 5600,
      price_id: null,
      price_missing: true,
    });
  });

  test("a call without a payer is kept with no payer and warned about once per operation", async () => {
    const sink = fakeSink();
    const { logger, lines } = fakeLogger();
    const r = modelCallRecorder({
      sink,
      logger,
      service: "x",
      prices: stubBook(),
      flushMs: 60_000,
    });
    withCorrelation({ requestId: "a", operation: "map.group" }, () => {
      r.observe(call());
      r.observe(call());
    });
    withCorrelation({ requestId: "b", operation: "reports.generate" }, () => r.observe(call()));
    r.observe(call());
    r.observe(call());
    await r.flush();
    const warned = lines.filter((l) => l.message === "model call without a payer");
    expect(warned.map((l) => [l.level, l.fields.operation])).toEqual([
      ["warn", "map.group"],
      ["warn", "reports.generate"],
      ["warn", null],
    ]);
    expect(sink.writes[0]?.batch.map((p) => p.payer)).toEqual([null, null, null, null, null]);
    expect(sink.writes[0]?.batch[0]?.row.cost_micro_eur).toBe(5600);
    // No payer, no spend to carry.
    expect(sink.writes[0]?.spend).toEqual([]);
  });

  test("a failing database drops the oldest rows past the cap but never their spend", async () => {
    const sink = fakeSink(3);
    const { logger, lines } = fakeLogger();
    const r = modelCallRecorder({
      sink,
      logger,
      service: "x",
      prices: stubBook(),
      flushMs: 60_000,
      maxPending: 2,
    });
    const costs: number[] = [];
    withPayer(project, () => {
      for (let i = 0; i < 5; i++) {
        r.observe(call({ ms: i, outputTokens: 100 * i }));
        costs.push(5000 + 200 * i);
      }
    });
    await r.flush();
    await r.flush();
    await r.flush();
    expect(sink.writes).toHaveLength(0);
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(1);
    await r.flush();
    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]?.batch.map((p) => p.row.ms)).toEqual([3, 4]);
    expect(total(sink.writes[0]?.spend ?? [])).toBe(costs.reduce((s, c) => s + c, 0));
    const dropped = lines.filter((l) => l.level === "error");
    expect(dropped.map((l) => l.message)).toEqual(["dropped 3 model call rows"]);
    expect(lines.filter((l) => l.message === "model call rows write again")).toHaveLength(1);
  });

  test("spend observed while a write is failing joins the spend kept from it", async () => {
    const sink = fakeSink(1);
    const r = modelCallRecorder({
      sink,
      logger: fakeLogger().logger,
      service: "x",
      prices: stubBook(),
      flushMs: 60_000,
    });
    withPayer(project, () => r.observe(call()));
    await r.flush();
    withPayer(project, () => r.observe(call()));
    await r.flush();
    expect(sink.writes[0]?.batch).toHaveLength(2);
    expect(sink.writes[0]?.spend).toEqual([
      { payer: project, hour: new Date("2026-10-11T12:00:00Z"), costMicroEur: 11_200 },
    ]);
  });

  test("calls wait for prices when the book is empty and are priced once it fills", async () => {
    const sink = fakeSink();
    const { logger, lines } = fakeLogger();
    const book = stubBook([]);
    const r = modelCallRecorder({ sink, logger, service: "x", prices: book, flushMs: 5 });
    withPayer(project, () => {
      r.observe(call());
      // Nothing to price: no usage, so it does not wait.
      r.observe(
        call({ status: "error", error: "http_429", inputTokens: null, outputTokens: null }),
      );
      r.observe(call({ outputTokens: 0 }));
    });
    await r.flush();
    await Bun.sleep(20);
    const early = sink.writes.flatMap((w) => w.batch);
    expect(early.map((p) => p.row.status)).toEqual(["error"]);
    expect(early[0]?.row).toMatchObject({ cost_micro_eur: 0, price_missing: false });
    expect(sink.writes.flatMap((w) => w.spend)).toEqual([]);
    expect(lines.filter((l) => l.message === "model calls wait for AI prices")).toHaveLength(1);
    book.set([FLASH]);
    // The recorder keeps checking while calls wait, with no new call to wake it.
    await Bun.sleep(30);
    const late = sink.writes.slice(1);
    expect(late.flatMap((w) => w.batch.map((p) => p.row.cost_micro_eur))).toEqual([5600, 5000]);
    expect(late.flatMap((w) => w.batch.map((p) => p.row.price_id))).toEqual([7, 7]);
    expect(total(late.flatMap((w) => w.spend))).toBe(10_600);
  });

  test("calls waiting for prices count toward the cap", async () => {
    const sink = fakeSink();
    const { logger, lines } = fakeLogger();
    const book = stubBook([]);
    const r = modelCallRecorder({
      sink,
      logger,
      service: "x",
      prices: book,
      flushMs: 60_000,
      maxPending: 2,
    });
    withPayer(project, () => {
      for (let i = 0; i < 4; i++) r.observe(call({ ms: i }));
    });
    await r.flush();
    book.set([FLASH]);
    await r.flush();
    expect(sink.writes.flatMap((w) => w.batch.map((p) => p.row.ms))).toEqual([2, 3]);
    expect(total(sink.writes.flatMap((w) => w.spend))).toBe(11_200);
    expect(lines.some((l) => l.message === "dropped 2 model call rows")).toBe(true);
  });

  test("a price book that throws never reaches the caller and loses no call", async () => {
    const sink = fakeSink();
    const book = stubBook();
    let broken = true;
    const r = modelCallRecorder({
      sink,
      logger: fakeLogger().logger,
      service: "x",
      prices: {
        current: () => {
          if (broken) throw new Error("broken book");
          return book.current();
        },
      },
      flushMs: 60_000,
    });
    expect(() => withPayer(project, () => r.observe(call()))).not.toThrow();
    await r.flush();
    expect(sink.writes).toHaveLength(0);
    broken = false;
    await r.flush();
    expect(sink.writes[0]?.batch.map((p) => p.row.cost_micro_eur)).toEqual([5600]);
    expect(total(sink.writes[0]?.spend ?? [])).toBe(5600);
  });

  test("the log line carries every billable unit and who bills it", () => {
    const { logger, lines } = fakeLogger();
    const r = modelCallRecorder({
      sink: fakeSink(),
      logger,
      service: "x",
      prices: stubBook(),
      flushMs: 60_000,
    });
    r.observe(
      call({
        cachedInputTokens: 200,
        audioInputTokens: 960,
        reasoningTokens: 40,
        searchQueries: 2,
      }),
    );
    expect(lines[0]?.fields).toMatchObject({
      provider: "vertex",
      input_tokens: 5000,
      cached_input_tokens: 200,
      audio_input_tokens: 960,
      output_tokens: 300,
      reasoning_tokens: 40,
      audio_seconds: null,
      search_queries: 2,
      usage_estimated: false,
    });
  });

  test("a row carries every unit and no text from the call", () => {
    const row = toRow(
      call({ cachedInputTokens: 200, audioSeconds: 12.5, usageEstimated: true }),
      "echo-api",
      "POST /api/v2/bff/chats/:chat_id/reply",
      "r1",
    );
    expect(Object.keys(row).sort()).toEqual(
      [
        "attempt",
        "audio_input_tokens",
        "audio_seconds",
        "cached_input_tokens",
        "error",
        "fallback",
        "finish_reason",
        "input_tokens",
        "kind",
        "model",
        "model_group",
        "ms",
        "operation",
        "output_tokens",
        "provider",
        "reasoning_tokens",
        "request_id",
        "search_queries",
        "service",
        "started_at",
        "status",
        "usage_estimated",
      ].sort(),
    );
    expect(row).toMatchObject({
      provider: "vertex",
      cached_input_tokens: 200,
      audio_seconds: 12.5,
      usage_estimated: true,
    });
  });
});
