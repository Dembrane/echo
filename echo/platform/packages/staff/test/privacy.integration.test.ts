import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { DrizzleStaffAudit } from "@dembrane/access";
import { PlatformError, unzip } from "@dembrane/core";
import { createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import { FilesystemStorage } from "@dembrane/storage";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import { AUTHOR_COLUMNS, GrantError, privacyRoutes, staffGrants } from "../src";

// A scratch database per run: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_privacy_${process.pid}`;

const n = (prefix: string, i: number) =>
  `${prefix}000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ROLE_ADMIN = n("e0", 1);
const ROLE_BASIC = n("e0", 2);
const STAFF = { id: n("d0", 1), app: n("a0", 1), email: "staff@dembrane.com" };
const ALICE = { id: n("d0", 2), app: n("a0", 2), email: "alice@example.com" };
const BOB = { id: n("d0", 3), app: n("a0", 3), email: "bob@example.com" };
const CAROL = { id: n("d0", 4), app: n("a0", 4), email: "carol@dembrane.com" };
const ORG_A = n("b0", 1);
const ORG_B = n("b0", 2);
const WS_A = n("c0", 1);
const WS_B = n("c0", 2);
const P_ALICE = n("f0", 1);
const P_BOB = n("f0", 2);
const C_OWN = n("c1", 1);
const C_PART = n("c1", 2);
const CHAT_PRIVATE = n("c3", 1);
const CHAT_SHARED = n("c3", 2);
const DOC = n("d1", 1);
const SIG = n("d2", 1);
const AVATAR = n("d3", 1);
const ANN = n("d4", 1);

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("data subject export and erasure against Postgres", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let app: Hono<Env>;
  let files: FilesystemStorage;
  let as: Signed = { appUserId: STAFF.app, directusUserId: STAFF.id, isStaff: true };
  const db = () => database.db;

  const call = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    const root = mkdtempSync(join(tmpdir(), "privacy-"));
    files = new FilesystemStorage(join(root, "files"), "http://files.test");
    const audio = new FilesystemStorage(join(root, "audio"), "http://audio.test", "/_audio");
    await seed(db(), files, audio);

    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", as);
      c.set("requestId", "req-1");
      await next();
    });
    app.route(
      "/",
      privacyRoutes({
        db: db(),
        staffAudit: new DrizzleStaffAudit(db()),
        files,
        audio,
        audioKeyOf: (path) => path.replace("https://audio.test/bucket/", ""),
        logger,
      }),
    );
    app.onError((err, c) =>
      c.json({ detail: err.message }, (err instanceof PlatformError ? err.status : 500) as 400),
    );
  });

  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("the author columns list is every no-action reference to directus_users", async () => {
    const rows = await db().execute<{ t: string; c: string }>(sql`
      select c.conrelid::regclass::text as t, a.attname as c
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'directus_users'::regclass
        and c.confdeltype in ('a', 'r') and c.conrelid <> 'directus_users'::regclass
      order by 1, 2`);
    const key = (t: string, c: string) => `${t}.${c}`;
    expect([...rows].map((r) => key(r.t, r.c)).sort()).toEqual(
      AUTHOR_COLUMNS.map(([t, c]) => key(t, c)).sort(),
    );
  });

  test("only staff: a non-staff caller learns nothing about the address", async () => {
    as = { appUserId: BOB.app, directusUserId: BOB.id, isStaff: false };
    expect((await call("/api/v2/admin/people/export", { email: ALICE.email })).status).toBe(403);
    expect((await call("/api/v2/admin/people/export", { email: "no@one.test" })).status).toBe(403);
    as = { appUserId: STAFF.app, directusUserId: STAFF.id, isStaff: true };
    expect((await call("/api/v2/admin/people/export", { email: "no@one.test" })).status).toBe(404);
  });

  test("export: one zip in the file bucket with every section, no secrets, audited by id", async () => {
    const res = await call("/api/v2/admin/people/export", { email: "Alice@Example.com" });
    expect(res.status).toBe(201);
    const out = (await res.json()) as {
      key: string;
      files: string[];
      counts: Record<string, number>;
      download_url: string;
    };
    expect(out.key).toStartWith(`exports/people/${ALICE.id}/`);
    expect(out.files).toEqual([
      "README.md",
      "manifest.json",
      "account.json",
      "memberships.json",
      "projects.json",
      "conversations.json",
      `transcripts/${C_OWN}.txt`,
      `transcripts/${C_PART}.txt`,
      "chats.json",
      "documents.json",
      `documents/${DOC}-signed.pdf`,
      "activity.json",
      "assistant.json",
      "invites.json",
    ]);
    const blob = await files.get(out.key);
    const entries = new Map(
      unzip(new Uint8Array(await (blob as Blob).arrayBuffer())).map((e) => [
        e.name,
        new TextDecoder().decode(e.data),
      ]),
    );
    const account = JSON.parse(entries.get("account.json") as string);
    expect(account.user.email).toBe(ALICE.email);
    expect(account.user.password).toBeUndefined();
    expect(account.user.tfa_secret).toBeUndefined();
    expect(JSON.stringify(account)).not.toContain("secret-session-token");
    const conversations = JSON.parse(entries.get("conversations.json") as string);
    expect(conversations.map((c: { id: string; relation: string }) => [c.id, c.relation])).toEqual([
      [C_OWN, "in_your_project"],
      [C_PART, "you_took_part"],
    ]);
    expect(conversations[0].merged_transcript).toBeUndefined();
    expect(conversations[0].audio_download_url).toContain("audio-conversations/own.mp3");
    expect(entries.get(`transcripts/${C_OWN}.txt`)).toBe("First words.\n\nSecond words.\n");
    const documents = JSON.parse(entries.get("documents.json") as string);
    expect(documents.signatures[0].typedName).toBe("Alice Owner");
    expect(documents.signatures[0].signedPdfKey).toBeUndefined();
    expect(entries.get(`documents/${DOC}-signed.pdf`)).toBe("%PDF-signed");
    const chats = JSON.parse(entries.get("chats.json") as string);
    expect(chats.map((c: { messages: unknown[] }) => c.messages.length)).toEqual([1, 1]);
    expect(out.counts.signatures).toBe(1);

    const [row] = await db()
      .select()
      .from(schema.staff_audit_event)
      .where(eq(schema.staff_audit_event.action, "person.export"));
    expect(row?.targetId).toBe(ALICE.id);
    expect(JSON.stringify(row?.detail)).not.toContain(ALICE.email);
  });

  test("erase: a dry run by default; refuses staff and the last admin of an organisation", async () => {
    const plan = (await (
      await call("/api/v2/admin/people/erase", { email: ALICE.email })
    ).json()) as { status: string; keeps: { signatures: number }; sole_admin_orgs: unknown[] };
    expect(plan.status).toBe("dry_run");
    expect(plan.keeps.signatures).toBe(1);
    expect(plan.sole_admin_orgs).toEqual([]);
    expect(
      await db().select().from(schema.auth_user).where(eq(schema.auth_user.id, ALICE.id)),
    ).toHaveLength(1);

    const staff = await call("/api/v2/admin/people/erase", {
      email: STAFF.email,
      dry_run: false,
      confirm_email: STAFF.email,
    });
    expect(staff.status).toBe(409);
    const bob = await call("/api/v2/admin/people/erase", {
      email: BOB.email,
      dry_run: false,
      confirm_email: BOB.email,
    });
    expect(bob.status).toBe(409);
    expect(((await bob.json()) as { detail: string }).detail).toContain("Org B");
    const unconfirmed = await call("/api/v2/admin/people/erase", {
      email: ALICE.email,
      dry_run: false,
    });
    expect(unconfirmed.status).toBe(400);
  });

  test("erase: the account goes; signatures, shared work and audit rows stay", async () => {
    const exportKey = (
      await db()
        .select({ detail: schema.staff_audit_event.detail })
        .from(schema.staff_audit_event)
        .where(eq(schema.staff_audit_event.action, "person.export"))
    )[0]?.detail as { key: string };
    const res = await call("/api/v2/admin/people/erase", {
      email: ALICE.email,
      dry_run: false,
      confirm_email: ALICE.email.toUpperCase(),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { files_deleted: number }).files_deleted).toBe(2);

    const count = async (q: string) =>
      Number(([...(await db().execute<{ n: number }>(sql.raw(q)))][0] as { n: number }).n);
    const gone = [
      `select count(*) n from directus_users where id = '${ALICE.id}'`,
      `select count(*) n from auth_user where id = '${ALICE.id}'`,
      `select count(*) n from auth_session where user_id = '${ALICE.id}'`,
      `select count(*) n from app_user where id = '${ALICE.app}'`,
      `select count(*) n from org_membership where user_id = '${ALICE.app}'`,
      `select count(*) n from project_chat where id = '${CHAT_PRIVATE}'`,
      `select count(*) n from agent_grant where app_user_id = '${ALICE.app}'`,
      `select count(*) n from agent_token`,
      `select count(*) n from announcement_activity where user_id = '${ALICE.id}'`,
      `select count(*) n from directus_files where id = '${AVATAR}'`,
      `select count(*) n from org_invite where email = '${ALICE.email}'`,
    ];
    for (const q of gone) expect([q, await count(q)]).toEqual([q, 0]);
    const kept = [
      `select count(*) n from account_signature where id = '${SIG}'`,
      `select count(*) n from account_document where id = '${DOC}'`,
      `select count(*) n from project_chat where id = '${CHAT_SHARED}' and user_created is null`,
      `select count(*) n from project where id = '${P_ALICE}' and directus_user_id is null`,
      `select count(*) n from conversation where id = '${C_PART}'`,
      `select count(*) n from announcement where id = '${ANN}' and user_created is null`,
      `select count(*) n from staff_audit_event where target_id = '${ALICE.id}'`,
    ];
    for (const q of kept) expect([q, (await count(q)) > 0]).toEqual([q, true]);
    expect(await files.exists(exportKey.key)).toBe(false);
    expect(await files.exists("avatar.png")).toBe(false);
    expect(await files.exists("signed/doc.pdf")).toBe(true);
  });

  test("staff grants: dembrane addresses only, audited, and revoke returns the signup role", async () => {
    const grants = staffGrants(db(), new DrizzleStaffAudit(db()));
    await expect(grants.grant(BOB.email, STAFF.email)).rejects.toBeInstanceOf(GrantError);
    await expect(grants.grant(CAROL.email, BOB.email)).rejects.toThrow("is not staff");
    expect(await grants.grant(CAROL.email, STAFF.email)).toEqual({
      changed: true,
      userId: CAROL.id,
    });
    expect(await grants.grant(CAROL.email, STAFF.email)).toEqual({
      changed: false,
      userId: CAROL.id,
    });
    expect((await grants.list()).staff.map((s) => s.email)).toEqual([CAROL.email, STAFF.email]);
    expect(await grants.revoke(CAROL.email, STAFF.email)).toEqual({
      changed: true,
      userId: CAROL.id,
    });
    const [carol] = await db()
      .select({ role: schema.directus_users.role })
      .from(schema.directus_users)
      .where(eq(schema.directus_users.id, CAROL.id));
    expect(carol?.role).toBe(ROLE_BASIC);
    await expect(grants.revoke(STAFF.email, STAFF.email)).rejects.toThrow("themselves");
    const trail = await db()
      .select({ action: schema.staff_audit_event.action })
      .from(schema.staff_audit_event)
      .where(eq(schema.staff_audit_event.permission, "staff:grant"));
    expect(trail.map((t) => t.action)).toEqual(["staff.grant", "staff.revoke"]);
  });
});

async function seed(
  db: ReturnType<typeof createDb>["db"],
  files: FilesystemStorage,
  audio: FilesystemStorage,
) {
  const s = schema;
  const now = new Date();
  await db.insert(s.directus_roles).values([
    { id: ROLE_ADMIN, name: "Administrator" },
    { id: ROLE_BASIC, name: "Basic User" },
  ]);
  await db.insert(s.directus_settings).values({ public_registration_role: ROLE_BASIC });
  await db.insert(s.directus_files).values({
    id: AVATAR,
    storage: "s3",
    filename_disk: "avatar.png",
    filename_download: "me.png",
    uploaded_by: null,
  });
  await files.put("avatar.png", "png", "image/png");
  await files.put("signed/doc.pdf", "%PDF-signed", "application/pdf");
  await audio.put("audio-conversations/own.mp3", "mp3", "audio/mpeg");
  await db.insert(s.directus_users).values([
    { id: STAFF.id, email: STAFF.email, role: ROLE_ADMIN },
    {
      id: ALICE.id,
      email: ALICE.email,
      first_name: "Alice",
      role: ROLE_BASIC,
      password: "$argon2-secret",
      tfa_secret: "totp-secret",
      avatar: AVATAR,
    },
    { id: BOB.id, email: BOB.email, role: ROLE_BASIC },
    { id: CAROL.id, email: CAROL.email, role: ROLE_BASIC },
  ]);
  await db
    .update(s.directus_files)
    .set({ uploaded_by: ALICE.id })
    .where(eq(s.directus_files.id, AVATAR));
  await db.insert(s.auth_user).values([
    { id: ALICE.id, name: "Alice", email: ALICE.email },
    { id: BOB.id, name: "Bob", email: BOB.email },
  ]);
  await db.insert(s.auth_session).values({
    id: n("a1", 1),
    userId: ALICE.id,
    token: "secret-session-token",
    expiresAt: new Date(now.getTime() + 86_400_000),
    ipAddress: "192.0.2.1",
  });
  await db.insert(s.app_user).values([
    { id: STAFF.app, directus_user_id: STAFF.id, email: STAFF.email },
    { id: ALICE.app, directus_user_id: ALICE.id, email: ALICE.email, display_name: "Alice" },
    { id: BOB.app, directus_user_id: BOB.id, email: BOB.email },
    { id: CAROL.app, directus_user_id: CAROL.id, email: CAROL.email },
  ]);
  await db.insert(s.org).values([
    { id: ORG_A, name: "Org A" },
    { id: ORG_B, name: "Org B" },
  ]);
  await db.insert(s.org_membership).values([
    { id: n("b1", 1), org_id: ORG_A, user_id: ALICE.app, role: "owner" },
    { id: n("b1", 2), org_id: ORG_A, user_id: CAROL.app, role: "admin" },
    { id: n("b1", 3), org_id: ORG_B, user_id: BOB.app, role: "owner" },
  ]);
  await db.insert(s.billing_account).values([{ id: n("ba", 1) }, { id: n("ba", 2) }]);
  await db.insert(s.workspace).values([
    { id: WS_A, org_id: ORG_A, billing_account_id: n("ba", 1), name: "A" },
    { id: WS_B, org_id: ORG_B, billing_account_id: n("ba", 2), name: "B" },
  ]);
  await db.insert(s.workspace_membership).values({
    id: n("b2", 1),
    workspace_id: WS_A,
    user_id: ALICE.app,
    role: "admin",
  });
  await db.insert(s.project).values([
    {
      id: P_ALICE,
      name: "Alice's listening",
      workspace_id: WS_A,
      directus_user_id: ALICE.id,
      is_conversation_allowed: true,
    },
    {
      id: P_BOB,
      name: "Bob's",
      workspace_id: WS_B,
      directus_user_id: BOB.id,
      is_conversation_allowed: true,
    },
  ]);
  await db.insert(s.conversation).values([
    {
      id: C_OWN,
      project_id: P_ALICE,
      participant_name: "Someone",
      merged_transcript: "First words. Second words.",
      merged_audio_path: "https://audio.test/bucket/audio-conversations/own.mp3",
      created_at: "2026-09-01T10:00:00Z",
    },
    {
      id: C_PART,
      project_id: P_BOB,
      participant_email: "ALICE@example.com",
      created_at: "2026-09-02T10:00:00Z",
    },
  ]);
  await db.insert(s.conversation_chunk).values([
    {
      id: n("c2", 2),
      conversation_id: C_OWN,
      timestamp: "2026-09-01T10:01:00Z",
      transcript: "Second words.",
    },
    {
      id: n("c2", 1),
      conversation_id: C_OWN,
      timestamp: "2026-09-01T10:00:00Z",
      transcript: "First words.",
    },
    {
      id: n("c2", 3),
      conversation_id: C_PART,
      timestamp: "2026-09-02T10:00:00Z",
      transcript: "Bob asked.",
    },
  ]);
  await db.insert(s.project_chat).values([
    {
      id: CHAT_PRIVATE,
      project_id: P_ALICE,
      user_created: ALICE.id,
      is_private: true,
      date_created: "2026-09-03T10:00:00Z",
    },
    {
      id: CHAT_SHARED,
      project_id: P_ALICE,
      user_created: ALICE.id,
      is_private: false,
      date_created: "2026-09-04T10:00:00Z",
    },
  ]);
  await db.insert(s.project_chat_message).values([
    { id: n("c4", 1), project_chat_id: CHAT_PRIVATE, message_from: "user", text: "mine" },
    { id: n("c4", 2), project_chat_id: CHAT_SHARED, message_from: "user", text: "ours" },
  ]);
  await db.insert(s.announcement).values({ id: ANN, level: "info", user_created: ALICE.id });
  await db.insert(s.announcement_activity).values({
    id: n("d5", 1),
    announcement_activity: ANN,
    user_id: ALICE.id,
    user_created: ALICE.id,
    read: true,
  });
  await db.insert(s.agent_client).values({ id: n("ac", 1), created_at: now.toISOString() });
  await db.insert(s.agent_grant).values({
    id: n("ad", 1),
    client_id: n("ac", 1),
    client_name: "Claude",
    app_user_id: ALICE.app,
    directus_user_id: ALICE.id,
    consent_accepted_at: now.toISOString(),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
  });
  await db.insert(s.agent_token).values({
    id: n("ae", 1),
    grant_id: n("ad", 1),
    pair_id: n("af", 1),
    kind: "access",
    token_hash: "hash",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
  });
  await db.insert(s.org_invite).values({
    id: n("b3", 1),
    org_id: ORG_B,
    email: ALICE.email,
    expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
  });
  await db.insert(s.account_document).values({
    id: DOC,
    orgId: ORG_A,
    kind: "offer",
    title: "Offer",
    body: "Offer text",
    status: "signed",
    requiresSignature: true,
  });
  await db.insert(s.account_signature).values({
    id: SIG,
    documentId: DOC,
    orgId: ORG_A,
    documentVersion: 1,
    signerUserId: ALICE.id,
    typedName: "Alice Owner",
    email: ALICE.email,
    organisation: "Org A",
    dpaAuthorised: true,
    sha256: "abc",
    fieldValues: {},
    method: "typed",
    imageKey: "signed/sig.png",
    imageSha256: "def",
    signedAt: now,
    confirmationText: "I agree",
    signedPdfKey: "signed/doc.pdf",
    signedPdfSha256: "ghi",
  });
}
