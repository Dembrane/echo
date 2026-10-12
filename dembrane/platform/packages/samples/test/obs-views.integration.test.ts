import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate, schema } from "@dembrane/db";
import postgres from "postgres";
import chat from "../fixtures/best-practices/chat.json";
import conversations from "../fixtures/best-practices/conversations.json";
import { BEST_PRACTICES_IDS, seedBestPractices } from "../src";

// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

// The dashboards read the obs views as use. A seeded copy is invented content the seed job
// writes into every workspace, so the views that count conversations, chunks and chats
// must show only what the workspace did itself.
run("the obs views and a sample project", () => {
  setDefaultTimeout(60_000);
  const name = `samples_obs_views_${process.pid}`;
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const owner = { userId: crypto.randomUUID(), appUserId: crypto.randomUUID() };
  const ws = crypto.randomUUID();
  const own = crypto.randomUUID();
  // One instant for every row, so each view answers with a single day and minute.
  const at = new Date().toISOString();

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${name} with (force)`);
    await a.unsafe(`create database ${name}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${name}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const email = "owner@example.test";
    await database.db.insert(schema.directus_users).values({ id: owner.userId, email });
    await database.db
      .insert(schema.app_user)
      .values({ id: owner.appUserId, directus_user_id: owner.userId, email });
    const org = crypto.randomUUID();
    const billing = crypto.randomUUID();
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id, created_by)
      values (${ws}, 'Default', ${org}, ${billing}, ${owner.appUserId})`;

    await seedBestPractices(database.db, owner, ws, new Date(at));
    // The fixture's dates are fixed and leave the views' windows as time passes. Dated now,
    // every seeded row is inside every window, whenever this test runs.
    const pid = BEST_PRACTICES_IDS.project(ws);
    await sql`update conversation set created_at = ${at} where project_id = ${pid}`;
    await sql`update conversation_chunk set "timestamp" = ${at}, created_at = ${at}
      where conversation_id in (select id from conversation where project_id = ${pid})`;

    // The workspace's own work: a one-minute recording in two chunks, and a chat with a question.
    const conv = crypto.randomUUID();
    const ownChat = crypto.randomUUID();
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed)
      values (${own}, 'Mine', ${ws}, true)`;
    await sql`insert into conversation (id, project_id, participant_name, source, duration, is_finished, created_at, updated_at)
      values (${conv}, ${own}, 'Mine', 'PORTAL_AUDIO', 60, true, ${at}, ${at})`;
    await sql`insert into conversation_chunk (id, conversation_id, transcript, source, "timestamp") values
      (${crypto.randomUUID()}, ${conv}, 'one', 'PORTAL_AUDIO', ${at}),
      (${crypto.randomUUID()}, ${conv}, 'two', 'PORTAL_AUDIO', ${at})`;
    await sql`insert into project_chat (id, project_id, name, date_created) values (${ownChat}, ${own}, 'Mine', ${at})`;
    await sql`insert into project_chat_message (id, project_chat_id, message_from, text, date_created)
      values (${crypto.randomUUID()}, ${ownChat}, 'user', 'my question', ${at})`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${name} with (force)`);
    await a.end();
  });

  test("the seeded rows sit inside the views' windows", async () => {
    const [n] = await sql`select
      (select count(*) from conversation where created_at >= now() - interval '7 days')::int as conversations,
      (select count(*) from conversation_chunk where "timestamp" >= now() - interval '7 days')::int as chunks,
      (select count(*) from project_chat where date_created >= now() - interval '7 days')::int as chats,
      (select count(*) from project_chat_message where date_created >= now() - interval '7 days')::int as messages`;
    expect({ ...n }).toEqual({
      conversations: conversations.length + 1,
      chunks: conversations.reduce((sum, c) => sum + c.chunks.length, 0) + 2,
      chats: 2,
      messages: chat.turns.length + 1,
    });
  });

  test("conversations and recorded seconds count the workspace's own only", async () => {
    const rows =
      await sql`select created, finished, seconds_recorded, projects, portal_audio, uploads
      from obs.day_conversations`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { created: 1, finished: 1, seconds_recorded: 60, projects: 1, portal_audio: 1, uploads: 0 },
    ]);
  });

  test("chunks count the workspace's own only, per day and per minute", async () => {
    const day = await sql`select chunks, conversations, portal_audio from obs.day_chunks`;
    expect(day.map((r) => ({ ...r }))).toEqual([{ chunks: 2, conversations: 1, portal_audio: 2 }]);
    const minute = await sql`select chunks, conversations from obs.minute_chunks`;
    expect(minute.map((r) => ({ ...r }))).toEqual([{ chunks: 2, conversations: 1 }]);
  });

  test("chats and messages count the workspace's own only", async () => {
    const rows =
      await sql`select chats_created, messages, user_messages, assistant_messages, active_chats
      from obs.day_chats`;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { chats_created: 1, messages: 1, user_messages: 1, assistant_messages: 0, active_chats: 1 },
    ]);
  });

  test("a question someone asks in the sample's chat is not counted either", async () => {
    await sql`insert into project_chat_message (id, project_chat_id, message_from, text, date_created)
      values (${crypto.randomUUID()}, ${BEST_PRACTICES_IDS.chat(ws)}, 'user', 'a follow-up', ${at})`;
    const [row] = await sql`select coalesce(sum(messages), 0)::int as messages from obs.day_chats`;
    expect(row?.messages).toBe(1);
  });
});
