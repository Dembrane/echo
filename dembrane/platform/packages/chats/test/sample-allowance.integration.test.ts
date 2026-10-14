import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { chatReads } from "../src/conversations";
import { chatsStorage } from "../src/storage";

// The free chat allowance counts chats with a user message. A sample copy's seeded chat
// has one, and so may chats the user starts on it: neither spends the allowance.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `chats_sample_allowance_${process.pid}`;

run("the free chat allowance and a sample project", () => {
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

  async function chatWithQuestion(projectId: string) {
    const id = crypto.randomUUID();
    await sql`insert into project_chat (id, project_id) values (${id}, ${projectId})`;
    await sql`insert into project_chat_message (id, project_chat_id, message_from, text)
      values (${crypto.randomUUID()}, ${id}, 'user', 'a question')`;
  }

  test("chats on the sample, seeded or the user's, spend none of it; the workspace's own do", async () => {
    const reads = chatReads(database.db);
    await chatWithQuestion(sample);
    await chatWithQuestion(sample);
    expect(await reads.workspaceChatsWithUserMessages(ws)).toBe(0);
    await chatWithQuestion(own);
    expect(await reads.workspaceChatsWithUserMessages(ws)).toBe(1);
  });

  test("the sample's own allowance counts user turns across its live chats", async () => {
    const store = chatsStorage(database.db);
    const before = await store.countProjectUserTurns(sample);
    await chatWithQuestion(sample);
    expect(await store.countProjectUserTurns(sample)).toBe(before + 1);
    await sql`update project_chat set deleted_at = now() where project_id = ${sample}`;
    expect(await store.countProjectUserTurns(sample)).toBe(0);
  });
});
