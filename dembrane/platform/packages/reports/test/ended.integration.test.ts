import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@dembrane/db";
import { installQueueSchema } from "@dembrane/queue";
import postgres from "postgres";

// A step that throws past its own handler (as a DBOS step timeout does) still ends the
// report in error, so it no longer blocks the project's next report.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `reports_ended_test_${process.pid}`;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/${dbName}` : "";
const trace = join(tmpdir(), `echo-report-ended-${Date.now()}.log`);
const fixture = new URL("./fixtures/worker.ts", import.meta.url).pathname;
const PROJECT = "f0000000-0000-4000-8000-00000000ee01";
const CONVERSATION = "c1000000-0000-4000-8000-00000000ee01";

run("a run that throws past its steps' handlers", () => {
  setDefaultTimeout(90_000);
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  let sql: postgres.Sql | undefined;
  afterAll(async () => {
    worker?.kill(9);
    await sql?.end();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("ends its report in error", async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    await migrate(url, { appEnv: "test" });
    await installQueueSchema(url);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into project (id, name, language, is_conversation_allowed, created_at, updated_at)
      values (${PROJECT}, 'Ended', 'en', true, now(), now())`;
    await sql`insert into conversation (id, project_id, participant_name, summary, created_at, updated_at)
      values (${CONVERSATION}, ${PROJECT}, 'Resident', 'Residents want later buses.', now(), now())`;
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, created_at, updated_at)
      values ('c2000000-0000-4000-8000-00000000ee01', ${CONVERSATION}, now(), 'The buses stop at eleven.', now(), now())`;
    const [r] =
      await sql`insert into project_report (project_id, status, language, kind, content, date_created)
      values (${PROJECT}, 'draft', 'en', 'report', '', now()) returning id::int`;
    const id = r?.id as number;
    writeFileSync(trace, "");
    worker = Bun.spawn(["bun", fixture], {
      env: {
        ...process.env,
        QUEUE_URL: url,
        TRACE_FILE: trace,
        EXECUTOR: "worker-a",
        PROJECT_ID: PROJECT,
        REPORT_ID: String(id),
        START: "1",
        THROW: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const report = async () =>
      (
        await (sql as postgres.Sql)`select status, error_code from project_report where id = ${id}`
      )[0];
    const end = Date.now() + 45_000;
    while ((await report())?.status === "draft" && Date.now() < end) await Bun.sleep(200);
    expect(await report()).toEqual({ status: "error", error_code: "GENERATION_DID_NOT_FINISH" });
  });
});
