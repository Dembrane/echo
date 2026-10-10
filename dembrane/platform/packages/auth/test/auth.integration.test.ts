import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createDb, migrate, schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import { createAuth, syncIdentitiesFromDirectus } from "../src";

// Runs against a copy of the parity template, whose users were created and hashed by
// Directus: `legacy/parity/reset.sh auth_test`, then TEST_PARITY_DATABASE_URL and the passwords
// from legacy/parity/.env.parity.
const url = process.env.TEST_PARITY_DATABASE_URL;
const password = process.env.TEST_PARITY_USER_PASSWORD;
const run = url && password ? describe : describe.skip;

run("auth on Directus-created users", () => {
  const database = url ? createDb({ url, poolMax: 2 }) : (undefined as never);
  const codes: { email: string; code: string }[] = [];
  const auth = url
    ? createAuth({
        db: database.db,
        secret: "x".repeat(48),
        baseURL: "http://localhost:8080",
        trustedOrigins: ["http://localhost:5173"],
        secureCookies: false,
        defaultDirectusRoleId: null,
        sendCode: async (email, code) => {
          codes.push({ email, code });
        },
      })
    : (undefined as never);

  beforeAll(async () => {
    await migrate(url as string, { appEnv: "test" });
  });
  afterAll(() => database.close());

  test("identities sync from Directus once, and a second run changes nothing", async () => {
    const sql = connect(url as string, { max: 1, onnotice: () => {} });
    const first = await syncIdentitiesFromDirectus(sql);
    expect(first.users).toBeGreaterThanOrEqual(6);
    expect(first.accounts).toBeGreaterThanOrEqual(6);
    expect(await syncIdentitiesFromDirectus(sql)).toEqual({ users: 0, accounts: 0 });
    await sql.end();
  });

  test("a user of any status gets an identity: suspended stays out, unverified proves its email first", async () => {
    const sql = connect(url as string, { max: 1, onnotice: () => {} });
    const stamp = Date.now();
    const email = (status: string) => `${status}-${stamp}@example.com`;
    const statuses = ["suspended", "archived", "unverified", "invited"];
    // Each takes alice's hash, so the password is one Directus made.
    for (const status of statuses)
      await sql`
        insert into directus_users (id, email, status, password, provider)
        select gen_random_uuid(), ${email(status)}, ${status}, password, 'default'
        from directus_users where email = 'alice.parity@example.com'`;
    expect((await syncIdentitiesFromDirectus(sql)).users).toBe(statuses.length);
    const rows = await sql<{ email: string; email_verified: boolean }[]>`
      select email, email_verified from auth_user where email like ${`%-${stamp}@example.com`}`;
    await sql.end();
    const verified = Object.fromEntries(rows.map((r) => [r.email, r.email_verified]));
    expect(verified).toEqual({
      [email("suspended")]: true,
      [email("archived")]: true,
      [email("unverified")]: false,
      [email("invited")]: false,
    });
    for (const status of ["suspended", "archived"])
      await expect(
        auth.api.signInEmail({ body: { email: email(status), password: password as string } }),
      ).rejects.toThrow("This account is not active");
  });

  test("a password Directus hashed signs in, and the session belongs to the same user id", async () => {
    const res = await auth.api.signInEmail({
      body: { email: "alice.parity@example.com", password: password as string },
    });
    const [directusUser] = await database.db
      .select({ id: schema.directus_users.id })
      .from(schema.directus_users)
      .where(eq(schema.directus_users.email, "alice.parity@example.com"));
    expect(res.user.id).toBe(directusUser?.id as string);
    expect(res.token).toBeTruthy();
  });

  test("a wrong password is refused", async () => {
    await expect(
      auth.api.signInEmail({
        body: { email: "alice.parity@example.com", password: "wrong-password-123" },
      }),
    ).rejects.toThrow();
  });

  test("a new signup gets the directus_users row the schema points at, and no app_user until onboarding", async () => {
    const email = `new-${Date.now()}@example.com`;
    const res = await auth.api.signUpEmail({
      body: { email, password: "a-long-enough-password", name: "New Person" },
    });
    const [d] = await database.db
      .select()
      .from(schema.directus_users)
      .where(eq(schema.directus_users.id, res.user.id));
    const app = await database.db
      .select()
      .from(schema.app_user)
      .where(eq(schema.app_user.directus_user_id, res.user.id));
    expect(d?.email).toBe(email);
    expect(d?.first_name).toBe("New");
    expect(d?.status).toBe("unverified");
    expect(app).toHaveLength(0);
  });

  test("an email code is sent and signs the user in", async () => {
    await auth.api.sendVerificationOTP({
      body: { email: "bob.parity@example.com", type: "sign-in" },
    });
    const sent = codes.find((c) => c.email === "bob.parity@example.com");
    expect(sent?.code).toMatch(/^\d{6}$/);
    const res = await auth.api.signInEmailOTP({
      body: { email: "bob.parity@example.com", otp: sent?.code as string },
    });
    expect(res.user.email).toBe("bob.parity@example.com");
  });
});
