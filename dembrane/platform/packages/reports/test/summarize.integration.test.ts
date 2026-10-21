import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { newId } from "@dembrane/core";
import { migrate } from "@dembrane/db";
import { FakeCompleter } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import postgres from "postgres";
import { summarizeConversation } from "../src/summarize";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const NAME = "reports_summarize_test";
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/${NAME}` : "";
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("report summaries and the retired hour lock", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${NAME} with (force)`);
    await a.unsafe(`create database ${NAME}`);
    await a.end();
    await migrate(url, { appEnv: "test" });
    sql = postgres(url, { max: 2, onnotice: () => {} });
  });
  afterAll(async () => {
    await sql?.end();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${NAME} with (force)`);
    await a.end();
  });

  test("a conversation stamped is_over_cap on a free workspace is summarised", async () => {
    const [org, billing, ws, proj, conv] = [newId(), newId(), newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed) values (${proj}, 'P', 'en', ${ws}, true)`;
    await sql`insert into conversation (id, project_id, participant_name, source, is_finished, is_over_cap, created_at, updated_at)
      values (${conv}, ${proj}, 'A', 'PORTAL_AUDIO', true, true, now(), now())`;
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, source)
      values (${newId()}, ${conv}, now(), 'we want buses', 'PORTAL_AUDIO')`;
    const completer = new FakeCompleter().on(() => true, "Residents want buses.");
    const s = summarizeConversation({ sql, completer, logger: quiet, now: () => new Date() });
    expect(await s.summarize(conv)).toBe("summarized");
    const [row] = await sql`select summary from conversation where id = ${conv}`;
    expect(row?.summary).toBe("Residents want buses.");
  });
});
