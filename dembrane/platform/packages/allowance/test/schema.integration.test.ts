import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connect, migrate } from "@dembrane/db";
import type postgres from "postgres";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `allowance_schema_${process.pid}`;
const ACCOUNT = "ba000000-0000-4000-8000-000000000001";
const OTHER = "ba000000-0000-4000-8000-000000000002";
const RETIRE = new URL("../../db/migrations/0048_expand_retire_free_counts.sql", import.meta.url);
const OLD_USAGE = ["chats", "reports", "maps", "popcorn_analyses"];
const OLD_LIMITS = [
  "chats_month",
  "chat_turns_per_chat",
  "reports_month",
  "maps_month",
  "popcorn_analyses_month",
];

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
      await sql`select value, updated_at, updated_by from tier_limit where tier = 'free' and key = 'audio_seconds_month'`;
    expect(Number(row?.value)).toBe(18000);
    expect(row?.updated_at).toBeTruthy();
    expect(row?.updated_by).toBeNull();
    const dup = sql`insert into tier_limit (tier, key, value) values ('free', 'audio_seconds_month', 1)`;
    expect(await failure(dup)).toMatch(/duplicate key/);
  });

  test("free_usage keys on (account, period, key) and amount defaults to 0", async () => {
    await sql`insert into free_usage (billing_account_id, period_start, key)
      values (${ACCOUNT}, '2026-10-01T00:00:00Z', 'audio_seconds')`;
    const [row] =
      await sql`select amount, updated_at from free_usage where billing_account_id = ${ACCOUNT}`;
    expect(Number(row?.amount)).toBe(0);
    expect(row?.updated_at).toBeTruthy();
    const dup = sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${ACCOUNT}, '2026-10-01T00:00:00Z', 'audio_seconds', 5)`;
    expect(await failure(dup)).toMatch(/duplicate key/);
  });

  test("after migrating no free limit row holds a retired count", async () => {
    const rows = await sql`select key from tier_limit where key in ${sql(OLD_LIMITS)}`;
    expect(rows).toHaveLength(0);
  });

  test("0048 deletes the retired counts and keeps everything else", async () => {
    const period = "2026-09-01T00:00:00Z";
    for (const key of OLD_USAGE)
      await sql`insert into free_usage (billing_account_id, period_start, key, amount)
        values (${OTHER}, ${period}, ${key}, 1)`;
    await sql`insert into free_usage (billing_account_id, period_start, key, amount) values
      (${OTHER}, ${period}, 'audio_seconds', 60), (${OTHER}, ${period}, 'ai_spend_micro_eur', 70),
      (${OTHER}, ${period}, 'notice:ai_out', 1)`;
    for (const key of OLD_LIMITS)
      await sql`insert into tier_limit (tier, key, value) values ('free', ${key}, 3), ('innovator', ${key}, 3)`;
    await sql`insert into tier_limit (tier, key, value) values ('free', 'projects', 2)
      on conflict (tier, key) do update set value = 2`;

    const text = readFileSync(RETIRE, "utf8").replaceAll("--> statement-breakpoint", "");
    await sql.unsafe(text);
    await sql.unsafe(text);

    const usage = await sql<{ key: string }[]>`select key from free_usage
      where billing_account_id = ${OTHER} order by key`;
    expect(usage.map((r) => r.key)).toEqual([
      "ai_spend_micro_eur",
      "audio_seconds",
      "notice:ai_out",
    ]);
    const free =
      await sql`select key from tier_limit where tier = 'free' and key in ${sql(OLD_LIMITS)}`;
    expect(free).toHaveLength(0);
    const kept =
      await sql`select key from tier_limit where tier = 'innovator' and key in ${sql(OLD_LIMITS)}`;
    expect(kept).toHaveLength(OLD_LIMITS.length);
    const [projects] =
      await sql`select value from tier_limit where tier = 'free' and key = 'projects'`;
    expect(Number(projects?.value)).toBe(2);
  });
});
