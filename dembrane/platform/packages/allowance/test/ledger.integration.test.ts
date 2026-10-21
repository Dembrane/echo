import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type postgres from "postgres";
import type { AllowanceAccount } from "../src/account";
import { add, giveBack, take, usedThisPeriod, withAllowanceLock } from "../src/ledger";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_ledger_${process.pid}`;
const OCT = new Date("2026-10-01T00:00:00Z");
const NOV = new Date("2026-11-01T00:00:00Z");
const ZERO = { audio_seconds: 0, chats: 0, reports: 0, maps: 0, popcorn_analyses: 0 };

run("allowance ledger", () => {
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
    const made = createDb({ url, poolMax: 10 });
    db = made.db;
    close = made.close;
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const account = (periodStart = OCT): AllowanceAccount => ({
    accountId: randomUUID(),
    free: true,
    periodStart,
    orgId: null,
  });

  async function stored(a: AllowanceAccount, key: string) {
    const rows = await sql<{ amount: string }[]>`select amount from free_usage
      where billing_account_id = ${a.accountId} and period_start = ${a.periodStart} and key = ${key}`;
    return rows[0] ? Number(rows[0].amount) : null;
  }

  test("take adds until the limit and then refuses", async () => {
    const a = account();
    expect(await take(db, a, "reports", 1, 2)).toEqual({ ok: true, used: 1 });
    expect(await take(db, a, "reports", 1, 2)).toEqual({ ok: true, used: 2 });
    expect(await take(db, a, "reports", 1, 2)).toEqual({ ok: false, used: 2, limit: 2 });
    expect(await stored(a, "reports")).toBe(2);
  });

  test("take refuses an amount that would overshoot", async () => {
    const a = account();
    expect(await take(db, a, "audio_seconds", 3000, 3600)).toEqual({ ok: true, used: 3000 });
    expect(await take(db, a, "audio_seconds", 601, 3600)).toEqual({
      ok: false,
      used: 3000,
      limit: 3600,
    });
    expect(await take(db, a, "audio_seconds", 600, 3600)).toEqual({ ok: true, used: 3600 });
  });

  test("take is serialised per account", async () => {
    const a = account();
    const results = await Promise.all(Array.from({ length: 20 }, () => take(db, a, "chats", 1, 2)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toHaveLength(18);
    expect(await stored(a, "chats")).toBe(2);
  });

  test("a new period starts empty", async () => {
    const a = account();
    await add(db, a, "audio_seconds", 500);
    await take(db, a, "maps", 1, 1);
    expect(await usedThisPeriod(db, a)).toEqual({ ...ZERO, audio_seconds: 500, maps: 1 });
    expect(await usedThisPeriod(db, { ...a, periodStart: NOV })).toEqual(ZERO);
  });

  test("usedThisPeriod ignores keys that are not usage keys", async () => {
    const a = account();
    await add(db, a, "popcorn_analyses", 1);
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${a.accountId}, ${a.periodStart}, 'notice:audio_out', 1)`;
    expect(await usedThisPeriod(db, a)).toEqual({ ...ZERO, popcorn_analyses: 1 });
  });

  test("giveBack never goes below zero", async () => {
    const a = account();
    await add(db, a, "audio_seconds", 100);
    await giveBack(db, a, "audio_seconds", 40);
    expect(await stored(a, "audio_seconds")).toBe(60);
    await giveBack(db, a, "audio_seconds", 1000);
    expect(await stored(a, "audio_seconds")).toBe(0);
    await giveBack(db, a, "reports", 5);
    expect((await usedThisPeriod(db, a)).reports).toBe(0);
  });

  test("add ignores the limit and returns the total", async () => {
    const a = account();
    await take(db, a, "audio_seconds", 18000, 18000);
    expect(await add(db, a, "audio_seconds", 120)).toBe(18120);
    expect(await add(db, a, "audio_seconds", 30)).toBe(18150);
    expect(await take(db, a, "audio_seconds", 1, 18000)).toEqual({
      ok: false,
      used: 18150,
      limit: 18000,
    });
  });

  test("rejects negative and non-finite amounts", async () => {
    const a = account();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const e1 = await take(db, a, "chats", bad, 2).then(
        () => null,
        (e) => e,
      );
      const e2 = await add(db, a, "chats", bad).then(
        () => null,
        (e) => e,
      );
      const e3 = await giveBack(db, a, "chats", bad).then(
        () => null,
        (e) => e,
      );
      expect(e1).toBeInstanceOf(Error);
      expect(e2).toBeInstanceOf(Error);
      expect(e3).toBeInstanceOf(Error);
    }
    expect(await stored(a, "chats")).toBeNull();
  });

  test("rejects negative and non-finite limits", async () => {
    const a = account();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const err = await take(db, a, "chats", 1, bad).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(Error);
    }
    expect(await stored(a, "chats")).toBeNull();
  });

  test("another account is not blocked by this one's lock", async () => {
    const a = account();
    const b = account();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const held = new Promise<void>((r) => {
      locked = r;
    });
    const holder = withAllowanceLock(db, a, async () => {
      locked();
      await gate;
    });
    await held;
    const t0 = Date.now();
    expect(await take(db, b, "reports", 1, 1)).toEqual({ ok: true, used: 1 });
    expect(Date.now() - t0).toBeLessThan(1000);
    release();
    await holder;
  });

  test("the same account waits for a held lock", async () => {
    const a = account();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const held = new Promise<void>((r) => {
      locked = r;
    });
    const holder = withAllowanceLock(db, a, async () => {
      locked();
      await gate;
    });
    await held;
    let done = false;
    const waiting = take(db, a, "reports", 1, 1).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await holder;
    expect(await waiting).toEqual({ ok: true, used: 1 });
  });

  test("the same account in another period waits for a held lock", async () => {
    const a = account();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const held = new Promise<void>((r) => {
      locked = r;
    });
    const holder = withAllowanceLock(db, a, async () => {
      locked();
      await gate;
    });
    await held;
    let done = false;
    const waiting = take(db, { ...a, periodStart: NOV }, "reports", 1, 1).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await holder;
    expect(await waiting).toEqual({ ok: true, used: 1 });
  });

  test("take inside withAllowanceLock reuses the held lock", async () => {
    const a = account();
    const out = await withAllowanceLock(db, a, async (tx) => {
      const first = await take(tx, a, "chats", 1, 2);
      const total = await add(tx, a, "audio_seconds", 10);
      await giveBack(tx, a, "audio_seconds", 4);
      const used = await usedThisPeriod(tx, a);
      return { first, total, used };
    });
    expect(out.first).toEqual({ ok: true, used: 1 });
    expect(out.total).toBe(10);
    expect(out.used).toEqual({ ...ZERO, chats: 1, audio_seconds: 6 });
    expect(await stored(a, "chats")).toBe(1);
  });

  test("withAllowanceLock rolls back writes when fn throws", async () => {
    const a = account();
    const err = await withAllowanceLock(db, a, async (tx) => {
      await add(tx, a, "maps", 1);
      throw new Error("boom");
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(await stored(a, "maps")).toBeNull();
  });
});
