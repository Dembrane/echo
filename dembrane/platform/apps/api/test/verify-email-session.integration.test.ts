import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAuth, DEVICE_ID_HEADER } from "@dembrane/auth";
import { createDb, migrate, schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";

// A scratch database per run: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `verify_email_session_${process.pid}`;
const DASHBOARD = "http://localhost:5173";
const API = "http://localhost:8080/api/auth";
const PASSWORD = "a-long-enough-password";

// The verify page calls verify-email whoever is signed in (VerifyEmail.tsx). That is only
// safe while the link leaves the browser's session alone: with Better Auth's
// autoSignInAfterVerification on, it would sign the browser in as the link's account.
run("a verification link opened where someone else is signed in", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let auth: ReturnType<typeof createAuth>;
  const tokens = new Map<string, string>();

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
      sendCode: async () => {},
      sendVerification: async (email, _url, token) => {
        tokens.set(email, token);
      },
    });
  });

  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const verified = async (email: string) =>
    (
      await database.db
        .select({ v: schema.auth_user.emailVerified })
        .from(schema.auth_user)
        .where(eq(schema.auth_user.email, email))
    )[0]?.v;

  test("verifies the link's address and keeps the session it was opened in", async () => {
    const mine = await auth.api.signUpEmail({
      body: { email: "signed-in@example.com", password: PASSWORD, name: "Signed In" },
    });
    await database.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, mine.user.id));
    const signIn = await auth.handler(
      new Request(`${API}/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: DASHBOARD,
          [DEVICE_ID_HEADER]: "browser-0001",
        },
        body: JSON.stringify({ email: "signed-in@example.com", password: PASSWORD }),
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const headers = { cookie, origin: DASHBOARD, [DEVICE_ID_HEADER]: "browser-0001" };

    await auth.api.signUpEmail({
      body: { email: "link-owner@example.com", password: PASSWORD, name: "Link Owner" },
    });
    const token = tokens.get("link-owner@example.com");
    expect(token).toBeTruthy();
    expect(await verified("link-owner@example.com")).toBe(false);

    const res = await auth.handler(
      new Request(`${API}/verify-email?token=${encodeURIComponent(token as string)}`, {
        headers,
      }),
    );
    expect(res.status).toBe(200);
    expect(await verified("link-owner@example.com")).toBe(true);
    // No new session cookie, and the browser is still the person who opened the link.
    expect(res.headers.getSetCookie().filter((c) => c.includes("session_token"))).toEqual([]);
    const session = await auth.api.getSession({ headers: new Headers(headers) });
    expect(session?.user.email).toBe("signed-in@example.com");
  });
});
