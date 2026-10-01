import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DrizzleStaffAudit } from "@dembrane/access";
import { PlatformError } from "@dembrane/core";
import { createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import { notificationRoutes } from "../src";

// A scratch database per run: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `notif_staff_${process.pid}`;

const STAFF: Signed = {
  appUserId: null,
  directusUserId: "d0000000-0000-4000-8000-00000000aa01",
  isStaff: true,
};
const USER: Signed = {
  appUserId: null,
  directusUserId: "d0000000-0000-4000-8000-00000000aa02",
  isStaff: false,
};

run("staff announcements against Postgres", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let app: Hono<Env>;
  let as: Signed = STAFF;

  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    const db = database.db;
    await db
      .insert(schema.languages)
      .values([{ code: "en-US" }, { code: "nl-NL" }])
      .onConflictDoNothing();
    await db.insert(schema.directus_users).values([
      { id: STAFF.directusUserId, email: "staff@dembrane.com" },
      { id: USER.directusUserId, email: "user@example.com" },
    ]);
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", as);
      c.set("requestId", "req-1");
      await next();
    });
    app.route("/", notificationRoutes({ db, staffAudit: new DrizzleStaffAudit(db) }));
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

  const future = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const texts = [
    { languages_code: "en-US", title: "Select all is here", message: "One click.\n\nDone." },
    { languages_code: "nl-NL", title: "Alles selecteren", message: "Eén klik.\n\nKlaar." },
  ];

  test("a non-staff caller is refused and nothing is written", async () => {
    as = USER;
    const res = await call("POST", "/api/v2/admin/announcements", {
      expires_at: future,
      translations: texts,
    });
    expect(res.status).toBe(403);
    expect(await database.db.select().from(schema.announcement)).toHaveLength(0);
    as = STAFF;
  });

  test("staff publish: live in every user's inbox, audited, with the author", async () => {
    const res = await call("POST", "/api/v2/admin/announcements", {
      level: "info",
      expires_at: future,
      translations: texts,
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { id: string; expires_at: string };
    expect(out.expires_at).toBe(future.slice(0, 19));

    as = USER;
    const inbox = (await (await call("GET", "/api/v2/me/announcements")).json()) as {
      id: string;
      level: string;
      translations: { languages_code: string; title: string }[];
    }[];
    expect(inbox.map((a) => a.id)).toEqual([out.id]);
    expect(inbox[0]?.translations.map((t) => t.languages_code)).toEqual(["en-US", "nl-NL"]);
    as = STAFF;

    const [row] = await database.db
      .select()
      .from(schema.announcement)
      .where(eq(schema.announcement.id, out.id));
    expect(row?.user_created).toBe(STAFF.directusUserId);
    const audit = await database.db.select().from(schema.staff_audit_event);
    expect(audit.map((a) => [a.permission, a.action])).toEqual([
      ["staff:announcements", "announcement.publish"],
    ]);
  });

  test("moving expires_at into the past takes it down for users; staff still see it", async () => {
    const [row] = await database.db.select().from(schema.announcement);
    const id = row?.id as string;
    const res = await call("PATCH", `/api/v2/admin/announcements/${id}`, {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(res.status).toBe(200);
    as = USER;
    expect(await (await call("GET", "/api/v2/me/announcements")).json()).toEqual([]);
    as = STAFF;
    const all = (await (
      await call("GET", "/api/v2/me/announcements?include_expired=true")
    ).json()) as unknown[];
    expect(all).toHaveLength(1);
    const missing = await call(
      "PATCH",
      "/api/v2/admin/announcements/00000000-0000-4000-8000-000000000000",
      { expires_at: future },
    );
    expect(missing.status).toBe(404);
  });

  test("refused: no English, a duplicate language, an unknown language, a past expiry", async () => {
    const bad = [
      { expires_at: future, translations: [texts[1]] },
      { expires_at: future, translations: [texts[0], texts[0]] },
      { expires_at: future, translations: [{ ...texts[0], languages_code: "xx-XX" }] },
      { expires_at: "2020-01-01T00:00:00Z", translations: texts },
      { expires_at: "not a date", translations: texts },
    ];
    for (const body of bad)
      expect((await call("POST", "/api/v2/admin/announcements", body)).status).toBe(400);
    expect(await database.db.select().from(schema.announcement)).toHaveLength(1);
  });
});
