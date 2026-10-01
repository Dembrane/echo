import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate, schema } from "@dembrane/db";
import { count, eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import chat from "../fixtures/millbrook/chat.json";
import conversations from "../fixtures/millbrook/conversations.json";
import { MILLBROOK, MILLBROOK_IDS, seedMillbrook } from "../src";

const conversationKeys = conversations.map((c) => c.key);
const chatKeys = chat.conversation_keys;

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

run("the Millbrook sample", () => {
  setDefaultTimeout(60_000);
  const name = `samples_millbrook_${process.pid}`;
  let database: ReturnType<typeof createDb>;
  const owner = { userId: crypto.randomUUID(), appUserId: crypto.randomUUID() };

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${name} with (force)`);
    await a.unsafe(`create database ${name}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${name}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    await database.db
      .insert(schema.directus_users)
      .values({ id: owner.userId, email: "owner@example.test" });
    await database.db
      .insert(schema.app_user)
      .values({ id: owner.appUserId, directus_user_id: owner.userId, email: "owner@example.test" });
  });
  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${name} with (force)`);
    await a.end();
  });

  async function counts() {
    const db = database.db;
    const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const conversationIds = (
      await db
        .select({ id: schema.conversation.id })
        .from(schema.conversation)
        .where(eq(schema.conversation.project_id, MILLBROOK_IDS.project))
    ).map((r) => r.id);
    return {
      orgs: await one(
        db.select({ n: count() }).from(schema.org).where(eq(schema.org.id, MILLBROOK_IDS.org)),
      ),
      workspaces: await one(
        db
          .select({ n: count() })
          .from(schema.workspace)
          .where(eq(schema.workspace.org_id, MILLBROOK_IDS.org)),
      ),
      projects: await one(
        db
          .select({ n: count() })
          .from(schema.project)
          .where(eq(schema.project.workspace_id, MILLBROOK_IDS.workspace)),
      ),
      conversations: conversationIds.length,
      chunks: await one(
        db
          .select({ n: count() })
          .from(schema.conversation_chunk)
          .where(inArray(schema.conversation_chunk.conversation_id, conversationIds)),
      ),
      reports: await one(
        db
          .select({ n: count() })
          .from(schema.project_report)
          .where(eq(schema.project_report.project_id, MILLBROOK_IDS.project)),
      ),
      chats: await one(
        db
          .select({ n: count() })
          .from(schema.project_chat)
          .where(eq(schema.project_chat.project_id, MILLBROOK_IDS.project)),
      ),
      messages: await one(
        db
          .select({ n: count() })
          .from(schema.project_chat_message)
          .where(eq(schema.project_chat_message.project_chat_id, MILLBROOK_IDS.chat)),
      ),
      chatConversations: await one(
        db
          .select({ n: count() })
          .from(schema.project_chat_conversation)
          .where(eq(schema.project_chat_conversation.project_chat_id, MILLBROOK_IDS.chat)),
      ),
      memberships: await one(
        db
          .select({ n: count() })
          .from(schema.workspace_membership)
          .where(eq(schema.workspace_membership.workspace_id, MILLBROOK_IDS.workspace)),
      ),
    };
  }

  test("seeds 25 conversations with transcripts, one report and one chat, and a rerun adds nothing", async () => {
    const started = performance.now();
    const first = await seedMillbrook(database.db, owner, new Date("2026-09-29T10:00:00Z"));
    expect(performance.now() - started).toBeLessThan(15_000);
    const after1 = await counts();
    expect(first.conversations).toBe(25);
    expect(MILLBROOK.conversations).toBe(25);
    expect(after1).toEqual({
      orgs: 1,
      workspaces: 1,
      projects: 1,
      conversations: 25,
      chunks: first.chunks,
      reports: 1,
      chats: 1,
      messages: MILLBROOK.chatMessages,
      chatConversations: after1.chatConversations,
      memberships: 1,
    });
    expect(first.chunks).toBeGreaterThan(25 * 20);
    expect(after1.chatConversations).toBe(chatKeys.length);

    const [org] = await database.db
      .select({ name: schema.org.name })
      .from(schema.org)
      .where(eq(schema.org.id, MILLBROOK_IDS.org));
    expect(org?.name).toBe("Acme Civic (sample)");

    // A reviewer's edits on a preview, and leftovers of an older fixture: a deleted
    // conversation, an extra chat turn, a chunk past the fixture's last and a chat link to a
    // conversation the chat does not quote.
    await database.db.insert(schema.conversation_chunk).values({
      id: crypto.randomUUID(),
      conversation_id: MILLBROOK_IDS.conversation("table-1"),
      transcript: "text from an older fixture",
      timestamp: "2026-07-02T09:00:00Z",
      created_at: "2026-07-02T09:00:00Z",
    });
    const unquoted = conversationKeys.find((k) => !chatKeys.includes(k)) as string;
    await database.db.insert(schema.project_chat_conversation).values({
      project_chat_id: MILLBROOK_IDS.chat,
      conversation_id: MILLBROOK_IDS.conversation(unquoted),
    });
    await database.db
      .update(schema.conversation)
      .set({ deleted_at: "2026-09-29T11:00:00Z" })
      .where(eq(schema.conversation.id, MILLBROOK_IDS.conversation("table-1")));
    await database.db.insert(schema.project_chat_message).values({
      id: crypto.randomUUID(),
      project_chat_id: MILLBROOK_IDS.chat,
      message_from: "user",
      text: "an extra turn",
    });

    const second = await seedMillbrook(database.db, owner, new Date("2026-09-30T10:00:00Z"));
    expect(second).toEqual(first);
    expect(await counts()).toEqual(after1);
    const [table1] = await database.db
      .select({ deleted_at: schema.conversation.deleted_at })
      .from(schema.conversation)
      .where(eq(schema.conversation.id, MILLBROOK_IDS.conversation("table-1")));
    expect(table1?.deleted_at).toBeNull();
  });

  test("every conversation has a transcript and a summary marked synthetic", async () => {
    const rows = await database.db
      .select({
        name: schema.conversation.participant_name,
        summary: schema.conversation.summary,
        transcript: schema.conversation.merged_transcript,
      })
      .from(schema.conversation)
      .where(eq(schema.conversation.project_id, MILLBROOK_IDS.project));
    expect(rows).toHaveLength(25);
    for (const r of rows) {
      expect(r.transcript?.length ?? 0).toBeGreaterThan(3000);
      expect(r.summary).toContain("Synthetic sample");
    }
  });
});
