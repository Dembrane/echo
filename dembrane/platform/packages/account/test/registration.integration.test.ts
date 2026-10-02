import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAuth } from "@dembrane/auth";
import { connect, createDb, migrate, schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import type { InviteCtx } from "../src/invites/accept";
import { register } from "../src/registration";

// A scratch database per run: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `account_register_${process.pid}`;
const DASHBOARD = "http://localhost:5173";

run("registration", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let ctx: InviteCtx;
  const verifications: string[] = [];
  const queued: { to: string; template: string; data: Record<string, string> }[] = [];

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    const auth = createAuth({
      db: database.db,
      secret: "x".repeat(48),
      baseURL: "http://localhost:8080",
      trustedOrigins: [DASHBOARD],
      secureCookies: false,
      defaultDirectusRoleId: null,
      sendCode: async () => {},
      sendVerification: async (email) => {
        verifications.push(email);
      },
    });
    ctx = {
      deps: {
        db: database.db,
        auth,
        limiter: { check: async () => {} },
        jobs: {
          enqueue: async (_def: unknown, p: (typeof queued)[number]) => {
            queued.push(p);
            return "job";
          },
        },
        settings: { dashboardUrl: DASHBOARD },
      },
    } as unknown as InviteCtx;
  });

  afterAll(async () => {
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const signUp = (email: string) =>
    register(ctx, "127.0.0.1", {
      email,
      password: "a-long-enough-password",
      first_name: "Reg",
      last_name: null,
      verification_url: `${DASHBOARD}/verify-email`,
    });

  test("a new address gets a verification email", async () => {
    await signUp("new@example.com");
    expect(verifications).toEqual(["new@example.com"]);
    expect(queued).toHaveLength(0);
  });

  test("registering again before verifying sends a fresh verification email", async () => {
    await signUp("New@Example.com");
    expect(verifications).toEqual(["new@example.com", "new@example.com"]);
    expect(queued).toHaveLength(0);
  });

  test("a verified account gets the existing-account email, with a reset link to a real page", async () => {
    await database.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.email, "new@example.com"));
    await signUp("new@example.com");
    expect(verifications).toHaveLength(2);
    expect(queued.map((q) => q.template)).toEqual(["registration_existing_account"]);
    expect(queued[0]?.data.reset_url).toBe(
      `${DASHBOARD}/request-password-reset?email=new%40example.com`,
    );
  });
});
