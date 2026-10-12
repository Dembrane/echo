import { describe, expect, test } from "bun:test";
import type { ModelCall } from "@dembrane/llm";
import { withCorrelation } from "@dembrane/observability";
import { type ModelCallRow, type ModelCallSink, modelCallRecorder, toRow } from "../src";

const call = (over: Partial<ModelCall> = {}): ModelCall => ({
  group: "multi_modal_pro",
  model: "gemini-3.8-flash",
  kind: "generate",
  startedAt: new Date("2026-10-11T12:00:00Z"),
  ms: 1234,
  inputTokens: 5000,
  outputTokens: 300,
  finishReason: "stop",
  status: "ok",
  error: null,
  attempt: 1,
  fallback: false,
  ...over,
});

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

function fakeSink(failTimes = 0): ModelCallSink & { batches: ModelCallRow[][] } {
  const batches: ModelCallRow[][] = [];
  let fails = failTimes;
  return {
    batches,
    async insert(rows) {
      if (fails > 0) {
        fails--;
        throw new Error("db down");
      }
      batches.push([...rows]);
    },
  };
}

describe("model call recorder", () => {
  test("logs one line per call and writes a batch per flush with the operation", async () => {
    const sink = fakeSink();
    const { logger, lines } = fakeLogger();
    const r = modelCallRecorder({ sink, logger, service: "echo-worker", flushMs: 60_000 });
    withCorrelation({ requestId: "job-1", operation: "conversations.chunk" }, () => {
      r.observe(call());
      r.observe(call({ attempt: 2, fallback: true, model: "gemini-3.7-flash" }));
    });
    r.observe(call({ status: "error", error: "http_429", inputTokens: null, outputTokens: null }));
    expect(lines.map((l) => l.message)).toEqual(["model call", "model call", "model call"]);
    expect(lines[0]?.fields).toMatchObject({
      signal: "model.call",
      operation: "conversations.chunk",
      group: "multi_modal_pro",
      model: "gemini-3.8-flash",
      ms: 1234,
      input_tokens: 5000,
      output_tokens: 300,
      finish_reason: "stop",
    });
    expect(lines[2]?.fields).toMatchObject({ operation: null, status: "error", error: "http_429" });
    expect(sink.batches).toHaveLength(0);
    await r.flush();
    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]).toHaveLength(3);
    expect(sink.batches[0]?.[0]).toMatchObject({
      service: "echo-worker",
      operation: "conversations.chunk",
      request_id: "job-1",
      model_group: "multi_modal_pro",
      model: "gemini-3.8-flash",
      attempt: 1,
      fallback: false,
    });
    expect(sink.batches[0]?.[1]).toMatchObject({ attempt: 2, fallback: true });
    expect(sink.batches[0]?.[2]).toMatchObject({ operation: null, request_id: null });
    await r.flush();
    expect(sink.batches).toHaveLength(1);
  });

  test("flushes by itself after flushMs", async () => {
    const sink = fakeSink();
    const r = modelCallRecorder({ sink, logger: fakeLogger().logger, service: "x", flushMs: 5 });
    r.observe(call());
    await Bun.sleep(30);
    expect(sink.batches).toHaveLength(1);
  });

  test("keeps rows while the database fails, warns once, and drops past the cap", async () => {
    const sink = fakeSink(2);
    const { logger, lines } = fakeLogger();
    const r = modelCallRecorder({ sink, logger, service: "x", flushMs: 60_000, maxPending: 3 });
    for (let i = 0; i < 5; i++) r.observe(call({ ms: i }));
    await r.flush();
    await r.flush();
    expect(sink.batches).toHaveLength(0);
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(1);
    await r.flush();
    expect(sink.batches).toHaveLength(1);
    // The newest three survive the cap.
    expect(sink.batches[0]?.map((row) => row.ms)).toEqual([2, 3, 4]);
    expect(lines.filter((l) => l.message === "model call rows write again")).toHaveLength(1);
  });

  test("a row carries no text from the call", () => {
    const row = toRow(call(), "echo-api", "POST /api/v2/bff/chats/:chat_id/reply", "r1");
    expect(Object.keys(row).sort()).toEqual(
      [
        "attempt",
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
        "prompt_ref",
        "prompt_version",
        "request_id",
        "service",
        "started_at",
        "status",
        // The caller's trace: names, a prompt hash and the artefact's id, never its text.
        "step",
        "target_id",
        "target_type",
      ].sort(),
    );
  });
});
