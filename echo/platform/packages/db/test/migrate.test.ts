import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { migrate } from "../src/migrate";

// Counted from the journal so a new migration does not require editing this test.
const journal = (await Bun.file(
  new URL("../migrations/meta/_journal.json", import.meta.url),
).json()) as {
  entries: { tag: string }[];
};
const TOTAL = journal.entries.length;
const BASELINE = 2;
const CONTRACT = journal.entries.filter((e) => e.tag.includes("_contract_")).length;

/** The baseline's statements, the schema a Directus-created database already has. */
async function baselineStatements(): Promise<string[]> {
  const out: string[] = [];
  for (const tag of ["0000_baseline", "0001_baseline_guards"]) {
    const text = await Bun.file(new URL(`../migrations/${tag}.sql`, import.meta.url)).text();
    out.push(...text.split("--> statement-breakpoint").filter((s) => s.trim()));
  }
  return out;
}

// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const base = admin?.slice(0, admin.lastIndexOf("/"));
const run = admin ? describe : describe.skip;

run("migrate", () => {
  const sql = admin ? postgres(admin, { max: 1, onnotice: () => {} }) : (undefined as never);
  beforeAll(async () => {
    for (const db of ["mig_fresh", "mig_adopt", "mig_hold"]) {
      await sql.unsafe(`drop database if exists ${db}`);
      await sql.unsafe(`create database ${db}`);
    }
  });
  afterAll(() => sql.end());

  test("builds an empty database from the chain, then does nothing on a second run", async () => {
    const first = await migrate(`${base}/mig_fresh`);
    expect(first).toEqual({ adoptedBaseline: false, applied: TOTAL });
    const second = await migrate(`${base}/mig_fresh`);
    expect(second).toEqual({ adoptedBaseline: false, applied: 0 });
    // The whole chain on an empty database takes about half a second alone, and several
    // seconds while the rest of the suite runs in parallel against the same server.
  }, 30_000);

  test("adopts a database that already has the schema without re-running the baseline", async () => {
    const db = postgres(`${base}/mig_adopt`, { max: 1, onnotice: () => {} });
    // The schema without migration history: executing the baseline again would fail on it.
    for (const statement of await baselineStatements()) await db.unsafe(statement);
    await db.end();
    const r = await migrate(`${base}/mig_adopt`);
    expect(r.adoptedBaseline).toBe(true);
    // The baseline is recorded, not run; later migrations run normally.
    expect(r.applied).toBe(TOTAL - BASELINE);
  }, 30_000);

  test("holds contract migrations back for a database the old stack shares", async () => {
    const r = await migrate(`${base}/mig_hold`, { holdContract: true });
    expect(r).toEqual({ adoptedBaseline: false, applied: TOTAL - CONTRACT });
    const db = postgres(`${base}/mig_hold`, { max: 1, onnotice: () => {} });
    // A table the contract migration drops is still there for the old stack.
    const [row] = await db`select to_regclass('public.project_analysis_run') is not null as kept`;
    await db.end();
    expect(row?.kept).toBe(true);
  }, 30_000);
});
