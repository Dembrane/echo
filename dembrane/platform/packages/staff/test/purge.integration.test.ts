import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { deletionRequestedOn, deletionRequestNote } from "@dembrane/auth";
import { createDb, migrate, schema } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { FilesystemStorage } from "@dembrane/storage";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { runAccountPurge } from "../src";

// A scratch database per run: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_purge_${process.pid}`;

const n = (prefix: string, i: number) =>
  `${prefix}000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const NOW = new Date("2026-11-04T09:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const ROLE_ADMIN = n("e0", 1);
const ROLE_BASIC = n("e0", 2);

/** One person: directus, auth and app rows, and their own org and workspace. */
const person = (i: number, email: string) => ({
  id: n("d0", i),
  app: n("a0", i),
  email,
  org: n("b0", i),
  ws: n("c0", i),
  billing: n("ba", i),
  project: n("f0", i),
  conv: n("c1", i),
  chunk: n("c2", i),
  report: BigInt(1000 + i),
  chat: n("c3", i),
});
/** Asked 40 days ago: purged. Also a member of Bob's shared workspace. */
const GONE = person(1, "gone@example.com");
/** Asked 10 days ago: kept until day 30. */
const RECENT = person(2, "recent@example.com");
/** Suspended by staff for another reason: never purged. */
const OTHER = person(3, "other@example.com");
/** Staff who asked: skipped until staff access is revoked by hand. */
const STAFF = person(4, "staff@dembrane.com");
/** Asked 40 days ago with a live subscription: skipped until it is cancelled. */
const PAYING = person(5, "paying@example.com");
/** Asked 40 days ago, paid once: content goes, billing records stay. */
const PAID = person(6, "paid@example.com");
/** Not asked: Bob owns the shared workspace GONE was in. */
const BOB = person(7, "bob@example.com");

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("purging accounts deleted in the app", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let audio: FilesystemStorage;
  let files: FilesystemStorage;
  const db = () => database.db;
  const purge = () =>
    runAccountPurge({
      db: db(),
      audio,
      audioKeyOf: (path) => path.replace("https://audio.test/bucket/", ""),
      files,
      logger,
      now: () => NOW,
    });

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    const root = mkdtempSync(join(tmpdir(), "purge-"));
    files = new FilesystemStorage(join(root, "files"), "http://files.test");
    audio = new FilesystemStorage(join(root, "audio"), "http://audio.test", "/_audio");
    await seed(db(), audio, files);
  });

  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const exists = async (table: "directus_users" | "workspace" | "org" | "project", id: string) => {
    const t = schema[table];
    return (await db().select({ id: t.id }).from(t).where(eq(t.id, id))).length === 1;
  };
  const conversationExists = async (id: string) =>
    (
      await db()
        .select({ id: schema.conversation.id })
        .from(schema.conversation)
        .where(eq(schema.conversation.id, id))
    ).length === 1;

  test("the note the app writes is the note the purge reads", () => {
    const note = deletionRequestNote(daysAgo(40));
    expect(note).toBe("deletion requested in-app on 2026-09-25, purge within 30 days");
    expect(deletionRequestedOn(note)?.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(
      deletionRequestedOn("deletion requested in-app on 2026-02-30, purge within 30 days"),
    ).toBe(null);
    expect(deletionRequestedOn("suspended by staff: abuse")).toBe(null);
    expect(deletionRequestedOn(null)).toBe(null);
  });

  test("first run: purges past day 30, skips staff and live subscriptions", async () => {
    expect(await purge()).toEqual({ purged: 2, skipped: 2, failed: 0 });
  });

  test("the purged person is gone: identity, sole org and workspace, content and audio", async () => {
    expect(await exists("directus_users", GONE.id)).toBe(false);
    const auth = await db()
      .select({ id: schema.auth_user.id })
      .from(schema.auth_user)
      .where(eq(schema.auth_user.id, GONE.id));
    expect(auth).toEqual([]);
    const app = await db()
      .select({ id: schema.app_user.id })
      .from(schema.app_user)
      .where(eq(schema.app_user.id, GONE.app));
    expect(app).toEqual([]);
    const sessions = await db()
      .select({ id: schema.auth_session.id })
      .from(schema.auth_session)
      .where(eq(schema.auth_session.userId, GONE.id));
    expect(sessions).toEqual([]);
    expect(await exists("workspace", GONE.ws)).toBe(false);
    expect(await exists("org", GONE.org)).toBe(false);
    expect(await exists("project", GONE.project)).toBe(false);
    expect(await conversationExists(GONE.conv)).toBe(false);
    const chunks = await db()
      .select({ id: schema.conversation_chunk.id })
      .from(schema.conversation_chunk)
      .where(eq(schema.conversation_chunk.conversation_id, GONE.conv));
    expect(chunks).toEqual([]);
    const reports = await db()
      .select({ id: schema.project_report.id })
      .from(schema.project_report)
      .where(eq(schema.project_report.id, GONE.report));
    expect(reports).toEqual([]);
    const chats = await db()
      .select({ id: schema.project_chat.id })
      .from(schema.project_chat)
      .where(eq(schema.project_chat.id, GONE.chat));
    expect(chats).toEqual([]);
    const billing = await db()
      .select({ id: schema.billing_account.id })
      .from(schema.billing_account)
      .where(eq(schema.billing_account.id, GONE.billing));
    expect(billing).toEqual([]);
    expect(await audio.get("gone/merged.mp3")).toBe(null);
    expect(await audio.get("gone/chunk-1.mp3")).toBe(null);
    expect(await files.get("gone-avatar.png")).toBe(null);
  });

  test("the shared workspace stays with its content; only the person leaves it", async () => {
    expect(await exists("workspace", BOB.ws)).toBe(true);
    expect(await exists("project", BOB.project)).toBe(true);
    expect(await conversationExists(BOB.conv)).toBe(true);
    expect(await audio.get("bob/merged.mp3")).not.toBe(null);
    const members = await db()
      .select({ user: schema.workspace_membership.user_id })
      .from(schema.workspace_membership)
      .where(eq(schema.workspace_membership.workspace_id, BOB.ws));
    expect(members.map((m) => m.user)).toEqual([BOB.app]);
    // The chat GONE started in Bob's project is the organisation's: it stays without an author.
    const [chat] = await db()
      .select({ by: schema.project_chat.user_created })
      .from(schema.project_chat)
      .where(eq(schema.project_chat.id, BOB.chat));
    expect(chat).toEqual({ by: null });
  });

  test("a paid workspace is emptied and marked deleted; its billing records stay", async () => {
    expect(await exists("directus_users", PAID.id)).toBe(false);
    expect(await exists("project", PAID.project)).toBe(false);
    expect(await conversationExists(PAID.conv)).toBe(false);
    const [ws] = await db()
      .select({ deleted: schema.workspace.deleted_at })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, PAID.ws));
    expect(ws?.deleted).not.toBe(null);
    const [billing] = await db()
      .select({ customer: schema.billing_account.mollie_customer_id })
      .from(schema.billing_account)
      .where(eq(schema.billing_account.id, PAID.billing));
    expect(billing).toEqual({ customer: "cst_paid" });
    expect(await exists("org", PAID.org)).toBe(true);
  });

  test("untouched: before day 30, other suspensions, staff, live subscriptions", async () => {
    for (const p of [RECENT, OTHER, STAFF, PAYING]) {
      expect(await exists("directus_users", p.id)).toBe(true);
      expect(await exists("workspace", p.ws)).toBe(true);
      expect(await exists("org", p.org)).toBe(true);
      expect(await exists("project", p.project)).toBe(true);
      expect(await conversationExists(p.conv)).toBe(true);
    }
    expect(await audio.get("recent/merged.mp3")).not.toBe(null);
  });

  test("a second run finds nothing new and changes nothing", async () => {
    const before = await db()
      .select({ id: schema.directus_users.id })
      .from(schema.directus_users)
      .orderBy(schema.directus_users.id);
    expect(await purge()).toEqual({ purged: 0, skipped: 2, failed: 0 });
    const after = await db()
      .select({ id: schema.directus_users.id })
      .from(schema.directus_users)
      .orderBy(schema.directus_users.id);
    expect(after).toEqual(before);
  });
});

async function seed(
  db: ReturnType<typeof createDb>["db"],
  audio: FilesystemStorage,
  files: FilesystemStorage,
) {
  const s = schema;
  await db.insert(s.directus_roles).values([
    { id: ROLE_ADMIN, name: "Administrator" },
    { id: ROLE_BASIC, name: "Basic User" },
  ]);
  const note = (d: number) => deletionRequestNote(daysAgo(d));
  const people: [ReturnType<typeof person>, string, string | null, string][] = [
    [GONE, "suspended", note(40), ROLE_BASIC],
    [RECENT, "suspended", note(10), ROLE_BASIC],
    [OTHER, "suspended", "suspended by staff: abuse report", ROLE_BASIC],
    [STAFF, "suspended", note(40), ROLE_ADMIN],
    [PAYING, "suspended", note(40), ROLE_BASIC],
    [PAID, "suspended", note(40), ROLE_BASIC],
    [BOB, "active", null, ROLE_BASIC],
  ];
  const AVATAR = n("d3", 1);
  await db.insert(s.directus_files).values({
    id: AVATAR,
    storage: "s3",
    filename_disk: "gone-avatar.png",
    filename_download: "me.png",
  });
  await files.put("gone-avatar.png", "png", "image/png");
  await db.insert(s.directus_users).values(
    people.map(([p, status, description, role]) => ({
      id: p.id,
      email: p.email,
      status,
      description,
      role,
      ...(p === GONE && { avatar: AVATAR }),
    })),
  );
  await db
    .insert(s.auth_user)
    .values(people.map(([p]) => ({ id: p.id, name: p.email, email: p.email })));
  await db.insert(s.auth_session).values({
    id: n("a1", 1),
    userId: GONE.id,
    token: "gone-session",
    expiresAt: new Date(NOW.getTime() + 86_400_000),
  });
  await db
    .insert(s.app_user)
    .values(people.map(([p]) => ({ id: p.app, directus_user_id: p.id, email: p.email })));
  await db.insert(s.org).values(people.map(([p]) => ({ id: p.org, name: `${p.email} org` })));
  await db.insert(s.org_membership).values(
    people.map(([p], i) => ({
      id: n("b1", i + 1),
      org_id: p.org,
      user_id: p.app,
      role: "owner",
    })),
  );
  await db.insert(s.billing_account).values(
    people.map(([p]) => ({
      id: p.billing,
      ...(p === PAYING && {
        payment_mode: "mollie",
        mollie_customer_id: "cst_paying",
        mollie_subscription_id: "sub_paying",
      }),
      ...(p === PAID && { mollie_customer_id: "cst_paid" }),
    })),
  );
  await db
    .insert(s.workspace)
    .values(
      people.map(([p]) => ({ id: p.ws, org_id: p.org, billing_account_id: p.billing, name: "WS" })),
    );
  await db.insert(s.workspace_membership).values([
    ...people.map(([p], i) => ({
      id: n("b2", i + 1),
      workspace_id: p.ws,
      user_id: p.app,
      role: "admin",
    })),
    { id: n("b2", 99), workspace_id: BOB.ws, user_id: GONE.app, role: "member" },
  ]);
  await db.insert(s.project).values(
    people.map(([p]) => ({
      id: p.project,
      name: "Listening",
      workspace_id: p.ws,
      directus_user_id: p.id,
      is_conversation_allowed: true,
    })),
  );
  const slug = (p: ReturnType<typeof person>) => p.email.split("@")[0] as string;
  for (const [p] of people) {
    await audio.put(`${slug(p)}/merged.mp3`, "mp3", "audio/mpeg");
    await audio.put(`${slug(p)}/chunk-1.mp3`, "mp3", "audio/mpeg");
  }
  await db.insert(s.conversation).values(
    people.map(([p]) => ({
      id: p.conv,
      project_id: p.project,
      participant_name: "Someone",
      merged_transcript: "Words.",
      merged_audio_path: `https://audio.test/bucket/${slug(p)}/merged.mp3`,
    })),
  );
  await db.insert(s.conversation_chunk).values(
    people.map(([p]) => ({
      id: p.chunk,
      conversation_id: p.conv,
      timestamp: "2026-09-01T10:00:00Z",
      transcript: "Words.",
      path: `https://audio.test/bucket/${slug(p)}/chunk-1.mp3`,
    })),
  );
  await db
    .insert(s.project_report)
    .values(people.map(([p]) => ({ id: p.report, project_id: p.project, content: "<p>r</p>" })));
  await db.insert(s.project_chat).values(
    people.map(([p]) => ({
      id: p.chat,
      project_id: p.project,
      // The chat in Bob's project was started by GONE and shared with the workspace.
      user_created: p === BOB ? GONE.id : p.id,
      is_private: p !== BOB,
    })),
  );
}
