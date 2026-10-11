import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore, DrizzleStaffAudit, resolveProject } from "@dembrane/access";
import {
  type AccountsDeps,
  accountsRoutes,
  buildDemo,
  type DemoBuildDeps,
  demoBuildAccess,
  ensureUser,
  contract as K,
  MemoryJobs,
} from "@dembrane/accounts";
import { newId, PlatformError } from "@dembrane/core";
import { createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { FakeCompleter } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import { projectRoutes } from "@dembrane/projects";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { computeStats, statsStorage } from "@dembrane/stats";
import { FilesystemStorage } from "@dembrane/storage";
import { MemoryJobSink, tenancyRoutes } from "@dembrane/tenancy";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";

// A demo staff start where this deployment is production: it lands in an organisation of
// its own, next to a customer who records real conversations. The routes that report
// usage, the public numbers and the access rules are the real ones.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = `staff_demo_${process.pid}`;

const SITE = "https://www.harbourtown.example/";
const RESEARCH = {
  sector: "Municipality",
  summary: "A harbour town that plans a new waterfront.",
  facts: [{ text: "The town plans a new waterfront.", source_url: SITE }],
  unknowns: ["When the sessions take place."],
  invented_themes: [
    { title: "Housing", description: "Fiction: homes near the harbour." },
    { title: "Green space", description: "Fiction: trees on the quay." },
  ],
  scenario: "An invented evening in the library about the waterfront.",
};
const AUTHORED = {
  title: "What makes the waterfront yours?",
  subtitle: "An invented evening for Harbourtown.",
  disclosure: "Everything in here is invented: synthetic stories, not real outcomes.",
  invitation_title: "Listen to your people",
  invitation_text: "The real stories come from your residents.",
  notice: "Synthetic demo: invented perspectives.",
  conversations: [
    "resident",
    "shop owner",
    "youth worker",
    "volunteer",
    "student",
    "starter",
    "harbour worker",
    "older resident",
  ].map((role) => ({
    role,
    theme: "waterfront",
    lines: Array.from({ length: 20 }, (_, i) => ({
      speaker: i % 2 ? role : "Host",
      text: i % 2 ? `As a ${role} I see it differently, point ${i}.` : "What do you think?",
    })),
  })),
};

type Person = Signed & { email: string };

run("a staff demo where the deployment is production", () => {
  setDefaultTimeout(120_000);
  let database: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>["db"];
  let app: Hono<Env>;
  let deps: AccountsDeps;
  let build: DemoBuildDeps;
  let access: Access;
  const people = {} as Record<"staff" | "customer", Person>;
  const customer = { org: newId(), workspace: newId(), project: newId(), billing: newId() };
  let demo: K.DemoStatusT;
  let demoWorkspace = "";
  let demoProject = "";
  let contact: Person;
  let statsBefore: Awaited<ReturnType<typeof computeStats>>;

  const as = (who: Person | null) => ({
    ...(who && { "x-as": who.directusUserId }),
    "content-type": "application/json",
  });
  const get = async (who: Person | null, path: string) => {
    const res = await app.request(path, { headers: as(who) });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const stats = () => computeStats(statsStorage(db));
  /** One recorded conversation with audio, as the pipeline leaves it. */
  const record = async (projectId: string, seconds: number) => {
    const now = new Date().toISOString();
    await db.insert(schema.conversation).values({
      id: newId(),
      project_id: projectId,
      participant_name: "Participant",
      duration: seconds,
      created_at: now,
      updated_at: now,
    });
  };
  const realProject = async (id: string, workspaceId: string, owner: Person) => {
    const now = new Date().toISOString();
    await db.insert(schema.project).values({
      id,
      name: "Residents evening",
      workspace_id: workspaceId,
      directus_user_id: owner.directusUserId,
      is_conversation_allowed: true,
      created_at: now,
      updated_at: now,
    });
  };

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${DB}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    db = database.db;
    access = new Access(new DrizzleAccessStore(db));
    const logger = createLogger(
      { service: "t", release: "r", env: "test", level: "error" },
      new Writable({ write: (_c, _e, cb) => cb() }),
    );
    const nowIso = new Date().toISOString();
    const role = newId();
    await db.insert(schema.directus_roles).values({ id: role, name: "Administrator" });
    const byId = new Map<string, Person>();
    const person = async (email: string, name: string, directusRoleId?: string) => {
      const u = await db.transaction((tx) =>
        ensureUser(tx, {
          email,
          name,
          passwordHash: null,
          nowIso,
          ...(directusRoleId && { directusRoleId }),
        }),
      );
      const p: Person = {
        appUserId: u.appUserId,
        directusUserId: u.userId,
        isStaff: Boolean(directusRoleId),
        email,
      };
      byId.set(p.directusUserId, p);
      return p;
    };
    people.staff = await person("staff@dembrane.example", "Staff", role);
    people.customer = await person("pat@riverbend.example", "Pat Rivers");

    // A customer on the free plan with half an hour recorded.
    await db.insert(schema.org).values({ id: customer.org, name: "Riverbend Housing (sample)" });
    await db
      .insert(schema.billing_account)
      .values({ id: customer.billing, org_id: customer.org, tier: "free" });
    await db.insert(schema.org_membership).values({
      id: newId(),
      org_id: customer.org,
      user_id: people.customer.appUserId as string,
      role: "owner",
    });
    await db.insert(schema.workspace).values({
      id: customer.workspace,
      org_id: customer.org,
      name: "Riverbend",
      billing_account_id: customer.billing,
      visibility: "open_to_organisation",
    });
    await realProject(customer.project, customer.workspace, people.customer);
    await record(customer.project, 1800);

    const demoSettings = {
      portalUrl: "https://portal.dembrane.com",
      apiUrl: "https://api.dembrane.com",
      workspaceId: null,
      feedbackUrl: "https://portal.dembrane.com/en-US/feedback-project/start",
    };
    deps = {
      db,
      access,
      staffAudit: new DrizzleStaffAudit(db),
      jobs: new MemoryJobs(),
      files: new FilesystemStorage(mkdtempSync(join(tmpdir(), "staff-demo-")), "http://localhost"),
      logger,
      limiter: new RateLimiter(new MemoryRateCounter()),
      now: () => new Date(),
      fetchText: async (u) => {
        throw new Error(`no legal page in this test: ${u}`);
      },
      settings: {
        dashboardUrl: "https://dashboard.dembrane.com",
        company: {
          name: "dembrane B.V.",
          address: "Example street 1",
          vat: "NL000000000B01",
          kvk: "00000000",
          iban: "NL00 TEST 0000000000",
          bic: "TESTNL2U",
          accountName: "dembrane B.V.",
        },
        eventsEnabled: false,
        slackEnabled: false,
        samInbox: false,
        offerMessages: false,
        reminderIntervalDays: 7,
        inviteSecret: "x".repeat(32),
        demo: demoSettings,
      },
    };
    build = {
      ...deps,
      completer: new FakeCompleter()
        .on("You research an organisation", JSON.stringify(RESEARCH))
        .on("You write the fictional corpus", JSON.stringify(AUTHORED)),
      get: async (u) =>
        u === SITE
          ? {
              status: 200,
              url: u,
              contentType: "text/html",
              body: "<html><title>Harbourtown</title><body><p>The town plans a new waterfront.</p></body></html>",
            }
          : { status: 404, url: u, contentType: "text/html", body: "" },
      extract: async () => "ok",
      demo: demoSettings,
    };

    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("requestId", "req-test");
      c.set("principal", byId.get(c.req.header("x-as") ?? "") ?? null);
      await next();
    });
    app.route("/", accountsRoutes(deps));
    app.route(
      "/",
      tenancyRoutes({
        db,
        accessStore: new DrizzleAccessStore(db),
        jobs: new MemoryJobSink(),
        dashboardUrl: deps.settings.dashboardUrl,
        inviteSecret: deps.settings.inviteSecret,
      }),
    );
    app.route("/", projectRoutes({ db, access, queue: { enqueue: async () => null } }));
    // The API's handler, as apps/api/src/middleware/errors.ts has it.
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
    statsBefore = await stats();

    const res = await app.request("/api/v2/admin/accounts/demos", {
      method: "POST",
      headers: as(people.staff),
      body: JSON.stringify({
        organisation_name: "Harbourtown Council (sample)",
        website_url: SITE,
        brief: "Participation for the new waterfront.",
        language: "en",
        contact_name: "Robin Example",
        contact_email: "robin@harbourtown.example",
      }),
    });
    expect(res.status).toBe(201);
    const started = K.DemoStatus.parse(await res.json());
    await buildDemo(build, started.id, 1);
    demo = K.DemoStatus.parse(
      (await get(people.staff, `/api/v2/admin/accounts/demos/${started.id}`)).data,
    );
    const [row] = await db
      .select()
      .from(schema.account_demo)
      .where(eq(schema.account_demo.id, started.id));
    demoWorkspace = (row?.seed as { workspace_id: string } | undefined)?.workspace_id ?? "";
    demoProject = demo.links.projects[0]?.project_id as string;
    const [user] = await db
      .select()
      .from(schema.app_user)
      .where(eq(schema.app_user.email, "robin@harbourtown.example"));
    contact = {
      appUserId: user?.id as string,
      directusUserId: user?.directus_user_id as string,
      isStaff: false,
      email: "robin@harbourtown.example",
    };
    byId.set(contact.directusUserId, contact);
  });
  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.end();
  });

  const members = () =>
    db
      .select({ user: schema.org_membership.user_id, role: schema.org_membership.role })
      .from(schema.org_membership)
      .where(eq(schema.org_membership.org_id, demo.org_id as string));
  const signIn = async () =>
    (
      await db
        .select({ status: schema.directus_users.status })
        .from(schema.directus_users)
        .where(eq(schema.directus_users.id, contact.directusUserId))
    )[0]?.status;

  test("the demo is a draft in an organisation of its own, with no member until staff publish", async () => {
    expect(demo.status).toBe("draft");
    expect(demo.org_id).not.toBe(customer.org);
    const [workspace] = await db
      .select()
      .from(schema.workspace)
      .where(eq(schema.workspace.id, demoWorkspace));
    expect(workspace?.org_id).toBe(demo.org_id as string);
    expect(await members()).toEqual([]);
    // A new contact cannot sign in before staff publish, and no email was queued.
    expect(await signIn()).toBe("draft");
    expect((deps.jobs as MemoryJobs).of("account.send-email")).toEqual([]);
    await expect(access.project(contact, demoProject, "project:read")).rejects.toThrow();
    const theirs = (await get(contact, "/api/v2/workspaces")).data as {
      organisations: { id: string }[];
    };
    expect(theirs.organisations).toEqual([]);
  });

  test("the build's read reaches the demo project as its contact, and no other project", async () => {
    const who = { appUserId: contact.appUserId, directusUserId: contact.directusUserId };
    const build = demoBuildAccess(db);
    expect((await resolveProject(build, demoProject, who, new Date()))?.role).toBe("admin");
    expect(await resolveProject(build, customer.project, who, new Date())).toBeNull();
    // Only the demo's contact is counted, and only by the build's store.
    const other = {
      appUserId: people.customer.appUserId,
      directusUserId: people.customer.directusUserId,
    };
    expect(await resolveProject(build, demoProject, other, new Date())).toBeNull();
    expect(
      await resolveProject(new DrizzleAccessStore(db), demoProject, who, new Date()),
    ).toBeNull();
  });

  test("staff publish with sign-in: the contact is the organisation's only member and is invited", async () => {
    const res = await app.request(`/api/v2/admin/accounts/demos/${demo.id}/publish`, {
      method: "POST",
      headers: as(people.staff),
      body: JSON.stringify({ sign_in: true }),
    });
    expect(res.status).toBe(200);
    expect(await members()).toEqual([{ user: contact.appUserId as string, role: "admin" }]);
    expect(await signIn()).toBe("active");
    expect((deps.jobs as MemoryJobs).of("account.send-email")).toMatchObject([
      { to: "robin@harbourtown.example", template: "account_invite" },
    ]);
  });

  test("every demo conversation is marked synthetic and can be found by that mark", async () => {
    const marked = (await db.execute(sql`
      select c.id, c.project_id, c.participant_name, c.summary, c.duration, p.name as project_name
      from conversation c join project p on p.id = c.project_id
      where exists (select 1 from agent_loop l where l.project_id = p.id
        and l.popcorn_state->'demo'->>'synthetic' = 'true')`)) as unknown as {
      project_id: string;
      participant_name: string;
      summary: string;
      duration: number | null;
      project_name: string;
    }[];
    expect(marked).toHaveLength(AUTHORED.conversations.length);
    for (const c of marked) {
      expect(c.project_id).toBe(demoProject);
      expect(c.project_name).toStartWith("[SYNTHETIC] Harbourtown Council (sample)");
      expect(c.participant_name).toEndWith("(synthetic)");
      expect(c.summary).toStartWith("Synthetic demo.");
      // No audio, so no recorded time: usage and the free plan's hour count nothing.
      expect(c.duration).toBeNull();
    }
    // The mark covers the whole organisation: it holds no conversation outside the mark.
    const [all] = (await db.execute(sql`
      select count(*)::int as n from conversation c join project p on p.id = c.project_id
      join workspace w on w.id = p.workspace_id where w.org_id = ${demo.org_id}`)) as unknown as {
      n: number;
    }[];
    expect(all?.n).toBe(marked.length);
    // Staff's record of the demo names the same project.
    expect(demo.links.projects.map((p) => p.project_id)).toEqual([demoProject]);
  });

  test("the demo adds nothing to the organisation's usage, and real recordings still count", async () => {
    const path = `/api/v2/workspaces/${demoWorkspace}/usage`;
    const before = (await get(contact, path)).data;
    expect(before).toMatchObject({
      tier: "free",
      audio_hours: 0,
      usage_gates: { over_cap_active: false, uploads_locked: false },
      free_tier: { active: true, chats_used: 0, reports_used: 0 },
    });
    // The prospect's first own project, in the same workspace: half an hour, then the hour.
    const own = newId();
    await realProject(own, demoWorkspace, contact);
    await record(own, 1800);
    expect((await get(contact, path)).data).toMatchObject({
      audio_hours: 0.5,
      usage_gates: { over_cap_active: false, uploads_locked: false },
    });
    await record(own, 1800);
    expect((await get(contact, path)).data).toMatchObject({
      audio_hours: 1,
      usage_gates: { over_cap_active: true, uploads_locked: true },
    });
  });

  test("the public numbers count the real project and leave the demo out", async () => {
    // Before the demo: the customer's project with one conversation. Since then one real
    // project with two conversations was added; the demo's project and conversations are not in.
    expect(statsBefore).toEqual({ projects_count: 1, conversations_count: 1, hours_recorded: 0 });
    expect(await stats()).toEqual({ projects_count: 2, conversations_count: 3, hours_recorded: 2 });
  });

  test("the demo reaches no other organisation, and no other organisation reaches it", async () => {
    // The customer beside it: same workspace, same project, same conversation, nothing added.
    expect(
      (await get(people.customer, `/api/v2/workspaces/${customer.workspace}/usage`)).data,
    ).toMatchObject({ project_count: 1, audio_hours: 0.5, free_tier: { reports_used: 0 } });
    const theirs = (await get(people.customer, "/api/v2/workspaces")).data as {
      organisations: { id: string }[];
    };
    expect(theirs.organisations.map((o) => o.id)).toEqual([customer.org]);
    const rows = async (table: string, org: string) =>
      (
        (await db.execute(
          sql`select count(*)::int as n from ${sql.identifier(table)} where org_id = ${org}`,
        )) as unknown as { n: number }[]
      )[0]?.n;
    for (const table of ["account_task", "account_event", "account_document", "account_demo"])
      expect(await rows(table, customer.org)).toBe(0);
    expect(await rows("org_membership", customer.org)).toBe(1);
    expect(await rows("workspace", customer.org)).toBe(1);
    const [projects] = (await db.execute(
      sql`select count(*)::int as n from project where workspace_id = ${customer.workspace}`,
    )) as unknown as { n: number }[];
    expect(projects?.n).toBe(1);
    // Access, both ways: the customer cannot open the demo, the contact cannot open theirs,
    // and staff are no member of the prospect's organisation.
    await expect(access.project(people.customer, demoProject, "project:read")).rejects.toThrow();
    await expect(access.project(contact, customer.project, "project:read")).rejects.toThrow();
    await expect(access.workspace(people.staff, demoWorkspace, "project:read")).rejects.toThrow();
    expect((await get(people.customer, `/api/v2/workspaces/${demoWorkspace}/usage`)).status).toBe(
      403,
    );
    expect((await access.project(contact, demoProject, "project:read")).role).toBe("admin");
  });

  test("the organisation's admin removes the demo by deleting its project; nobody else can", async () => {
    const del = (who: Person) =>
      app.request(`/api/projects/${demoProject}`, { method: "DELETE", headers: as(who) });
    expect((await del(people.customer)).status).toBe(404);
    expect((await del(people.staff)).status).toBe(404);
    expect((await del(contact)).status).toBe(200);
    const usage = (await get(contact, `/api/v2/workspaces/${demoWorkspace}/usage`)).data as {
      project_count: number;
      audio_hours: number;
    };
    // Only the prospect's own project is left, with its hour.
    expect(usage.project_count).toBe(1);
    expect(usage.audio_hours).toBe(1);
    expect(await stats()).toEqual({ projects_count: 2, conversations_count: 3, hours_recorded: 2 });
  });
});
