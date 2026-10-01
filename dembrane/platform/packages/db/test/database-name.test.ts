import { expect, test } from "bun:test";
import { connect } from "../src/connection";
import { dropPreviewDatabase, ensurePreviewDatabase, withDatabase } from "../src/database-name";

test("the database name replaces the URL's database and keeps the socket", () => {
  const url = "postgres://echo_app:pw@localhost/echo?host=/cloudsql/p:r:i";
  expect(withDatabase(url, "echo_pr_42")).toBe(
    "postgres://echo_app:pw@localhost/echo_pr_42?host=/cloudsql/p:r:i",
  );
  expect(withDatabase(url)).toBe(url);
});

test("only PR preview databases can be created or dropped", async () => {
  const url = "postgres://u:p@127.0.0.1:1/echo";
  await expect(dropPreviewDatabase(url, "echo")).rejects.toThrow("not a PR preview database");
  await expect(ensurePreviewDatabase(url, "echo_pr_1; drop")).rejects.toThrow(
    "not a PR preview database",
  );
});

const admin = process.env.TEST_DATABASE_ADMIN_URL;
test.skipIf(!admin)(
  "a preview database is created once and dropped with open connections",
  async () => {
    const url = admin as string;
    const name = `echo_pr_${process.pid}`;
    expect(await ensurePreviewDatabase(url, name)).toBe(true);
    expect(await ensurePreviewDatabase(url, name)).toBe(false);
    const held = connect(withDatabase(url, name), { max: 1, onnotice: () => {} });
    await held`select 1`;
    await dropPreviewDatabase(url, name);
    const sql = connect(url, { max: 1 });
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    await sql.end();
    await held.end({ timeout: 1 }).catch(() => {});
    expect(rows.length).toBe(0);
  },
);
