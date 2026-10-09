import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate } from "@dembrane/db";
import postgres from "postgres";
import { audiences } from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `notif_people_${process.pid}`;

const id = (n: number) => `a0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const ORG = id(5);
const BILLING_ACCOUNT = id(6);
const WS = id(1);
const OPEN = id(2);
const PRIVATE = id(3);
const GONE = id(4);
const OWNER = id(11);
const ADMIN = id(12);
const MEMBER = id(13);
const BILLING = id(14);
const LEFT = id(15);
const SHARED = id(16);
const SUPPORT = id(17);

run("who hears about a project", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    for (const u of [OWNER, ADMIN, MEMBER, BILLING, LEFT, SHARED, SUPPORT])
      await sql`insert into app_user (id, email) values (${u}, ${`${u}@example.com`})`;
    await sql`insert into org (id, name) values (${ORG}, 'People org')`;
    await sql`insert into billing_account (id, org_id) values (${BILLING_ACCOUNT}, ${ORG})`;
    await sql`insert into workspace (id, name, visibility, org_id, billing_account_id)
      values (${WS}, 'People', 'invite_only', ${ORG}, ${BILLING_ACCOUNT})`;
    const member = (n: number, user: string, role: string, source = "direct", left = false) =>
      sql`insert into workspace_membership (id, workspace_id, user_id, role, source, deleted_at)
        values (${id(n)}, ${WS}, ${user}, ${role}, ${source}, ${left ? sql`now()` : null})`;
    await member(21, OWNER, "owner");
    await member(22, ADMIN, "admin");
    await member(23, MEMBER, "member");
    await member(24, BILLING, "billing");
    await member(25, LEFT, "member", "direct", true);
    await member(26, SUPPORT, "admin", "staff_support");
    await sql`insert into project (id, name, language, is_conversation_allowed, workspace_id, visibility, deleted_at, created_at, updated_at)
      values (${OPEN}, 'Open', 'en', true, ${WS}, 'workspace', null, now(), now()),
             (${PRIVATE}, 'Private', 'en', true, ${WS}, 'private', null, now(), now()),
             (${GONE}, 'Gone', 'en', true, ${WS}, 'workspace', now(), now(), now())`;
    await sql`insert into project_membership (id, project_id, user_id) values (${id(31)}, ${PRIVATE}, ${SHARED})`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("a workspace project reaches everyone whose role opens projects", async () => {
    const got = await audiences(database.db).projectPeople(OPEN);
    expect(got.workspaceId).toBe(WS);
    expect([...got.userIds].sort()).toEqual([OWNER, ADMIN, MEMBER].sort());
  });

  test("a private project reaches its admins and the people it is shared with", async () => {
    const got = await audiences(database.db).projectPeople(PRIVATE);
    expect([...got.userIds].sort()).toEqual([OWNER, ADMIN, SHARED].sort());
  });

  test("a deleted or unknown project reaches nobody", async () => {
    expect(await audiences(database.db).projectPeople(GONE)).toEqual({
      workspaceId: null,
      userIds: [],
    });
    expect((await audiences(database.db).projectPeople(id(99))).userIds).toEqual([]);
  });
});
