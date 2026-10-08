import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import postgres from "postgres";
import type { ProjectDeps } from "../src/projects";
import { updateReport } from "../src/reports";
import { projectsStorage } from "../src/storage";

// Publishing a report emails its subscribers; the job must commit with the publish, once.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = "projects_report_publish_test";

run("report publish", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let d: ProjectDeps;
  const enqueued: { name: string; payload: unknown; inTx: boolean }[] = [];
  const owner: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
  const project = newId();
  const edit = { status: null, show_portal_link: null, content: null, scheduled_at: null };

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${DB}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [org, ws, billing] = [newId(), newId(), newId()];
    await sql`insert into app_user (id, directus_user_id) values (${owner.appUserId}, ${owner.directusUserId})`;
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id) values (${billing}, ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner')`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${project}, 'P', ${ws}, true)`;
    d = {
      store: projectsStorage(database.db),
      access: new Access(new DrizzleAccessStore(database.db)),
      jobs: {
        async enqueue(def, payload, opts) {
          enqueued.push({ name: def.name, payload, inTx: Boolean(opts?.tx) });
          return "job";
        },
      },
      now: () => new Date(),
    };
  });
  afterAll(async () => {
    await sql.end();
    await database.close();
  });

  test("publishing enqueues the subscriber email job inside the publish transaction, once", async () => {
    const [r] =
      await sql`insert into project_report (project_id, status, language, kind, content, date_created)
      values (${project}, 'archived', 'en', 'report', '# Done', now()) returning id::int`;
    const rid = r?.id as number;
    await updateReport(d, owner, project, rid, { ...edit, status: "published" });
    expect(enqueued).toEqual([
      {
        name: "reports.notify-subscribers",
        payload: { projectId: project, reportId: rid },
        inTx: true,
      },
    ]);

    // Editing or re-saving a report that is already published emails nobody again.
    enqueued.length = 0;
    await updateReport(d, owner, project, rid, { ...edit, content: "# Done, edited" });
    await updateReport(d, owner, project, rid, { ...edit, status: "published" });
    expect(enqueued).toEqual([]);

    // Taking it off the public page and publishing it again does.
    await updateReport(d, owner, project, rid, { ...edit, status: "archived" });
    await updateReport(d, owner, project, rid, { ...edit, status: "published" });
    expect(enqueued.map((e) => e.name)).toEqual(["reports.notify-subscribers"]);
  });
});
