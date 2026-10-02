import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAuth, DEVICE_ID_HEADER, type Overlap } from "@dembrane/auth";
import { newId } from "@dembrane/core";
import { createDb, migrate, schema } from "@dembrane/db";
import { createLogger } from "@dembrane/observability";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { Deps, Env, Signed } from "../src/deps";
import { session } from "../src/middleware/session";

// A scratch database per run: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `sign_in_overlap_${process.pid}`;
const DASHBOARD = "http://localhost:5173";
const API = "http://localhost:8080/api/auth";
const PASSWORD = "a-long-enough-password";
const LAPTOP = "browser-laptop-0001";
const PHONE = "browser-phone-0002";

run("one browser per account", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let auth: ReturnType<typeof createAuth>;
  let app: Hono<Env>;
  const overlaps: Overlap[] = [];
  const codes = new Map<string, string>();

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    auth = createAuth({
      db: database.db,
      secret: "x".repeat(48),
      baseURL: "http://localhost:8080",
      trustedOrigins: [DASHBOARD],
      secureCookies: false,
      defaultDirectusRoleId: null,
      sendCode: async (email, code) => {
        codes.set(email, code);
      },
      onOverlap: (o) => overlaps.push(o),
    });
    // The API's session middleware in front of one route that says who is signed in.
    app = new Hono<Env>();
    app.use(
      session({
        auth,
        db: database.db,
        logger: createLogger({ level: "silent", service: "test", release: "test", env: "test" }),
        principalFor: async (userId: string) => ({ userId }) as unknown as Signed,
      } as unknown as Deps),
    );
    app.get("/who", (c) => c.json({ signedIn: c.get("principal") !== null }));
  });

  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const person = async (email: string) => {
    const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "A B" } });
    await database.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, res.user.id));
    return res.user.id;
  };

  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    auth.handler(
      new Request(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: DASHBOARD, ...headers },
        body: JSON.stringify(body),
      }),
    );

  /** Signs in as a browser would and returns the headers its later requests carry. */
  const signIn = async (email: string, device: string | null, code?: string) => {
    const from: Record<string, string> = device ? { [DEVICE_ID_HEADER]: device } : {};
    const res = code
      ? await post("/sign-in/email-otp", { email, otp: code }, from)
      : await post("/sign-in/email", { email, password: PASSWORD }, from);
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { cookie, origin: DASHBOARD, ...from };
  };

  const signedIn = async (headers: Record<string, string>) =>
    ((await (await app.request("/who", { headers })).json()) as { signedIn: boolean }).signedIn;

  const others = async (headers: Record<string, string>) =>
    (await (await auth.handler(new Request(`${API}/other-sessions`, { headers }))).json()) as {
      held: boolean;
      since: string | null;
    };

  const replace = async (headers: Record<string, string>) =>
    (await (await post("/other-sessions/replace", {}, headers)).json()) as { replaced: number };

  test("the first browser signs in straight away", async () => {
    await person("first@example.com");
    const laptop = await signIn("first@example.com", LAPTOP);
    expect(await others(laptop)).toEqual({ held: false, since: null });
    expect(await signedIn(laptop)).toBe(true);
    expect(overlaps).toHaveLength(0);
  });

  test("a second browser is held: it is nobody until the person goes ahead", async () => {
    const userId = await person("second@example.com");
    const laptop = await signIn("second@example.com", LAPTOP);
    const phone = await signIn("second@example.com", PHONE);

    const state = await others(phone);
    expect(state.held).toBe(true);
    expect(Number.isNaN(Date.parse(state.since as string))).toBe(false);
    expect(await signedIn(phone)).toBe(false);
    expect(await signedIn(laptop)).toBe(true);

    const [row] = await database.db
      .select()
      .from(schema.auth_sign_in_overlap)
      .where(eq(schema.auth_sign_in_overlap.userId, userId));
    expect(row).toMatchObject({
      deviceId: PHONE,
      otherSessions: 1,
      otherDevices: 1,
      replacedAt: null,
    });
    expect(overlaps.at(-1)).toMatchObject({ userId, outcome: "held", otherSessions: 1 });
  });

  test("going ahead signs the other browser out and keeps a staff API key", async () => {
    const userId = await person("replace@example.com");
    const laptop = await signIn("replace@example.com", LAPTOP);
    await database.db.insert(schema.auth_session).values({
      id: newId(),
      userId,
      token: `key-${newId()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      userAgent: "staff-api-key:sam|until=4102444800|scope=staff:accounts",
    });
    const phone = await signIn("replace@example.com", PHONE);
    expect((await others(phone)).held).toBe(true);

    expect(await replace(phone)).toEqual({ replaced: 1 });
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(laptop)).toBe(false);
    expect((await others(phone)).held).toBe(false);

    const left = await database.db
      .select({ userAgent: schema.auth_session.userAgent, held: schema.auth_session.held })
      .from(schema.auth_session)
      .where(eq(schema.auth_session.userId, userId));
    expect(left).toHaveLength(2);
    expect(left.some((s) => s.userAgent?.startsWith("staff-api-key:"))).toBe(true);
    expect(left.every((s) => s.held === false)).toBe(true);

    const [row] = await database.db
      .select({ replacedAt: schema.auth_sign_in_overlap.replacedAt })
      .from(schema.auth_sign_in_overlap)
      .where(eq(schema.auth_sign_in_overlap.userId, userId));
    expect(row?.replacedAt).toBeInstanceOf(Date);
    expect(overlaps.at(-1)).toMatchObject({ userId, outcome: "replaced", otherSessions: 1 });
    // A second call has nothing left to replace.
    expect(await replace(phone)).toEqual({ replaced: 0 });
  });

  test("the same browser signing in again is not held", async () => {
    await person("again@example.com");
    await signIn("again@example.com", LAPTOP);
    const again = await signIn("again@example.com", LAPTOP);
    expect((await others(again)).held).toBe(false);
    expect(await signedIn(again)).toBe(true);
  });

  test("a client that names no browser is never held", async () => {
    await person("script@example.com");
    await signIn("script@example.com", LAPTOP);
    const script = await signIn("script@example.com", null);
    expect(await signedIn(script)).toBe(true);
  });

  test("a sign-in by emailed code from a second browser is held too", async () => {
    await person("code@example.com");
    await signIn("code@example.com", LAPTOP);
    await auth.api.sendVerificationOTP({ body: { email: "code@example.com", type: "sign-in" } });
    const phone = await signIn("code@example.com", PHONE, codes.get("code@example.com"));
    expect((await others(phone)).held).toBe(true);
    expect(await signedIn(phone)).toBe(false);
    await replace(phone);
    expect(await signedIn(phone)).toBe(true);
  });

  test("without a session there is nothing to ask or replace", async () => {
    const res = await auth.handler(new Request(`${API}/other-sessions`));
    expect(res.status).toBe(401);
    expect((await post("/other-sessions/replace", {}, {})).status).toBe(401);
  });
});
