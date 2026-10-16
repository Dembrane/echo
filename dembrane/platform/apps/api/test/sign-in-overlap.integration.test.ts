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
const TABLET = "browser-tablet-0003";
const LAPTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

run("two browsers per account", () => {
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
    const from: Record<string, string> = device
      ? {
          [DEVICE_ID_HEADER]: device,
          "user-agent": device === LAPTOP ? LAPTOP_UA : PHONE_UA,
        }
      : {};
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
      devices: {
        id: string;
        browser: string | null;
        platform: string | null;
        lastActiveAt: string;
      }[];
    };

  const replace = async (headers: Record<string, string>, sessionId?: string) => {
    const selected = sessionId ?? (await others(headers)).devices[0]?.id;
    return (await (
      await post("/other-sessions/replace-device", { sessionId: selected }, headers)
    ).json()) as { replaced: number };
  };

  test("the first browser signs in straight away", async () => {
    await person("first@example.com");
    const laptop = await signIn("first@example.com", LAPTOP);
    expect(await others(laptop)).toEqual({ held: false, since: null, devices: [] });
    expect(await signedIn(laptop)).toBe(true);
    expect(overlaps).toHaveLength(0);
  });

  test("a second browser signs in without interrupting the first", async () => {
    const userId = await person("two@example.com");
    const laptop = await signIn("two@example.com", LAPTOP);
    const phone = await signIn("two@example.com", PHONE);
    expect(await others(phone)).toEqual({ held: false, since: null, devices: [] });
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(laptop)).toBe(true);
    expect(await replace(phone)).toEqual({ replaced: 0 });
    expect(
      await database.db
        .select()
        .from(schema.auth_sign_in_overlap)
        .where(eq(schema.auth_sign_in_overlap.userId, userId)),
    ).toHaveLength(0);
  });

  test("a third browser is held: it is nobody until the person goes ahead", async () => {
    const userId = await person("second@example.com");
    const laptop = await signIn("second@example.com", LAPTOP);
    const phone = await signIn("second@example.com", PHONE);
    const tablet = await signIn("second@example.com", TABLET);

    const state = await others(tablet);
    expect(state.held).toBe(true);
    expect(Number.isNaN(Date.parse(state.since as string))).toBe(false);
    expect(await signedIn(tablet)).toBe(false);
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(laptop)).toBe(true);

    const [row] = await database.db
      .select()
      .from(schema.auth_sign_in_overlap)
      .where(eq(schema.auth_sign_in_overlap.userId, userId));
    expect(row).toMatchObject({
      deviceId: TABLET,
      otherSessions: 2,
      otherDevices: 2,
      replacedAt: null,
    });
    expect(overlaps.at(-1)).toMatchObject({ userId, outcome: "held", otherSessions: 2 });
  });

  test("going ahead signs out only the chosen device and keeps a staff API key", async () => {
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
    expect((await others(phone)).held).toBe(false);
    const tablet = await signIn("replace@example.com", TABLET);
    expect((await others(tablet)).held).toBe(true);

    const choices = (await others(tablet)).devices;
    expect(choices).toHaveLength(2);
    expect(choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ browser: "Chrome", platform: "Windows" }),
        expect.objectContaining({ browser: "Safari", platform: "iPhone" }),
      ]),
    );
    expect(choices.every((device) => !Number.isNaN(Date.parse(device.lastActiveAt)))).toBe(true);
    const laptopId = choices.find((device) => device.platform === "Windows")?.id;
    expect(await replace(tablet, laptopId)).toEqual({ replaced: 1 });
    expect(await signedIn(tablet)).toBe(true);
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(laptop)).toBe(false);
    expect((await others(tablet)).held).toBe(false);

    const left = await database.db
      .select({ userAgent: schema.auth_session.userAgent, held: schema.auth_session.held })
      .from(schema.auth_session)
      .where(eq(schema.auth_session.userId, userId));
    expect(left).toHaveLength(3);
    expect(left.some((s) => s.userAgent?.startsWith("staff-api-key:"))).toBe(true);
    expect(left.every((s) => s.held === false)).toBe(true);

    const [row] = await database.db
      .select({ replacedAt: schema.auth_sign_in_overlap.replacedAt })
      .from(schema.auth_sign_in_overlap)
      .where(eq(schema.auth_sign_in_overlap.userId, userId));
    expect(row?.replacedAt).toBeInstanceOf(Date);
    expect(overlaps.at(-1)).toMatchObject({ userId, outcome: "replaced", otherSessions: 2 });
    // A second call has nothing left to replace.
    expect(await replace(tablet)).toEqual({ replaced: 0 });
  });

  test("the same browser signing in again is not held", async () => {
    await person("again@example.com");
    await signIn("again@example.com", LAPTOP);
    await signIn("again@example.com", PHONE);
    const again = await signIn("again@example.com", LAPTOP);
    expect((await others(again)).held).toBe(false);
    expect(await signedIn(again)).toBe(true);
  });

  test("multiple sessions on one device occupy only one slot", async () => {
    await person("sessions@example.com");
    await signIn("sessions@example.com", LAPTOP);
    await signIn("sessions@example.com", LAPTOP);
    const phone = await signIn("sessions@example.com", PHONE);
    expect((await others(phone)).held).toBe(false);
    expect(await signedIn(phone)).toBe(true);
    const tablet = await signIn("sessions@example.com", TABLET);
    expect((await others(tablet)).held).toBe(true);
    expect(await signedIn(tablet)).toBe(false);
  });

  test("concurrent sign-ins cannot activate more than two devices", async () => {
    await person("concurrent@example.com");
    const browsers = await Promise.all(
      [LAPTOP, PHONE, TABLET].map((device) => signIn("concurrent@example.com", device)),
    );
    const active = await Promise.all(browsers.map(signedIn));
    expect(active.filter(Boolean)).toHaveLength(2);
    const states = await Promise.all(browsers.map(others));
    expect(states.filter((state) => state.held)).toHaveLength(1);
  });

  test("a client that names no browser is never held", async () => {
    await person("script@example.com");
    await signIn("script@example.com", LAPTOP);
    const script = await signIn("script@example.com", null);
    expect(await signedIn(script)).toBe(true);
  });

  test("a sign-in by emailed code allows two browsers and holds the third", async () => {
    await person("code@example.com");
    await signIn("code@example.com", LAPTOP);
    await auth.api.sendVerificationOTP({ body: { email: "code@example.com", type: "sign-in" } });
    const phone = await signIn("code@example.com", PHONE, codes.get("code@example.com"));
    expect((await others(phone)).held).toBe(false);
    expect(await signedIn(phone)).toBe(true);
    await auth.api.sendVerificationOTP({ body: { email: "code@example.com", type: "sign-in" } });
    const tablet = await signIn("code@example.com", TABLET, codes.get("code@example.com"));
    expect((await others(tablet)).held).toBe(true);
    expect(await signedIn(tablet)).toBe(false);
    await replace(tablet);
    expect(await signedIn(tablet)).toBe(true);
  });

  test("a device must be selected, and the old replace-all endpoint cannot sign devices out", async () => {
    await person("explicit@example.com");
    const laptop = await signIn("explicit@example.com", LAPTOP);
    const phone = await signIn("explicit@example.com", PHONE);
    const tablet = await signIn("explicit@example.com", TABLET);
    expect((await post("/other-sessions/replace-device", {}, tablet)).status).toBe(400);
    expect((await post("/other-sessions/replace", {}, tablet)).status).toBe(404);
    expect(await signedIn(laptop)).toBe(true);
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(tablet)).toBe(false);
  });

  test("all sessions of the selected device are revoked, while the other device stays signed in", async () => {
    await person("group@example.com");
    const laptop = await signIn("group@example.com", LAPTOP);
    const anotherLaptop = await signIn("group@example.com", LAPTOP);
    const phone = await signIn("group@example.com", PHONE);
    const tablet = await signIn("group@example.com", TABLET);
    const choices = (await others(tablet)).devices;
    expect(choices).toHaveLength(2);
    const id = choices.find((device) => device.platform === "Windows")?.id;
    expect(await replace(tablet, id)).toEqual({ replaced: 2 });
    expect(await signedIn(laptop)).toBe(false);
    expect(await signedIn(anotherLaptop)).toBe(false);
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(tablet)).toBe(true);
  });

  test("cancelling the held sign-in keeps both existing devices", async () => {
    await person("cancel@example.com");
    const laptop = await signIn("cancel@example.com", LAPTOP);
    const phone = await signIn("cancel@example.com", PHONE);
    const tablet = await signIn("cancel@example.com", TABLET);
    expect((await post("/sign-out", {}, tablet)).status).toBe(200);
    expect(await signedIn(laptop)).toBe(true);
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(tablet)).toBe(false);
  });

  test("another user's session, a staff key and a held session cannot be selected", async () => {
    const userId = await person("owner@example.com");
    const laptop = await signIn("owner@example.com", LAPTOP);
    const phone = await signIn("owner@example.com", PHONE);
    const tablet = await signIn("owner@example.com", TABLET);
    const staffId = newId();
    await database.db.insert(schema.auth_session).values({
      id: staffId,
      userId,
      token: `key-${newId()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      userAgent: "staff-api-key:sam",
    });
    const foreignUserId = await person("foreign@example.com");
    const foreign = await signIn("foreign@example.com", LAPTOP);
    const [foreignSession] = await database.db
      .select({ id: schema.auth_session.id })
      .from(schema.auth_session)
      .where(eq(schema.auth_session.userId, foreignUserId));
    const raw = await auth.api.getSession({ headers: new Headers(tablet) });
    for (const id of [foreignSession?.id, staffId, raw?.session.id, newId()]) {
      expect((await post("/other-sessions/replace-device", { sessionId: id }, tablet)).status).toBe(
        409,
      );
    }
    expect(await signedIn(laptop)).toBe(true);
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(foreign)).toBe(true);
    expect(await signedIn(tablet)).toBe(false);
    const choices = await others(tablet);
    expect(choices.devices).toHaveLength(2);
    expect(JSON.stringify(choices)).not.toContain('"token"');
    expect(JSON.stringify(choices)).not.toContain('"userAgent"');
    expect(
      choices.devices.some((device) => device.id === staffId || device.id === foreignSession?.id),
    ).toBe(false);
  });

  test("when a slot becomes free, continuing signs nobody else out", async () => {
    await person("free@example.com");
    const laptop = await signIn("free@example.com", LAPTOP);
    const phone = await signIn("free@example.com", PHONE);
    const tablet = await signIn("free@example.com", TABLET);
    const selected = (await others(tablet)).devices.find(
      (device) => device.platform === "Windows",
    )?.id;
    await post("/sign-out", {}, laptop);
    expect(await replace(tablet, selected)).toEqual({ replaced: 0 });
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(tablet)).toBe(true);
  });

  test("refreshing the device list completes a held sign-in when a slot is free", async () => {
    await person("refresh@example.com");
    const laptop = await signIn("refresh@example.com", LAPTOP);
    const phone = await signIn("refresh@example.com", PHONE);
    const tablet = await signIn("refresh@example.com", TABLET);
    await post("/sign-out", {}, laptop);
    expect(await others(tablet)).toEqual({ held: false, since: null, devices: [] });
    expect(await signedIn(tablet)).toBe(true);
    expect(await signedIn(phone)).toBe(true);
  });

  test("concurrent choices cannot admit a third active device or replace an unchosen device", async () => {
    await person("race@example.com");
    const laptop = await signIn("race@example.com", LAPTOP);
    const phone = await signIn("race@example.com", PHONE);
    const tablet = await signIn("race@example.com", TABLET);
    const fourth = await signIn("race@example.com", "browser-fourth-0004");
    const selected = (await others(tablet)).devices.find(
      (device) => device.platform === "Windows",
    )?.id;
    const responses = await Promise.all(
      [tablet, fourth].map((headers) =>
        post("/other-sessions/replace-device", { sessionId: selected }, headers),
      ),
    );
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(laptop)).toBe(false);
    const active = await Promise.all([tablet, fourth].map(signedIn));
    expect(active.filter(Boolean)).toHaveLength(1);
  });

  test("without a session there is nothing to ask or replace", async () => {
    const res = await auth.handler(new Request(`${API}/other-sessions`));
    expect(res.status).toBe(401);
    expect((await post("/other-sessions/replace-device", {}, {})).status).toBe(401);
  });
});
