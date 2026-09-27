import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { migrate } from "../src/migrate";

// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const base = admin?.slice(0, admin.lastIndexOf("/"));
const run = admin ? describe : describe.skip;

run("migrate", () => {
  const sql = admin ? postgres(admin, { max: 1, onnotice: () => {} }) : (undefined as never);
  beforeAll(async () => {
    for (const db of ["mig_fresh", "mig_adopt"]) {
      await sql.unsafe(`drop database if exists ${db}`);
      await sql.unsafe(`create database ${db}`);
    }
  });
  afterAll(() => sql.end());

  test("builds an empty database from the chain, then does nothing on a second run", async () => {
    const first = await migrate(`${base}/mig_fresh`);
    expect(first).toEqual({ adoptedBaseline: false, applied: 3 });
    const second = await migrate(`${base}/mig_fresh`);
    expect(second).toEqual({ adoptedBaseline: false, applied: 0 });
  });

  test("adopts a database that already has the schema without re-running the baseline", async () => {
    const db = postgres(`${base}/mig_adopt`, { max: 1, onnotice: () => {} });
    // A table the baseline would create: executing the baseline would fail on it.
    await db`create table project (id uuid primary key)`;
    await db.end();
    const r = await migrate(`${base}/mig_adopt`);
    expect(r.adoptedBaseline).toBe(true);
    // The baseline is recorded, not run; later migrations run normally.
    expect(r.applied).toBe(1);
  });
});
