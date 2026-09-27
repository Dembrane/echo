import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger } from "@echo/observability";
import { Hono } from "hono";
import postgres from "postgres";
import { formatSse, Hub, OpenStreams, publish, sseResponse } from "../src";

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

test("the SSE format matches what browsers parse today", () => {
  expect(formatSse({ type: "run.updated", id: "r1" })).toBe(
    'event: run.updated\ndata: {"type":"run.updated","id":"r1"}\n\n',
  );
  expect(formatSse({ id: 1 })).toBe('event: update\ndata: {"id":1}\n\n');
});

test("stream caps apply per process and per key", () => {
  const s = new OpenStreams();
  expect(s.take("u1", 2, 1)).toBe(true);
  expect(s.take("u1", 2, 1)).toBe(false);
  expect(s.take("u2", 2, 1)).toBe(true);
  expect(s.take("u3", 2, 1)).toBe(false);
  s.giveBack("u1");
  expect(s.take("u3", 2, 1)).toBe(true);
});

const admin = process.env.TEST_DATABASE_ADMIN_URL;
(admin ? describe : describe.skip)("over Postgres", () => {
  const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/postgres` : "";
  let sql: postgres.Sql;
  let hub: Hub;
  beforeAll(async () => {
    sql = postgres(url, { max: 3, onnotice: () => {} });
    hub = new Hub(sql, logger);
    await hub.start();
  });
  afterAll(async () => {
    await hub.stop();
    await sql.end();
  });

  test("an event published in a transaction arrives only after commit", async () => {
    const got: unknown[] = [];
    const off = hub.subscribe(["project:p1"], (e) => got.push(e));
    await sql.begin(async (tx) => {
      await publish(tx, "project:p1", { type: "map.updated" });
      await Bun.sleep(150);
      expect(got).toEqual([]);
    });
    for (let i = 0; i < 40 && !got.length; i++) await Bun.sleep(25);
    expect(got).toEqual([{ type: "map.updated" }]);
    off();
  });

  test("a stream says connected, forwards events for its channels only, and releases its slot on close", async () => {
    const app = new Hono()
      .get("/live", (c) => sseResponse(c, hub, ["run:r1"], { key: "u1", maxStreamsPerKey: 1 }))
      .onError((err, c) =>
        c.json({ detail: err.message }, (err as { status?: number }).status === 429 ? 429 : 500),
      );
    const ac = new AbortController();
    const res = await app.request("/live", { signal: ac.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value);
    expect(text).toBe('event: connected\ndata: {"type":"connected"}\n\n');
    await publish(sql, "run:r2", { type: "ignored" });
    await publish(sql, "run:r1", { type: "run.step", step: 2 });
    text = dec.decode((await reader.read()).value);
    expect(text).toBe('event: run.step\ndata: {"type":"run.step","step":2}\n\n');
    const second = await app.request("/live");
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ detail: "Too many open streams. Try again later." });
    ac.abort();
    await reader.cancel();
  });
});
