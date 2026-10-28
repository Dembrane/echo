import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, createDb, migrate, schema } from "@dembrane/db";
import { type AuditScope, auditStorage } from "../src/audit-storage";

// A scratch database per run: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `account_audit_pages_${process.pid}`;

const me = "d0000000-0000-4000-8000-000000000001";
const other = "d0000000-0000-4000-8000-000000000002";
const nobody = "d0000000-0000-4000-8000-000000000003";
const noFilter = { actions: [], collections: [] };
const scopeOf = (userId: string): AuditScope => ({ all: false, userId });

run("audit pages", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let store: ReturnType<typeof auditStorage>;
  /** Ids of the rows by or about `me`, ascending. */
  let mine: number[];
  /** The same rows narrowed to updates on projects. */
  let mineFiltered: number[];

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    store = auditStorage(database.db);

    await database.db.insert(schema.directus_users).values([
      { id: me, email: "me@example.com", first_name: "Me", status: "active" },
      { id: other, email: "other@example.com", first_name: "Other", status: "active" },
    ]);
    // 60 rows sharing four timestamps, so order cannot lean on the clock. Every third row is
    // by `me`, every fifth is about `me`, the rest belong to `other`.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      action: i % 2 ? "update" : "create",
      collection: i % 4 < 2 ? "project" : "conversation",
      user: i % 3 === 0 ? me : other,
      item: i % 5 === 0 ? me : `item-${i}`,
      timestamp: `2026-01-01T00:00:0${i % 4}Z`,
    }));
    const inserted = await database.db
      .insert(schema.directus_activity)
      .values(rows)
      .returning({ id: schema.directus_activity.id });
    const ownRows = inserted
      .map((r, i) => ({ id: r.id, row: rows[i] }))
      .filter(({ row }) => row?.user === me || row?.item === me);
    mine = ownRows.map((r) => r.id).sort((x, y) => x - y);
    mineFiltered = ownRows
      .filter(({ row }) => row?.action === "update" && row?.collection === "project")
      .map((r) => r.id)
      .sort((x, y) => x - y);
  });

  afterAll(async () => {
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  /** Reads every page the way the settings card does: next cursor until a short page. */
  async function walk(
    scope: AuditScope,
    f: { actions: string[]; collections: string[] },
    pageSize: number,
    ascending: boolean,
    window: number,
  ) {
    const seen: number[] = [];
    let after: number | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const fetched = await store.page(scope, f, {
        limit: pageSize + 1,
        ascending,
        window,
        after,
      });
      const rows = fetched.slice(0, pageSize);
      seen.push(...rows.map((r) => r.id));
      if (fetched.length <= pageSize) return seen;
      after = rows[rows.length - 1]?.id;
    }
    throw new Error("pagination did not end");
  }

  const newestFirst = (ids: number[]) => [...ids].sort((x, y) => y - x);

  // Window 1 sends every page through the second pass, 7 mixes both passes, a million
  // never leaves the first.
  for (const window of [1, 7, 1_000_000]) {
    for (const pageSize of [1, 4, 5, 100]) {
      test(`no duplicates or gaps, window ${window}, page size ${pageSize}`, async () => {
        const down = await walk(scopeOf(me), noFilter, pageSize, false, window);
        expect(down).toEqual(newestFirst(mine));
        const up = await walk(scopeOf(me), noFilter, pageSize, true, window);
        expect(up).toEqual(mine);
      });
    }
  }

  test("a user with no activity gets an empty page", async () => {
    expect(await walk(scopeOf(nobody), noFilter, 5, false, 7)).toEqual([]);
  });

  test("filters page the same way", async () => {
    const f = { actions: ["update"], collections: ["project"] };
    expect(mineFiltered.length).toBeGreaterThan(3);
    expect(await walk(scopeOf(me), f, 3, false, 5)).toEqual(newestFirst(mineFiltered));
    expect(await walk(scopeOf(me), f, 3, true, 5)).toEqual(mineFiltered);
  });

  test("filter counts agree with the rows", async () => {
    const counts = await store.counts(scopeOf(me));
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(mine.length);
  });
});
