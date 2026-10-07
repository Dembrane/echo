import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { projectListPage } from "../src/storage/projects";
import { cardUsage } from "../src/usage";

// A workspace card counts the conversations of its live projects; hours keep every
// project's billable time, deleted ones included.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_card_usage_${process.pid}`;

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const WS = n("c1", 1);
const LIVE = n("b1", 1);
const DELETED = n("b1", 2);

run("workspace card usage", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = connect(url, { max: 2, onnotice: () => {} });

    await sql`insert into billing_account (id) values (${n("ba", 1)})`;
    await sql`insert into org (id, name) values (${n("0a", 1)}, 'Org')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${WS}, 'W', ${n("0a", 1)}, ${n("ba", 1)})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, deleted_at) values
      (${LIVE}, 'Live', ${WS}, true, null), (${DELETED}, 'Gone', ${WS}, true, now())`;
    await sql`insert into conversation (id, project_id, participant_name, duration, created_at, updated_at) values
      (${n("e1", 1)}, ${LIVE}, 'P', 3600, now(), now()),
      (${n("e1", 2)}, ${DELETED}, 'P', 3600, now(), now())`;
    await sql`insert into conversation (id, project_id, participant_name, created_at, updated_at, deleted_at)
      values (${n("e1", 3)}, ${LIVE}, 'P', now(), now(), now())`;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("a deleted project's conversations leave the counts but keep their hours", async () => {
    const usage = await cardUsage(database.db, WS, new Date());
    expect({
      conversation_count: usage.conversation_count,
      conversations_this_month: usage.conversations_this_month,
      audio_hours: usage.audio_hours,
      audio_hours_this_month: usage.audio_hours_this_month,
    }).toEqual({
      conversation_count: 1,
      conversations_this_month: 1,
      audio_hours: 2,
      audio_hours_this_month: 2,
    });
  });

  test("the project list counts a project's live conversations, not deleted ones", async () => {
    const { page } = await projectListPage(database.db, {
      workspaceId: WS,
      privateVisible: null,
      search: null,
      countTotal: false,
      offset: 0,
      limit: 10,
    });
    expect(page.map((p) => [p.name, p.conversations_count])).toEqual([["Live", 1]]);
  });
});
