import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate, schema } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import postgres from "postgres";
import chat from "../fixtures/best-practices/chat.json";
import conversations from "../fixtures/best-practices/conversations.json";
import {
  BEST_PRACTICES_IDS,
  BEST_PRACTICES_VERSION,
  backfillBestPractices,
  runSeedJob,
  seedBestPractices,
} from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const chunkTotal = conversations.reduce((n, c) => n + c.chunks.length, 0);

run("the best-practices sample", () => {
  setDefaultTimeout(60_000);
  const name = `samples_best_practices_${process.pid}`;
  let database: ReturnType<typeof createDb>;
  const db = () => database.db;
  const T0 = new Date("2026-10-01T10:00:00Z");
  const owner = { userId: crypto.randomUUID(), appUserId: crypto.randomUUID() };
  const excludedOrg = crypto.randomUUID();

  async function user() {
    const u = { userId: crypto.randomUUID(), appUserId: crypto.randomUUID() };
    const email = `${u.userId}@example.test`;
    await db().insert(schema.directus_users).values({ id: u.userId, email });
    await db()
      .insert(schema.app_user)
      .values({ id: u.appUserId, directus_user_id: u.userId, email });
    return u;
  }

  /** A workspace in a free org of its own, created by `by` (null: no recorded creator). */
  async function workspace(
    by: { appUserId: string } | null,
    opts: { orgId?: string; deleted?: boolean; ownerMember?: { appUserId: string } } = {},
  ) {
    const orgId = opts.orgId ?? crypto.randomUUID();
    const billing = crypto.randomUUID();
    const id = crypto.randomUUID();
    await db().insert(schema.org).values({ id: orgId, name: "Org" }).onConflictDoNothing();
    await db().insert(schema.billing_account).values({ id: billing, org_id: orgId, tier: "free" });
    await db()
      .insert(schema.workspace)
      .values({
        id,
        org_id: orgId,
        billing_account_id: billing,
        name: "Default",
        created_by: by?.appUserId ?? null,
        deleted_at: opts.deleted ? T0.toISOString() : null,
      });
    const member = opts.ownerMember ?? by;
    if (member)
      await db().insert(schema.workspace_membership).values({
        id: crypto.randomUUID(),
        workspace_id: id,
        user_id: member.appUserId,
        role: "owner",
        source: "direct",
      });
    return id;
  }

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${name} with (force)`);
    await a.unsafe(`create database ${name}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${name}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    const email = "owner@example.test";
    await db().insert(schema.directus_users).values({ id: owner.userId, email });
    await db()
      .insert(schema.app_user)
      .values({ id: owner.appUserId, directus_user_id: owner.userId, email });
  });
  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${name} with (force)`);
    await a.end();
  });

  async function copyOf(workspaceId: string) {
    const pid = BEST_PRACTICES_IDS.project(workspaceId);
    const [p] = await db().select().from(schema.project).where(eq(schema.project.id, pid));
    const convs = await db()
      .select()
      .from(schema.conversation)
      .where(eq(schema.conversation.project_id, pid));
    const ids = convs.map((c) => c.id);
    const [chunks] = ids.length
      ? await db()
          .select({ n: count() })
          .from(schema.conversation_chunk)
          .where(inArray(schema.conversation_chunk.conversation_id, ids))
      : [{ n: 0 }];
    const chats = await db()
      .select()
      .from(schema.project_chat)
      .where(eq(schema.project_chat.project_id, pid));
    const messages = await db()
      .select()
      .from(schema.project_chat_message)
      .where(eq(schema.project_chat_message.project_chat_id, BEST_PRACTICES_IDS.chat(workspaceId)))
      .orderBy(schema.project_chat_message.date_created);
    const links = await db()
      .select()
      .from(schema.project_chat_conversation)
      .where(
        eq(schema.project_chat_conversation.project_chat_id, BEST_PRACTICES_IDS.chat(workspaceId)),
      );
    return { project: p, convs, chunks: chunks?.n ?? 0, chats, messages, links };
  }

  let ws1: string;

  test("seeds a closed sample project the workspace creator owns, with transcripts, summaries and a chat", async () => {
    ws1 = await workspace(owner);
    const out = await seedBestPractices(db(), owner, ws1, T0);
    expect(out).toEqual({
      status: "created",
      workspace_id: ws1,
      project_id: BEST_PRACTICES_IDS.project(ws1),
      conversations: conversations.length,
      chunks: chunkTotal,
      chat_id: BEST_PRACTICES_IDS.chat(ws1),
    });
    const c = await copyOf(ws1);
    expect(c.project).toMatchObject({
      name: "Best practices (sample)",
      workspace_id: ws1,
      directus_user_id: owner.userId,
      is_sample: true,
      sample_version: BEST_PRACTICES_VERSION,
      is_conversation_allowed: false,
      deleted_at: null,
    });
    expect(c.convs).toHaveLength(conversations.length);
    for (const conv of c.convs) {
      expect(conv.summary?.length ?? 0).toBeGreaterThan(50);
      expect(conv.merged_transcript?.length ?? 0).toBeGreaterThan(50);
      expect(conv).toMatchObject({ is_finished: true, is_all_chunks_transcribed: true });
      expect(conv.is_over_cap).toBe(false);
    }
    expect(c.chunks).toBe(chunkTotal);
    expect(c.chats).toHaveLength(1);
    expect(c.chats[0]).toMatchObject({ chat_mode: "deep_dive", user_created: owner.userId });
    expect(c.messages.map((m) => [m.message_from, m.text])).toEqual(
      chat.turns.map((t) => [t.from, t.text]),
    );
    expect(c.links.map((l) => l.conversation_id).sort()).toEqual(
      chat.conversation_keys.map((k) => BEST_PRACTICES_IDS.conversation(ws1, k)).sort(),
    );
  });

  test("a rerun with the same fixture writes nothing", async () => {
    const before = await copyOf(ws1);
    const out = await seedBestPractices(db(), owner, ws1, new Date("2026-10-02T10:00:00Z"));
    expect(out.status).toBe("current");
    expect(await copyOf(ws1)).toEqual(before);
  });

  test("a newer fixture rewrites the seeded content and leaves what the user made alone", async () => {
    const pid = BEST_PRACTICES_IDS.project(ws1);
    const conv = BEST_PRACTICES_IDS.conversation(ws1, conversations[0]?.key as string);
    // The user's own chat and report on the sample, and a follow-up in the seeded chat.
    const ownChat = crypto.randomUUID();
    await db().insert(schema.project_chat).values({ id: ownChat, project_id: pid, name: "Mine" });
    await db().insert(schema.project_chat_message).values({
      id: crypto.randomUUID(),
      project_chat_id: ownChat,
      message_from: "user",
      text: "my question",
    });
    const followUp = crypto.randomUUID();
    await db()
      .insert(schema.project_chat_message)
      .values({
        id: followUp,
        project_chat_id: BEST_PRACTICES_IDS.chat(ws1),
        message_from: "user",
        text: "a follow-up",
        date_created: "2026-10-03T10:00:00Z",
      });
    await db().insert(schema.project_report).values({
      project_id: pid,
      kind: "report",
      status: "published",
      content: "my report",
    });
    // What an older fixture left: other text, a missing chunk, a conversation it had.
    await db()
      .update(schema.conversation)
      .set({ summary: "an older summary" })
      .where(eq(schema.conversation.id, conv));
    await db()
      .delete(schema.conversation_chunk)
      .where(eq(schema.conversation_chunk.conversation_id, conv));
    const retired = crypto.randomUUID();
    await db().insert(schema.conversation).values({
      id: retired,
      project_id: pid,
      participant_name: "Retired",
      source: "DASHBOARD_UPLOAD",
    });
    await db()
      .update(schema.project)
      .set({ sample_version: "best-practices@0000000000000000", name: "Renamed by the user" })
      .where(eq(schema.project.id, pid));

    const out = await seedBestPractices(db(), owner, ws1, new Date("2026-10-04T10:00:00Z"));
    expect(out.status).toBe("updated");
    const c = await copyOf(ws1);
    expect(c.project?.sample_version).toBe(BEST_PRACTICES_VERSION);
    expect(c.project?.name).toBe("Renamed by the user");
    expect(c.convs.find((x) => x.id === conv)?.summary).toBe(conversations[0]?.summary as string);
    expect(c.chunks).toBe(chunkTotal);
    expect(c.convs.find((x) => x.id === retired)?.deleted_at).not.toBeNull();
    expect(c.chats.map((x) => x.id).sort()).toEqual([BEST_PRACTICES_IDS.chat(ws1), ownChat].sort());
    expect(c.messages.map((m) => m.text)).toEqual([
      ...chat.turns.map((t) => t.text),
      "a follow-up",
    ]);
    const [reports] = await db()
      .select({ n: count() })
      .from(schema.project_report)
      .where(
        and(eq(schema.project_report.project_id, pid), isNull(schema.project_report.deleted_at)),
      );
    expect(reports?.n).toBe(1);
  });

  test("a copy the user deleted is never resurrected, by a rerun or by the backfill", async () => {
    const pid = BEST_PRACTICES_IDS.project(ws1);
    await db()
      .update(schema.project)
      .set({ deleted_at: "2026-10-05T10:00:00Z" })
      .where(eq(schema.project.id, pid));
    expect((await seedBestPractices(db(), owner, ws1, T0)).status).toBe("deleted");
    await backfillBestPractices(db(), { now: T0 });
    const [p] = await db().select().from(schema.project).where(eq(schema.project.id, pid));
    expect(p?.deleted_at).not.toBeNull();
    const [n] = await db()
      .select({ n: count() })
      .from(schema.project)
      .where(and(eq(schema.project.workspace_id, ws1), eq(schema.project.is_sample, true)));
    expect(n?.n).toBe(1);
  });

  test("the backfill seeds every live workspace without a copy, in batches, and a rerun does nothing", async () => {
    const others = [await user(), await user(), await user()];
    const wanted = [];
    for (const u of others) wanted.push(await workspace(u));
    // No recorded creator: the workspace's owner gets the copy.
    const lateOwner = await user();
    wanted.push(await workspace(null, { ownerMember: lateOwner }));
    const excluded = await workspace(await user(), { orgId: excludedOrg });
    const deleted = await workspace(await user(), { deleted: true });
    const ownerless = await workspace(null);

    const first = await backfillBestPractices(db(), {
      now: T0,
      batchSize: 2,
      excludeOrgIds: [excludedOrg],
    });
    expect(first).toMatchObject({ created: wanted.length, updated: 0, failed: 0 });
    for (const w of wanted) expect((await copyOf(w)).project?.is_sample).toBe(true);
    expect((await copyOf(wanted[3] as string)).project?.directus_user_id).toBe(lateOwner.userId);
    for (const w of [excluded, deleted, ownerless])
      expect((await copyOf(w)).project).toBeUndefined();

    const second = await backfillBestPractices(db(), {
      now: T0,
      batchSize: 2,
      excludeOrgIds: [excludedOrg],
    });
    expect(second).toMatchObject({ created: 0, updated: 0, failed: 0 });
  });

  test("the backfill brings copies of an older fixture up to date, and only those", async () => {
    const u = await user();
    const ws = await workspace(u);
    await seedBestPractices(db(), u, ws, T0);
    await db()
      .update(schema.project)
      .set({ sample_version: "best-practices@0000000000000000" })
      .where(eq(schema.project.id, BEST_PRACTICES_IDS.project(ws)));
    const out = await backfillBestPractices(db(), { now: T0, excludeOrgIds: [excludedOrg] });
    expect(out).toMatchObject({ created: 0, updated: 1, failed: 0 });
    expect((await copyOf(ws)).project?.sample_version).toBe(BEST_PRACTICES_VERSION);
  });

  test("the seed job skips excluded organisations and workspaces without an owner", async () => {
    const logger = createLogger({ service: "test", release: "r", env: "test", level: "error" });
    const deps = { db: db(), logger, excludeOrgIds: [excludedOrg], now: () => T0 };
    const u = await user();
    const ws = await workspace(u);
    expect((await runSeedJob(deps, ws))?.status).toBe("created");
    expect(await runSeedJob(deps, await workspace(u, { orgId: excludedOrg }))).toBeNull();
    expect(await runSeedJob(deps, await workspace(null))).toBeNull();
    expect(await runSeedJob(deps, crypto.randomUUID())).toBeNull();
  });

  test("a deleted workspace gets no copy", async () => {
    const u = await user();
    const ws = await workspace(u, { deleted: true });
    expect((await seedBestPractices(db(), u, ws, T0)).status).toBe("workspace_deleted");
    expect((await copyOf(ws)).project).toBeUndefined();
  });
});
