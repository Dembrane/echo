import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  allowanceForProject,
  FREE_LIMIT_DEFAULTS,
  invalidateFreeLimits,
  setFreeLimit,
  usedThisPeriod,
} from "@dembrane/allowance";
import { newId } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { popcornAllowance, withFreePopcorn } from "../src/free";
import { tickStore } from "../src/tick/storage";

// 12 counted analyses per month on free; a failed one comes back once.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `popcorn_free_${process.pid}`;
const OCT = "2026-10-01T00:00:00.000Z";

run("free popcorn", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let now: Date;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 12 });
    sql = connect(url, { max: 2, onnotice: () => {} });
  });

  beforeEach(() => {
    invalidateFreeLimits();
    now = new Date("2026-10-20T10:00:00Z");
  });

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function seed(
    tier: string | null = "free",
    opts: { sample?: boolean; noWorkspace?: boolean } = {},
  ) {
    const [org, billing, ws, projectId, loopId] = [newId(), newId(), newId(), newId(), newId()];
    const reportId = Math.floor(Math.random() * 1_000_000_000);
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, ${tier})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample)
      values (${projectId}, 'P', ${opts.noWorkspace ? null : ws}, true, ${opts.sample === true})`;
    await sql`insert into project_report (id, project_id, kind, status, content)
      values (${reportId}, ${projectId}, 'popcorn', 'published', '')`;
    await sql`insert into agent_loop (id, project_id, report_id, name, status, expires_at)
      values (${loopId}, ${projectId}, ${reportId}, 'popcorn', 'active', '2026-12-31T00:00:00Z')`;
    return { billing, projectId, loopId };
  }

  const rejection = (p: Promise<unknown>) =>
    Promise.resolve(p).then(
      () => null,
      (e) => e,
    );

  async function ledger(projectId: string, at = now) {
    const a = await allowanceForProject(database.db, projectId, at);
    if (!a) throw new Error("expected a free account");
    return (await usedThisPeriod(database.db, a)).popcorn_analyses;
  }

  async function insertRun(loopId: string, freePeriodStart: string | null) {
    const id = newId();
    await tickStore(sql).insertRun({
      id,
      loopId,
      status: "error",
      detail: "run 1: failed",
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      freePeriodStart,
    });
    return id;
  }

  async function stamp(runId: string): Promise<string | null> {
    const [row] = await sql`select free_period_start from agent_loop_run where id = ${runId}`;
    return row?.free_period_start ? (row.free_period_start as Date).toISOString() : null;
  }

  const usageRows = async (billing: string) =>
    Number(
      (await sql`select count(*) as n from free_usage where billing_account_id = ${billing}`)[0]?.n,
    );

  test("each analysis counts one", async () => {
    const { projectId } = await seed();
    const pop = popcornAllowance(database.db);
    for (let i = 0; i < 12; i++)
      expect(await pop.admit(projectId, now)).toEqual({ ok: true, periodStart: OCT });
    expect(await pop.admit(projectId, now)).toEqual({ ok: false, used: 12, limit: 12 });
    expect(await pop.status(projectId, now)).toEqual({ used: 12, limit: 12, exhausted: true });
    const err = await rejection(pop.requireRoom(projectId, now));
    expect(err).toMatchObject({ status: 402, details: { limit: "popcorn", used: 12, cap: 12 } });
    expect(await withFreePopcorn(database.db, { a: 1 }, projectId, now)).toEqual({
      a: 1,
      free_popcorn: { used: 12, limit: 12, exhausted: true },
    });
  });

  test("room left does not refuse", async () => {
    const { projectId } = await seed();
    const pop = popcornAllowance(database.db);
    await pop.admit(projectId, now);
    expect(await pop.status(projectId, now)).toEqual({ used: 1, limit: 12, exhausted: false });
    expect(await rejection(pop.requireRoom(projectId, now))).toBeNull();
  });

  test("two analyses race for the last one", async () => {
    const { projectId } = await seed();
    const pop = popcornAllowance(database.db);
    for (let i = 0; i < 11; i++) await pop.admit(projectId, now);
    const results = await Promise.all(Array.from({ length: 5 }, () => pop.admit(projectId, now)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await ledger(projectId)).toBe(12);
  });

  test("refund gives the analysis back once", async () => {
    const { projectId, loopId } = await seed();
    const pop = popcornAllowance(database.db);
    await pop.admit(projectId, now);
    const admitted = await pop.admit(projectId, now);
    if (!admitted.ok) throw new Error("expected room");
    const runId = await insertRun(loopId, admitted.periodStart);
    expect(await stamp(runId)).toBe(OCT);
    expect(await ledger(projectId)).toBe(2);
    expect(await pop.refund(runId, now)).toBe(true);
    expect(await pop.refund(runId, now)).toBe(false);
    expect(await ledger(projectId)).toBe(1);
    expect(await stamp(runId)).toBeNull();
    const unstamped = await insertRun(loopId, null);
    expect(await pop.refund(unstamped, now)).toBe(false);
    expect(await pop.refund(newId(), now)).toBe(false);
    expect(await ledger(projectId)).toBe(1);
  });

  test("concurrent refunds give back once", async () => {
    const { projectId, loopId } = await seed();
    const pop = popcornAllowance(database.db);
    await pop.admit(projectId, now);
    const runId = await insertRun(loopId, OCT);
    const results = await Promise.all(Array.from({ length: 5 }, () => pop.refund(runId, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ledger(projectId)).toBe(0);
  });

  test("replaceRun writes the stamp", async () => {
    const { loopId } = await seed();
    const runId = await insertRun(loopId, null);
    await tickStore(sql).replaceRun({
      id: runId,
      loopId,
      status: "ok",
      detail: "run 1: retried",
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      freePeriodStart: OCT,
    });
    expect(await stamp(runId)).toBe(OCT);
  });

  test("a refund after the month rolled gives nothing back", async () => {
    const { projectId, loopId } = await seed();
    const pop = popcornAllowance(database.db);
    await pop.admit(projectId, now);
    const runId = await insertRun(loopId, "2026-09-01T00:00:00.000Z");
    expect(await pop.refund(runId, now)).toBe(false);
    expect(await stamp(runId)).toBeNull();
    expect(await ledger(projectId)).toBe(1);
  });

  test("next month starts at zero", async () => {
    const { projectId } = await seed();
    const pop = popcornAllowance(database.db);
    for (let i = 0; i < 12; i++) await pop.admit(projectId, now);
    const nov = new Date("2026-11-02T10:00:00Z");
    expect(await pop.status(projectId, nov)).toEqual({ used: 0, limit: 12, exhausted: false });
    expect(await pop.admit(projectId, nov)).toEqual({
      ok: true,
      periodStart: "2026-11-01T00:00:00.000Z",
    });
  });

  test("staff limits apply", async () => {
    const { projectId } = await seed();
    const pop = popcornAllowance(database.db);
    try {
      expect(await pop.cadenceFloorMinutes(projectId, now)).toBe(5);
      await setFreeLimit(database.db, "popcorn_analyses_month", 2, null);
      await setFreeLimit(database.db, "popcorn_cadence_minutes", 10, null);
      expect((await pop.admit(projectId, now)).ok).toBe(true);
      expect((await pop.admit(projectId, now)).ok).toBe(true);
      expect(await pop.admit(projectId, now)).toEqual({ ok: false, used: 2, limit: 2 });
      expect(await pop.cadenceFloorMinutes(projectId, now)).toBe(10);
    } finally {
      await setFreeLimit(
        database.db,
        "popcorn_analyses_month",
        FREE_LIMIT_DEFAULTS.popcorn_analyses_month,
        null,
      );
      await setFreeLimit(
        database.db,
        "popcorn_cadence_minutes",
        FREE_LIMIT_DEFAULTS.popcorn_cadence_minutes,
        null,
      );
    }
  });

  test("unlimited and sample analyses are never counted", async () => {
    const pop = popcornAllowance(database.db);
    const cases = [
      await seed("innovator"),
      await seed("pioneer"),
      await seed("free", { noWorkspace: true }),
      await seed("free", { sample: true }),
    ];
    for (const { billing, projectId, loopId } of cases) {
      for (let i = 0; i < 20; i++)
        expect(await pop.admit(projectId, now)).toEqual({ ok: true, periodStart: null });
      expect(await pop.status(projectId, now)).toBeNull();
      expect(await rejection(pop.requireRoom(projectId, now))).toBeNull();
      expect(await pop.cadenceFloorMinutes(projectId, now)).toBe(1);
      expect(await usageRows(billing)).toBe(0);
      expect(await pop.refund(await insertRun(loopId, null), now)).toBe(false);
      expect(await withFreePopcorn(database.db, {}, projectId, now)).toEqual({
        free_popcorn: null,
      });
    }
  });
});
