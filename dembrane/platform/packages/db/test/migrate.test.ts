import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  ContractArchiveMissing,
  LOCK_ATTEMPTS,
  migrate,
  recordContractArchive,
} from "../src/migrate";

// Counted from the journal so a new migration does not require editing this test.
const journal = (await Bun.file(
  new URL("../migrations/meta/_journal.json", import.meta.url),
).json()) as {
  entries: { tag: string; when: number }[];
};
const TOTAL = journal.entries.length;
const BASELINE = 2;
const CONTRACTS = journal.entries.filter((e) => e.tag.includes("_contract_")).map((e) => e.tag);
const CONTRACT = CONTRACTS.length;
// Drizzle records a migration by its journal timestamp.
// Any recent migration that alters a busy table.
const FREE_TIER_MILLIS = journal.entries.find((e) => e.tag === "0028_expand_free_tier_allowance")
  ?.when as number;
const CONTRACT_MILLIS = journal.entries
  .filter((e) => e.tag.includes("_contract_"))
  .map((e) => String(e.when));

// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const base = admin?.slice(0, admin.lastIndexOf("/"));
const run = admin ? describe : describe.skip;

run("migrate", () => {
  const sql = admin ? postgres(admin, { max: 1, onnotice: () => {} }) : (undefined as never);
  beforeAll(async () => {
    for (const db of [
      "mig_fresh",
      "mig_adopt",
      "mig_hold",
      "mig_guard",
      "mig_preview",
      "mig_release",
      "mig_release_guard",
      "mig_lock",
      "mig_lock_retry",
    ]) {
      await sql.unsafe(`drop database if exists ${db}`);
      await sql.unsafe(`create database ${db}`);
    }
    // Other test files create and drop databases on the same server at the same time.
  }, 30_000);
  afterAll(() => sql.end());

  // The schema Directus made, without migration history: what prod is before cutover.
  const directusSchema = async (name: string) => {
    const db = postgres(`${base}/${name}`, { max: 1, onnotice: () => {} });
    for (const tag of ["0000_baseline", "0001_baseline_guards"]) {
      const file = await Bun.file(new URL(`../migrations/${tag}.sql`, import.meta.url)).text();
      for (const statement of file.split("--> statement-breakpoint"))
        if (statement.trim()) await db.unsafe(statement);
    }
    await db.end();
  };

  test("builds an empty database from the chain, then does nothing on a second run", async () => {
    const first = await migrate(`${base}/mig_fresh`, { appEnv: "test" });
    expect(first).toEqual({ adoptedBaseline: false, applied: TOTAL });
    const second = await migrate(`${base}/mig_fresh`, { appEnv: "test" });
    expect(second).toEqual({ adoptedBaseline: false, applied: 0 });
    // The whole chain on an empty database takes about half a second alone, and several
    // seconds while the rest of the suite runs in parallel against the same server.
  }, 30_000);

  test("adopts a database that already has the schema without re-running the baseline", async () => {
    // Running the baseline again would fail on its existing tables, and later migrations
    // need the tables it made.
    await directusSchema("mig_adopt");
    const r = await migrate(`${base}/mig_adopt`, { appEnv: "test" });
    expect(r.adoptedBaseline).toBe(true);
    // The baseline is recorded, not run; later migrations run normally.
    expect(r.applied).toBe(TOTAL - BASELINE);
  }, 30_000);

  test("holds contract migrations back for a database the old stack shares", async () => {
    const r = await migrate(`${base}/mig_hold`, { holdContract: true, appEnv: "prod" });
    expect(r).toEqual({ adoptedBaseline: false, applied: TOTAL - CONTRACT });
    const db = postgres(`${base}/mig_hold`, { max: 1, onnotice: () => {} });
    // A table the contract migration drops is still there for the old stack.
    const [row] = await db`select to_regclass('public.project_analysis_run') is not null as kept`;
    await db.end();
    expect(row?.kept).toBe(true);
  }, 30_000);

  test("refuses a contract migration outside local, test and preview until its archive is recorded", async () => {
    const url = `${base}/mig_guard`;
    // The cutover path: the database the old stack runs on, with every migration after
    // the baseline still to come.
    await directusSchema("mig_guard");
    for (const appEnv of ["prod", "staging", undefined]) {
      const err = await migrate(url, { appEnv }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ContractArchiveMissing);
      expect((err as Error).message).toContain("packages/db/scripts/archive-tables.sh");
      expect((err as ContractArchiveMissing).migrations).toEqual(CONTRACTS);
    }
    const db = postgres(url, { max: 1, onnotice: () => {} });
    const kept = async () =>
      (await db`select to_regclass('public.project_analysis_run') is not null as v`)[0]?.v;
    // Refused before anything ran: the tables it would drop are still there.
    expect(await kept()).toBe(true);

    for (const migration of CONTRACTS)
      await recordContractArchive(url, {
        migration,
        destination: "gs://dembrane-echo-archive/mig_guard/20260928T000000Z",
        manifest: "table\trows\tbytes\tobject\n",
      });
    expect(await migrate(url, { appEnv: "prod" })).toEqual({
      adoptedBaseline: false,
      applied: TOTAL - BASELINE,
    });
    expect(await kept()).toBe(false);
    await db.end();
  }, 30_000);

  const kept = async (url: string) => {
    const db = postgres(url, { max: 1, onnotice: () => {} });
    const [row] = await db`select to_regclass('public.project_analysis_run') is not null as v`;
    const runs = await db`select created_at from drizzle.__drizzle_migrations
      where created_at = any(${CONTRACT_MILLIS}::bigint[])`;
    await db.end();
    return { table: row?.v as boolean, contractRuns: runs.length };
  };

  test("releasing the hold applies a held contract once, even after newer migrations", async () => {
    // The bug this guards: newer migrations applied while the contract was held, then the
    // release finding nothing "newer than the latest" to apply, so the contract never ran.
    const lastContract = journal.entries.findLastIndex((e) => e.tag.includes("_contract_"));
    expect(lastContract).toBeLessThan(TOTAL - 1);
    const url = `${base}/mig_release`;
    expect(await migrate(url, { holdContract: true, appEnv: "test" })).toEqual({
      adoptedBaseline: false,
      applied: TOTAL - CONTRACT,
    });
    expect(await kept(url)).toEqual({ table: true, contractRuns: 0 });
    // Holding again leaves it held.
    expect((await migrate(url, { holdContract: true, appEnv: "test" })).applied).toBe(0);

    expect(await migrate(url, { appEnv: "test" })).toEqual({
      adoptedBaseline: false,
      applied: CONTRACT,
    });
    expect(await kept(url)).toEqual({ table: false, contractRuns: CONTRACT });
    // Releasing twice does nothing more.
    expect((await migrate(url, { appEnv: "test" })).applied).toBe(0);
    expect(await kept(url)).toEqual({ table: false, contractRuns: CONTRACT });
  }, 30_000);

  test("releasing the hold outside local, test and preview still needs the archive", async () => {
    const url = `${base}/mig_release_guard`;
    await migrate(url, { holdContract: true, appEnv: "prod" });
    const err = await migrate(url, { appEnv: "prod" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractArchiveMissing);
    expect((err as ContractArchiveMissing).migrations).toEqual(CONTRACTS);
    expect(await kept(url)).toEqual({ table: true, contractRuns: 0 });
    for (const migration of CONTRACTS)
      await recordContractArchive(url, {
        migration,
        destination: "gs://dembrane-echo-archive/mig_release_guard/20261003T000000Z",
        manifest: "table\trows\tbytes\tobject\n",
      });
    expect((await migrate(url, { appEnv: "prod" })).applied).toBe(CONTRACT);
    expect(await kept(url)).toEqual({ table: false, contractRuns: CONTRACT });
  }, 30_000);

  test("migrate gives up on a held lock after its bounded retries instead of queueing", async () => {
    const url = `${base}/mig_lock`;
    await migrate(url, { appEnv: "test" });
    const db = postgres(url, { max: 2, onnotice: () => {} });
    await db`delete from drizzle.__drizzle_migrations where created_at >= ${FREE_TIER_MILLIS}`;
    const holder = await db.reserve();
    await holder`begin`;
    await holder`lock table conversation in access exclusive mode`;
    const started = Date.now();
    const run = migrate(url, { appEnv: "test" }).then(
      () => "applied",
      (e: unknown) => e,
    );
    const outcome = await Promise.race([run, Bun.sleep(45_000).then(() => "waiting")]);
    const elapsed = Date.now() - started;
    await holder`rollback`;
    holder.release();
    await run;
    await db.end();
    // Drizzle wraps the Postgres error.
    const err = outcome as { code?: string; cause?: { code?: string } };
    expect(err.code ?? err.cause?.code).toBe("55P03");
    // Each attempt waits 5 s for the lock, then the run gives up.
    expect(elapsed).toBeGreaterThanOrEqual(LOCK_ATTEMPTS * 5_000);
    expect(elapsed).toBeLessThan(40_000);
    // Nothing was recorded: the run rolled back.
    const left = postgres(url, { max: 1, onnotice: () => {} });
    const [row] = await left`select count(*)::int as n from drizzle.__drizzle_migrations
      where created_at >= ${FREE_TIER_MILLIS}`;
    await left.end();
    expect(row?.n).toBe(0);
  }, 90_000);

  test("migrate applies once a held lock is released between attempts", async () => {
    const url = `${base}/mig_lock_retry`;
    await migrate(url, { appEnv: "test" });
    const db = postgres(url, { max: 2, onnotice: () => {} });
    await db`delete from drizzle.__drizzle_migrations where created_at >= ${FREE_TIER_MILLIS}`;
    const holder = await db.reserve();
    await holder`begin`;
    await holder`lock table conversation in access exclusive mode`;
    const run = migrate(url, { appEnv: "test" });
    await Bun.sleep(6_000);
    await holder`rollback`;
    holder.release();
    const r = await run;
    await db.end();
    expect(r.applied).toBeGreaterThan(0);
  }, 90_000);

  test("preview applies contract migrations without an archive", async () => {
    const r = await migrate(`${base}/mig_preview`, { appEnv: "preview" });
    expect(r).toEqual({ adoptedBaseline: false, applied: TOTAL });
  }, 30_000);
});
