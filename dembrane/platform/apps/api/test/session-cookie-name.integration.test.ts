import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAuth } from "@dembrane/auth";
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
const dbName = `session_cookie_name_${process.pid}`;
const PASSWORD = "a-long-enough-password";
const EMAIL = "two-environments@example.com";

// Two environments under one parent domain, each with its own secret. The first sets its
// cookie for the parent domain, so a browser sends it to the second one's hosts as well.
const WIDE = { api: "https://api.example.com", dashboard: "https://dashboard.example.com" };
const NARROW = {
  api: "https://api-12.preview.example.com",
  dashboard: "https://dashboard-12.preview.example.com",
};

run("sign-in cookies of two environments in one browser", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let wide: ReturnType<typeof createAuth>;
  let narrow: ReturnType<typeof createAuth>;
  let app: Hono<Env>;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    const shared = {
      db: database.db,
      secureCookies: true,
      defaultDirectusRoleId: null,
      sendCode: async () => {},
    };
    wide = createAuth({
      ...shared,
      secret: "w".repeat(48),
      baseURL: WIDE.api,
      trustedOrigins: [WIDE.dashboard],
      cookieDomain: "example.com",
    });
    narrow = createAuth({
      ...shared,
      secret: "n".repeat(48),
      baseURL: NARROW.api,
      trustedOrigins: [NARROW.dashboard],
      cookiePrefix: "dembrane-preview",
    });
    // The second environment's session middleware in front of one route.
    app = new Hono<Env>();
    app.use(
      session({
        auth: narrow,
        db: database.db,
        logger: createLogger({ level: "silent", service: "test", release: "test", env: "test" }),
        principalFor: async (userId: string) => ({ userId }) as unknown as Signed,
      } as unknown as Deps),
    );
    app.get("/who", (c) => c.json({ signedIn: c.get("principal") !== null }));

    const res = await narrow.api.signUpEmail({
      body: { email: EMAIL, password: PASSWORD, name: "A B" },
    });
    await database.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, res.user.id));
  });

  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  /** Signs in and returns the session cookie as a browser sends it back: `name=value`. */
  const signIn = async (auth: ReturnType<typeof createAuth>, env: typeof WIDE) => {
    const res = await auth.handler(
      new Request(`${env.api}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: env.dashboard },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] as string)
      .find((c) => c.includes(".session_token=")) as string;
  };

  const signedIn = async (cookie: string) =>
    ((await (await app.request("/who", { headers: { cookie } })).json()) as { signedIn: boolean })
      .signedIn;

  test("each environment names its own cookie", async () => {
    expect((await signIn(wide, WIDE)).split("=")[0]).toBe("__Secure-dembrane.session_token");
    expect((await signIn(narrow, NARROW)).split("=")[0]).toBe(
      "__Secure-dembrane-preview.session_token",
    );
  });

  test("a session holds whichever cookie the browser sends first", async () => {
    const other = await signIn(wide, WIDE);
    const own = await signIn(narrow, NARROW);
    expect(await signedIn(own)).toBe(true);
    expect(await signedIn(`${other}; ${own}`)).toBe(true);
    expect(await signedIn(`${own}; ${other}`)).toBe(true);
    expect(await signedIn(other)).toBe(false);
  });
});
