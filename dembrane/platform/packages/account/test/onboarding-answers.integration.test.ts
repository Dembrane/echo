import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Notifier } from "@dembrane/notifications";
import { Hono } from "hono";
import { type AccountApiDeps, accountRoutes } from "../src/routes";

// The About you answers: the open "problem to solve" answer (q4) is stored cleaned and
// told to staff, next to the flagged follow-up, and neither notice can fail the save.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `account_onboarding_answers_${process.pid}`;

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const POLICY = n("b0", 1);
const INBOX = "training@dembrane.test";
const VERSION = "26-nov-26";

type Person = { directus: string; app: string; email: string; name: string | null };
const person = (k: number, local: string, name: string | null): Person => ({
  directus: n("d1", k),
  app: n("a1", k),
  email: `${local}@example.com`,
  name,
});
const P = {
  nina: person(1, "nina", "Nina"),
  // No display name: the notice names her by email.
  olga: person(2, "olga", null),
  staffA: person(3, "staff-a", "Staff A"),
  staffB: person(4, "staff-b", "Staff B"),
};
const STAFF = [P.staffA, P.staffB];

type Mail = { to: string; subject: string; template: string; data: { text?: string } };

run("onboarding answers and the problem to solve", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: ReturnType<typeof connect>;
  let app: Hono<Env>;
  const mails: Mail[] = [];
  let notifierDown = false;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = connect(url, { max: 2, onnotice: () => {} });

    for (const p of Object.values(P)) {
      await sql`insert into directus_users (id, email) values (${p.directus}, ${p.email})`;
      await sql`insert into app_user (id, directus_user_id, email, display_name) values (${p.app}, ${p.directus}, ${p.email}, ${p.name})`;
    }
    // Staff are the app users holding an admin-access policy.
    await sql`insert into directus_policies (id, name, admin_access) values (${POLICY}, 'Test admin', true)`;
    let k = 0;
    for (const s of STAFF)
      await sql`insert into directus_access (id, "user", policy) values (${n("b1", ++k)}, ${s.directus}, ${POLICY})`;

    const real = new Notifier(database.db);
    const deps = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      auth: { api: {} },
      identity: {},
      notifier: {
        emit: (...args: Parameters<Notifier["emit"]>) => {
          if (notifierDown) throw new Error("notifier down");
          return real.emit(...args);
        },
        emitToAudience: (...args: Parameters<Notifier["emitToAudience"]>) => {
          if (notifierDown) throw new Error("notifier down");
          return real.emitToAudience(...args);
        },
      },
      limiter: { check: async () => {} },
      jobs: {
        enqueue: async (_def: unknown, p: Mail) => {
          mails.push(p);
          return "job";
        },
      },
      files: {},
      config: {
        account: { inviteHashSecret: "h".repeat(32), onboardingFollowupInbox: INBOX },
        http: { dashboardUrl: "http://dashboard.test" },
        files: { directusLocation: "local" },
      },
    } as unknown as AccountApiDeps;
    app = new Hono<Env>();
    app.use(async (c, next) => {
      const who = Object.values(P).find((p) => p.email === c.req.header("x-as"));
      if (who)
        c.set("principal", {
          appUserId: who.app,
          directusUserId: who.directus,
          isStaff: false,
        } satisfies Signed);
      await next();
    });
    app.route("/", accountRoutes(deps));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  beforeEach(async () => {
    mails.length = 0;
    notifierDown = false;
    await sql`delete from notification`;
  });

  const submit = async (as: Person, body: { data: unknown[]; skipped: boolean }) => {
    const res = await app.request("/api/v2/onboarding/answers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-as": as.email },
      body: JSON.stringify({ version: VERSION, ...body }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const stored = async (p: Person) => {
    const [row] = await sql`select onboarding_answer_json as j from app_user where id = ${p.app}`;
    const j = row?.j;
    return (typeof j === "string" ? JSON.parse(j) : j) as {
      version: string;
      data: Record<string, unknown>[];
      skipped: boolean;
    };
  };
  const notices = (code: string) =>
    sql<
      {
        audience_user_id: string;
        actor_user_id: string | null;
        title: string;
        message: string | null;
        action: string;
        severity: string;
      }[]
    >`select audience_user_id, actor_user_id, title, message, action, severity
      from notification where event_code = ${code} order by audience_user_id`;

  // Not flagged: internal use, no high-risk context, so no follow-up.
  const plain = [{ q2: "no" }, { q1: "internal" }];
  // Flagged: high-risk with a training answer.
  const flagged = [{ q2: "yes" }, { q3: "no" }, { q1: "internal" }];

  test("q4 is stored trimmed and cut at 5000 characters", async () => {
    const long = `  ${"x".repeat(6000)}  `;
    const r = await submit(P.nina, { data: [...plain, { q4: long }], skipped: false });
    expect(r.status).toBe(200);
    const want = [...plain, { q4: "x".repeat(5000) }];
    expect((await stored(P.nina)).data).toEqual(want);
    expect((r.json.onboarding_answer_json as { data: unknown }).data).toEqual(want);

    await submit(P.nina, { data: [...plain, { q4: "  Too many notes.  " }], skipped: false });
    expect((await stored(P.nina)).data).toEqual([...plain, { q4: "Too many notes." }]);
  });

  test("a blank or non-string q4 entry is dropped from what is stored", async () => {
    await submit(P.nina, { data: [...plain, { q4: "   " }], skipped: false });
    expect((await stored(P.nina)).data).toEqual(plain);
    await submit(P.nina, { data: [...plain, { q4: 42 }], skipped: false });
    expect((await stored(P.nina)).data).toEqual(plain);
  });

  test("each staff member gets one notice quoting the problem, named by display name", async () => {
    const r = await submit(P.nina, {
      data: [...plain, { q4: "  We lose what people say in workshops.  " }],
      skipped: false,
    });
    expect(r.status).toBe(200);
    const rows = await notices("ONBOARDING_PROBLEM_SHARED");
    expect(rows.map((x) => x.audience_user_id)).toEqual(STAFF.map((s) => s.app).sort());
    for (const row of rows)
      expect(row).toMatchObject({
        actor_user_id: P.nina.app,
        title: "Problem to solve: Nina",
        message: `${P.nina.email}: We lose what people say in workshops.`,
        action: "NONE",
        severity: "info",
      });
    // Not flagged: no follow-up notice and no mail.
    expect(await notices("ONBOARDING_FOLLOWUP")).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  test("without a display name the notice is titled with the email", async () => {
    await submit(P.olga, { data: [...plain, { q4: "Hearing residents" }], skipped: false });
    const rows = await notices("ONBOARDING_PROBLEM_SHARED");
    expect(rows).toHaveLength(STAFF.length);
    expect(rows[0]?.title).toBe(`Problem to solve: ${P.olga.email}`);
    expect(rows[0]?.message).toBe(`${P.olga.email}: Hearing residents`);
  });

  test("no problem notice when q4 is blank or missing, or the submit is skipped", async () => {
    await submit(P.nina, { data: [...plain, { q4: "  " }], skipped: false });
    await submit(P.nina, { data: plain, skipped: false });
    await submit(P.nina, { data: [], skipped: true });
    await submit(P.nina, { data: [...plain, { q4: "Skipped anyway" }], skipped: true });
    expect(await notices("ONBOARDING_PROBLEM_SHARED")).toHaveLength(0);
  });

  test("the flagged follow-up fires as before and its mail quotes the problem", async () => {
    await submit(P.nina, { data: [...flagged, { q4: " Consent in care homes " }], skipped: false });
    expect(await notices("ONBOARDING_FOLLOWUP")).toHaveLength(STAFF.length);
    expect(await notices("ONBOARDING_PROBLEM_SHARED")).toHaveLength(STAFF.length);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe(INBOX);
    expect(mails[0]?.data.text).toContain("- Problem they want to solve: Consent in care homes");
  });

  test("a flagged answer without a problem mails as before, with no problem line", async () => {
    await submit(P.nina, { data: flagged, skipped: false });
    expect(await notices("ONBOARDING_FOLLOWUP")).toHaveLength(STAFF.length);
    expect(await notices("ONBOARDING_PROBLEM_SHARED")).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.data.text).not.toContain("Problem they want to solve");
  });

  test("the same answer posted twice tells staff once; a changed answer tells them again", async () => {
    await sql`update app_user set onboarding_answer_json = null where id = ${P.olga.app}`;
    await submit(P.olga, { data: [...plain, { q4: "Hearing residents" }], skipped: false });
    // A retry, with different spacing: the cleaned answer is the same.
    await submit(P.olga, { data: [...plain, { q4: "  Hearing residents " }], skipped: false });
    expect(await notices("ONBOARDING_PROBLEM_SHARED")).toHaveLength(STAFF.length);

    await submit(P.olga, { data: [...plain, { q4: "Hearing young residents" }], skipped: false });
    const rows = await notices("ONBOARDING_PROBLEM_SHARED");
    expect(rows).toHaveLength(2 * STAFF.length);
    expect(rows.map((r) => r.message)).toContain(`${P.olga.email}: Hearing young residents`);
  });

  test("a multi-line answer is one line in the mail, and stored as typed", async () => {
    const answer = "First we lose notes.\n\nThen   the report\r\nis late.";
    await submit(P.nina, { data: [...flagged, { q4: answer }], skipped: false });
    expect(mails).toHaveLength(1);
    const text = mails[0]?.data.text ?? "";
    expect(text).toContain(
      "- Problem they want to solve: First we lose notes. Then   the report is late.\n",
    );
    expect((await stored(P.nina)).data.at(-1)).toEqual({ q4: answer });
  });

  test("a notifier that throws does not fail the save", async () => {
    notifierDown = true;
    const data = [...flagged, { q4: "Still saved" }];
    const r = await submit(P.nina, { data, skipped: false });
    expect(r.status).toBe(200);
    expect((await stored(P.nina)).data).toEqual(data);

    const r2 = await submit(P.olga, { data: [...plain, { q4: "Also saved" }], skipped: false });
    expect(r2.status).toBe(200);
    expect((await stored(P.olga)).data).toEqual([...plain, { q4: "Also saved" }]);
  });
});
