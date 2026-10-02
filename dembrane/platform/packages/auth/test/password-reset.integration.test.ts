import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate, schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { createAuth } from "../src";

// A scratch database per run: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `auth_reset_${process.pid}`;
const DASHBOARD = "http://localhost:5173";

run("password reset", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let auth: ReturnType<typeof createAuth>;
  const resets: { email: string; url: string; token: string }[] = [];

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
      sendResetPassword: async (email, url, token) => {
        resets.push({ email, url, token });
      },
    });
  });

  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const signUp = async (email: string, verified: boolean) => {
    const res = await auth.api.signUpEmail({
      body: { email, password: "old-password-123", name: "Reset Person" },
    });
    if (verified)
      await database.db
        .update(schema.auth_user)
        .set({ emailVerified: true })
        .where(eq(schema.auth_user.id, res.user.id));
    return res.user.id;
  };

  const resetLink = async (email: string) => {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: `${DASHBOARD}/password-reset` },
    });
    const sent = resets.findLast((r) => r.email === email);
    expect(sent).toBeDefined();
    return sent as { url: string; token: string };
  };

  const signsIn = (email: string, password: string) =>
    auth.api.signInEmail({ body: { email, password } }).then(
      () => true,
      () => false,
    );

  test("the emailed link lands on the dashboard page with the token", async () => {
    await signUp("link@example.com", true);
    const { url, token } = await resetLink("link@example.com");
    const res = await auth.handler(new Request(url));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${DASHBOARD}/password-reset?token=${token}`);
  });

  test("the new password signs in, the old one no longer does, and Directus has the hash", async () => {
    const id = await signUp("reset@example.com", true);
    const { token } = await resetLink("reset@example.com");
    await auth.api.resetPassword({ body: { token, newPassword: "new-password-456" } });
    expect(await signsIn("reset@example.com", "new-password-456")).toBe(true);
    expect(await signsIn("reset@example.com", "old-password-123")).toBe(false);
    const [acc] = await database.db
      .select({ hash: schema.auth_account.password })
      .from(schema.auth_account)
      .where(eq(schema.auth_account.userId, id));
    const [d] = await database.db
      .select({ hash: schema.directus_users.password })
      .from(schema.directus_users)
      .where(eq(schema.directus_users.id, id));
    expect(d?.hash).toBe(acc?.hash as string);
  });

  test("a reset from the inbox also verifies an unverified email", async () => {
    const id = await signUp("unverified@example.com", false);
    expect(await signsIn("unverified@example.com", "old-password-123")).toBe(false);
    const { token } = await resetLink("unverified@example.com");
    await auth.api.resetPassword({ body: { token, newPassword: "new-password-456" } });
    expect(await signsIn("unverified@example.com", "new-password-456")).toBe(true);
    const [d] = await database.db
      .select({ status: schema.directus_users.status })
      .from(schema.directus_users)
      .where(eq(schema.directus_users.id, id));
    expect(d?.status).toBe("active");
  });

  test("an unknown address gets no email and the same answer", async () => {
    const before = resets.length;
    const res = await auth.api.requestPasswordReset({
      body: { email: "nobody@example.com", redirectTo: `${DASHBOARD}/password-reset` },
    });
    expect(res.status).toBe(true);
    expect(resets.length).toBe(before);
  });
});
