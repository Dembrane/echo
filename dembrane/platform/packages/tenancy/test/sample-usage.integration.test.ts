import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { countsByWorkspace, liveProjectsIn } from "../src/storage/orgs";
import { projectListPage } from "../src/storage/projects";
import { countLiveProjects, deleteSampleProjects, workspaceProjects } from "../src/storage/usage";
import { cardUsage, freeTierBlock } from "../src/usage";

// A workspace's sample copy (project.is_sample) is listed with its projects, but its
// invented hours, conversations, chats and reports are no part of the workspace's usage
// or free allowance, it is no project to wind down, and it goes with the workspace.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_sample_usage_${process.pid}`;

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const WS = n("c1", 1);
const OWN = n("b1", 1);
const SAMPLE = n("b1", 2);

run("workspace usage and a sample project", () => {
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

    await sql`insert into billing_account (id, tier) values (${n("ba", 1)}, 'free')`;
    await sql`insert into org (id, name) values (${n("0a", 1)}, 'Org')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${WS}, 'W', ${n("0a", 1)}, ${n("ba", 1)})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${OWN}, 'Mine', ${WS}, true)`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample)
      values (${SAMPLE}, 'Best practices (sample)', ${WS}, false, true)`;
    await sql`insert into conversation (id, project_id, participant_name, duration, created_at, updated_at) values
      (${n("e1", 1)}, ${OWN}, 'P', 1800, now(), now()),
      (${n("e1", 2)}, ${SAMPLE}, 'Invented', 3600, now(), now()),
      (${n("e1", 3)}, ${SAMPLE}, 'Invented', 3600, now(), now())`;
    // The seeded chat with its question, and a report on the sample.
    await sql`insert into project_chat (id, project_id) values (${n("cc", 1)}, ${SAMPLE})`;
    await sql`insert into project_chat_message (id, project_chat_id, message_from, text)
      values (${n("cd", 1)}, ${n("cc", 1)}, 'user', 'How do other organisations use dembrane?')`;
    await sql`insert into project_report (project_id, kind, status, content) values (${SAMPLE}, 'report', 'published', 'x')`;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("the workspace card counts only the workspace's own hours and conversations", async () => {
    const usage = await cardUsage(database.db, WS, new Date());
    expect(usage).toMatchObject({
      audio_hours: 0.5,
      conversation_count: 1,
      audio_hours_this_month: 0.5,
      conversations_this_month: 1,
    });
  });

  test("the free allowance has its chat and its report still to spend", async () => {
    const ids = (await workspaceProjects(database.db, WS)).map((p) => p.id);
    expect(ids).toEqual([OWN]);
    expect(await freeTierBlock(database.db, "free", ids)).toMatchObject({
      chats_used: 0,
      primary_chat_id: null,
      reports_used: 0,
      primary_report_id: null,
    });
  });

  test("project counts leave the sample out, but the project list shows it", async () => {
    expect(await countLiveProjects(database.db, WS)).toBe(1);
    expect((await countsByWorkspace(database.db, [WS])).projects.get(WS)).toBe(1);
    expect((await liveProjectsIn(database.db, [WS])).map((p) => p.id)).toEqual([OWN]);
    const { page } = await projectListPage(database.db, {
      workspaceId: WS,
      privateVisible: null,
      search: null,
      countTotal: false,
      offset: 0,
      limit: 10,
    });
    expect(page.map((p) => p.id).sort()).toEqual([OWN, SAMPLE].sort());
  });

  test("deleting the workspace deletes its sample and nothing else", async () => {
    await deleteSampleProjects(database.db, WS, new Date().toISOString());
    const rows =
      await sql`select id, deleted_at from project where workspace_id = ${WS} order by id`;
    expect(rows.map((r) => [r.id, r.deleted_at === null])).toEqual([
      [OWN, true],
      [SAMPLE, false],
    ]);
  });
});
