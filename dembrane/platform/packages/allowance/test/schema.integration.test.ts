import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, migrate } from "@dembrane/db";
import type postgres from "postgres";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_schema_${process.pid}`;
const ACCOUNT = "ba000000-0000-4000-8000-000000000001";

// bun's expect().rejects hangs on postgres.js's lazy query thenable.
const failure = (q: PromiseLike<unknown>) =>
  Promise.resolve(q).then(
    () => "",
    (e: Error) => e.message,
  );

run("tier_limit and free_usage tables", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("tier_limit keys on (tier, key)", async () => {
    await sql`insert into tier_limit (tier, key, value) values ('free', 'audio_seconds_month', 18000)`;
    const [row] =
      await sql`select value, updated_at, updated_by from tier_limit where tier = 'free'`;
    expect(Number(row?.value)).toBe(18000);
    expect(row?.updated_at).toBeTruthy();
    expect(row?.updated_by).toBeNull();
    const dup = sql`insert into tier_limit (tier, key, value) values ('free', 'audio_seconds_month', 1)`;
    expect(await failure(dup)).toMatch(/duplicate key/);
  });

  test("free_usage keys on (account, period, key) and amount defaults to 0", async () => {
    await sql`insert into free_usage (billing_account_id, period_start, key)
      values (${ACCOUNT}, '2026-10-01T00:00:00Z', 'chats')`;
    const [row] =
      await sql`select amount, updated_at from free_usage where billing_account_id = ${ACCOUNT}`;
    expect(Number(row?.amount)).toBe(0);
    expect(row?.updated_at).toBeTruthy();
    const dup = sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${ACCOUNT}, '2026-10-01T00:00:00Z', 'chats', 5)`;
    expect(await failure(dup)).toMatch(/duplicate key/);
  });
});
