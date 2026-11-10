import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, createDb, migrate } from "@dembrane/db";
import { PostgresRateCounter, RateLimiter } from "../src";

// A scratch database per run: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `ratelimit_window_${process.pid}`;

run("the Postgres counter", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
  });

  afterAll(async () => {
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("returns the window's end from the same upsert, and resets it once passed", async () => {
    const counter = new PostgresRateCounter(database.db);
    const t0 = new Date("2026-11-10T00:00:00Z");
    expect(await counter.hitWindow("k", 60, t0)).toEqual({
      count: 1,
      resetAt: new Date("2026-11-10T00:01:00Z"),
    });
    expect(await counter.hitWindow("k", 60, new Date(t0.getTime() + 10_000))).toEqual({
      count: 2,
      resetAt: new Date("2026-11-10T00:01:00Z"),
    });
    expect(await counter.hit("k", 60, new Date(t0.getTime() + 61_000))).toBe(1);
  });

  test("a refusal carries retry_after_seconds", async () => {
    let now = new Date("2026-11-10T01:00:00Z");
    const limiter = new RateLimiter(new PostgresRateCounter(database.db), () => now);
    const limit = { name: "login_probe", capacity: 1, windowSeconds: 300 };
    await limiter.check(limit, "ip");
    now = new Date(now.getTime() + 100_000);
    const refused = await limiter.check(limit, "ip").catch((e: { params?: unknown }) => e);
    expect((refused as { params?: unknown }).params).toEqual({ retry_after_seconds: 200 });
  });
});
