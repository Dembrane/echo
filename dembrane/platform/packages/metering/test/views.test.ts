import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, migrate } from "@dembrane/db";
import type { ModelCall } from "@dembrane/llm";
import { withCorrelation } from "@dembrane/observability";
import postgres from "postgres";
import { modelCallRecorder, modelCallTable } from "../src";

// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const base = admin?.slice(0, admin.lastIndexOf("/"));
const run = admin ? describe : describe.skip;
const NAME = "metering_views";
// Roles are cluster wide and other test files migrate their own databases on the same
// server at the same time, so the role is this run's own and never the production name.
const ROLE = `grafana_obs_t${process.pid}`;

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

run("obs views", () => {
  const sql = admin ? postgres(admin, { max: 1, onnotice: () => {} }) : (undefined as never);
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    await sql.unsafe(`drop database if exists ${NAME}`);
    await sql.unsafe(`create database ${NAME}`);
    await migrate(`${base}/${NAME}`, { appEnv: "test" });
    db = createDb({ url: `${base}/${NAME}`, poolMax: 2 });
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    const cleanup = postgres(`${base}/${NAME}`, { max: 1, onnotice: () => {} });
    await cleanup.unsafe(`drop owned by ${ROLE}; drop role ${ROLE}`).catch(() => undefined);
    await cleanup.end();
    // migrate() keeps its own pool open; the scratch database stays, as the db tests leave
    // theirs, and the next run replaces it.
    await sql.end();
  });

  const call = (over: Partial<ModelCall> = {}): ModelCall => ({
    group: "multi_modal_pro",
    model: "gemini-3.8-flash",
    kind: "generate",
    startedAt: new Date(),
    ms: 1000,
    inputTokens: 4000,
    outputTokens: 200,
    finishReason: "stop",
    status: "ok",
    error: null,
    attempt: 1,
    fallback: false,
    ...over,
  });

  test("model calls land in the table and the day view sums them per operation", async () => {
    const r = modelCallRecorder({
      sink: modelCallTable(db.db),
      logger: quiet,
      service: "echo-worker",
    });
    withCorrelation({ requestId: "job-1", operation: "conversations.chunk" }, () => {
      r.observe(call());
      r.observe(call({ ms: 3000, inputTokens: 9000, finishReason: "safety", outputTokens: 0 }));
      r.observe(
        call({ status: "error", error: "http_429", inputTokens: null, outputTokens: null }),
      );
      r.observe(call({ attempt: 2, fallback: true, model: "gemini-3.7-flash" }));
    });
    await r.flush();
    const rows = await db.client.unsafe(
      `select operation, model, calls, errors, refusals, retries, fallbacks, input_tokens, output_tokens, avg_input_tokens, max_input_tokens, p95_ms
       from obs.day_model_calls where day = (now() at time zone 'Europe/Amsterdam')::date order by model`,
    );
    expect([...rows]).toEqual([
      expect.objectContaining({
        operation: "conversations.chunk",
        model: "gemini-3.7-flash",
        calls: 1,
        retries: 1,
        fallbacks: 1,
      }),
      expect.objectContaining({
        operation: "conversations.chunk",
        model: "gemini-3.8-flash",
        calls: 3,
        errors: 1,
        refusals: 1,
        retries: 0,
        fallbacks: 0,
        input_tokens: "13000",
        output_tokens: "200",
        avg_input_tokens: 6500,
        max_input_tokens: 9000,
        p95_ms: 2800,
      }),
    ]);
    const perCall = await db.client.unsafe("select * from obs.model_calls");
    expect(perCall).toHaveLength(4);
    expect(Object.keys(perCall[0] as object)).not.toContain("request_id");
  });

  test("every product view answers, and the live view has one row", async () => {
    for (const view of [
      "day_conversations",
      "day_chunks",
      "minute_chunks",
      "day_pipeline",
      "minute_pipeline",
      "day_reports",
      "day_chats",
      "day_assistant",
      "minute_model_calls",
    ])
      expect(Array.isArray(await db.client.unsafe(`select * from obs.${view} limit 1`))).toBe(true);
    const [live] = await db.client.unsafe("select * from obs.live_now");
    expect({ ...live }).toEqual({
      participants_live: 0,
      conversations_active: 0,
      conversations_with_audio_10m: 0,
      unfinished_24h: 0,
      chunks_waiting_1h: 0,
    });
  });

  test("the dashboard role, granted as operations grants it, sees obs and nothing in public, later views included", async () => {
    // The grants of helm/monitoring/sql/grafana-obs-role.sql (echo-gitops), run as the
    // migration owner after the release: usage, select on what exists, and default
    // privileges so a view a later migration adds is covered without a second step.
    const owner = postgres(`${base}/${NAME}`, { max: 1, onnotice: () => {} });
    await owner.unsafe(`create role ${ROLE} login password 'x'`);
    await owner.unsafe(`grant usage on schema obs to ${ROLE}`);
    await owner.unsafe(`grant select on all tables in schema obs to ${ROLE}`);
    await owner.unsafe(`alter default privileges in schema obs grant select on tables to ${ROLE}`);
    await owner.unsafe("create view obs.later_view as select 1 as one");
    await owner.end();
    const url = new URL(`${base}/${NAME}`);
    url.username = ROLE;
    url.password = "x";
    const viewer = postgres(url.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} });
    // A postgres.js query is a lazy thenable, not a Promise: expect().rejects never settles
    // on it, so the refusal is awaited by hand.
    const outcome = async (query: string) => {
      try {
        await viewer.unsafe(query);
        return "allowed";
      } catch (err) {
        return (err as Error).message;
      }
    };
    try {
      const counted = await viewer.unsafe<{ n: number }[]>(
        "select count(*)::int as n from obs.day_model_calls",
      );
      expect(counted[0]?.n).toBe(2);
      expect(await outcome("select one from obs.later_view")).toBe("allowed");
      expect(await outcome("select * from public.model_call")).toMatch(/permission denied/);
      expect(await outcome("select * from public.conversation")).toMatch(/permission denied/);
    } finally {
      await viewer.end({ timeout: 2 });
    }
  });
});
