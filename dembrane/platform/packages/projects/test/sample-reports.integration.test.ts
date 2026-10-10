import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { projectsStorage } from "../src/storage";

// A free workspace gets one report. Reports on its sample copy (project.is_sample) are not
// the workspace's own and leave that report free.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `projects_sample_reports_${process.pid}`;

run("the free report and a sample project", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const ws = crypto.randomUUID();
  const own = crypto.randomUUID();
  const sample = crypto.randomUUID();

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const [org, billing] = [crypto.randomUUID(), crypto.randomUUID()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${own}, 'Mine', ${ws}, true)`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample)
      values (${sample}, 'Best practices (sample)', ${ws}, false, true)`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("a report on the sample does not count; one on the workspace's own project does", async () => {
    const store = projectsStorage(database.db);
    await sql`insert into project_report (project_id, kind, status, content) values (${sample}, 'report', 'published', 'x')`;
    expect(await store.countWorkspaceReports(ws)).toBe(0);
    await sql`insert into project_report (project_id, kind, status, content) values (${own}, 'report', 'published', 'x')`;
    expect(await store.countWorkspaceReports(ws)).toBe(1);
  });
});
