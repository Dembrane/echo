import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import type postgres from "postgres";
import {
  FREE_LIMIT_DEFAULTS,
  freeLimitRows,
  freeLimits,
  invalidateFreeLimits,
  setFreeLimit,
} from "../src/limits";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_limits_${process.pid}`;
const STAFF = "d1000000-0000-4000-8000-000000000001";

run("free limits", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const made = createDb({ url, poolMax: 2 });
    db = made.db;
    close = made.close;
  });

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  beforeEach(async () => {
    await sql`delete from tier_limit`;
    invalidateFreeLimits();
  });

  test("defaults match the spec", () => {
    expect(FREE_LIMIT_DEFAULTS).toEqual({
      audio_seconds_month: 18000,
      audio_seconds_conversation: 3600,
      projects: 1,
      chats_month: 2,
      chat_turns_first: 20,
      chat_turns_second: 3,
      reports_month: 1,
      maps_month: 1,
      popcorn_sessions_month: 1,
      popcorn_window_minutes: 60,
      popcorn_cadence_minutes: 5,
    });
  });

  test("empty table serves defaults", async () => {
    expect(await freeLimits(db)).toEqual(FREE_LIMIT_DEFAULTS);
  });

  test("a row overrides its key only", async () => {
    await sql`insert into tier_limit (tier, key, value) values ('free', 'reports_month', 3)`;
    invalidateFreeLimits();
    const limits = await freeLimits(db);
    expect(limits.reports_month).toBe(3);
    expect(limits.chats_month).toBe(2);
  });

  test("unknown keys and other tiers are ignored", async () => {
    await sql`insert into tier_limit (tier, key, value) values ('free', 'bogus', 9), ('innovator', 'reports_month', 9)`;
    const limits = await freeLimits(db);
    expect(limits).toEqual(FREE_LIMIT_DEFAULTS);
    expect("bogus" in limits).toBe(false);
  });

  test("cached for 60 s", async () => {
    const t0 = Date.parse("2026-10-20T12:00:00Z");
    let t = t0;
    const now = () => new Date(t);
    expect((await freeLimits(db, now)).maps_month).toBe(1);
    await sql`insert into tier_limit (tier, key, value) values ('free', 'maps_month', 4)`;
    t = t0 + 59_000;
    expect((await freeLimits(db, now)).maps_month).toBe(1);
    t = t0 + 61_000;
    expect((await freeLimits(db, now)).maps_month).toBe(4);
  });

  test("setFreeLimit invalidates at once and records updated_by", async () => {
    const t0 = Date.parse("2026-10-20T12:00:00Z");
    const now = () => new Date(t0);
    expect((await freeLimits(db, now)).projects).toBe(1);
    await setFreeLimit(db, "projects", 2, STAFF);
    expect((await freeLimits(db, now)).projects).toBe(2);
    await setFreeLimit(db, "projects", 5, null);
    expect((await freeLimits(db, now)).projects).toBe(5);
    const [row] =
      await sql`select value, updated_by from tier_limit where tier = 'free' and key = 'projects'`;
    expect(Number(row?.value)).toBe(5);
    expect(row?.updated_by).toBeNull();
    await setFreeLimit(db, "projects", 3, STAFF);
    const [again] = await sql`select updated_by, updated_at from tier_limit where key = 'projects'`;
    expect(again?.updated_by).toBe(STAFF);
    expect(again?.updated_at).toBeTruthy();
  });

  test("freeLimitRows lists every key with row or default", async () => {
    await setFreeLimit(db, "chats_month", 4, STAFF);
    const rows = await freeLimitRows(db);
    expect(rows.map((r) => r.key)).toEqual(Object.keys(FREE_LIMIT_DEFAULTS) as never);
    const chats = rows.find((r) => r.key === "chats_month");
    expect(chats).toMatchObject({ value: 4, default: 2, updated_by: STAFF });
    expect(chats?.updated_at).toBeTruthy();
    const reports = rows.find((r) => r.key === "reports_month");
    expect(reports).toEqual({
      key: "reports_month",
      value: 1,
      default: 1,
      updated_at: null,
      updated_by: null,
    });
  });

  test("unreadable table serves defaults and does not cache the failure", async () => {
    const broken = {
      select: () => ({ from: () => ({ where: () => Promise.reject(new Error("db down")) }) }),
    } as unknown as Db;
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) } as unknown as Logger;
    expect(await freeLimits(broken, undefined, logger)).toEqual(FREE_LIMIT_DEFAULTS);
    expect(warnings).toHaveLength(1);
    await sql`insert into tier_limit (tier, key, value) values ('free', 'reports_month', 7)`;
    expect((await freeLimits(db)).reports_month).toBe(7);
  });
});
