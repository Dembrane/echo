import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { ContractArchiveMissing, migrate, recordContractArchive } from "../src/migrate";

// Counted from the journal so a new migration does not require editing this test.
const journal = (await Bun.file(
  new URL("../migrations/meta/_journal.json", import.meta.url),
).json()) as {
  entries: { tag: string }[];
};
const TOTAL = journal.entries.length;
const BASELINE = 2;
const CONTRACTS = journal.entries.filter((e) => e.tag.includes("_contract_")).map((e) => e.tag);
const CONTRACT = CONTRACTS.length;

// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const base = admin?.slice(0, admin.lastIndexOf("/"));
const run = admin ? describe : describe.skip;

run("migrate", () => {
  const sql = admin ? postgres(admin, { max: 1, onnotice: () => {} }) : (undefined as never);
  beforeAll(async () => {
    for (const db of ["mig_fresh", "mig_adopt", "mig_hold", "mig_guard", "mig_preview"]) {
      await sql.unsafe(`drop database if exists ${db}`);
      await sql.unsafe(`create database ${db}`);
    }
  });
  afterAll(() => sql.end());

  test("builds an empty database from the chain, then does nothing on a second run", async () => {
    const first = await migrate(`${base}/mig_fresh`, { appEnv: "test" });
    expect(first).toEqual({ adoptedBaseline: false, applied: TOTAL });
    const second = await migrate(`${base}/mig_fresh`, { appEnv: "test" });
    expect(second).toEqual({ adoptedBaseline: false, applied: 0 });
    // The whole chain on an empty database takes about half a second alone, and several
    // seconds while the rest of the suite runs in parallel against the same server.
  }, 30_000);

  test("adopts a database that already has the schema without re-running the baseline", async () => {
    const db = postgres(`${base}/mig_adopt`, { max: 1, onnotice: () => {} });
    // The schema Directus made, without migration history: running the baseline again
    // would fail on its existing tables, and later migrations need the tables it made.
    for (const tag of ["0000_baseline", "0001_baseline_guards"]) {
      const file = await Bun.file(new URL(`../migrations/${tag}.sql`, import.meta.url)).text();
      for (const statement of file.split("--> statement-breakpoint"))
        if (statement.trim()) await db.unsafe(statement);
    }
    await db.end();
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
    // The cutover path: everything but the contract is applied while the old stack runs.
    await migrate(url, { holdContract: true, appEnv: "prod" });
    for (const appEnv of ["prod", "next", undefined]) {
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
      applied: CONTRACT,
    });
    expect(await kept()).toBe(false);
    await db.end();
  }, 30_000);

  test("preview applies contract migrations without an archive", async () => {
    const r = await migrate(`${base}/mig_preview`, { appEnv: "preview" });
    expect(r).toEqual({ adoptedBaseline: false, applied: TOTAL });
  }, 30_000);
});
