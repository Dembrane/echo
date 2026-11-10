import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId, PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Hono } from "hono";
import type postgres from "postgres";
import { projectRoutes } from "../src/routes";

// ECHO-1052: asking participants for their email (and the report notifications it feeds)
// sits behind ENABLE_PARTICIPANT_EMAIL. Off, the PATCH cannot switch either on; a project
// that already has one on keeps it and can switch it off. And the cross-pollination switch
// is a project setting the PATCH accepts, off for every project until a host turns it on.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `projects_email_flag_${process.pid}`;
const NOW = new Date("2026-11-10T00:00:00Z");

run("participant email flag and cross-pollination", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const apps: Record<"off" | "on", Hono<Env>> = {} as never;
  let owner: Signed & { appUserId: string; directusUserId: string };
  let ws: string;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const access = new Access(new DrizzleAccessStore(database.db));
    const jobs = { enqueue: async () => "job" };
    for (const flag of ["off", "on"] as const) {
      const app = new Hono<Env>();
      app.use(async (c, next) => {
        const id = c.req.header("x-app");
        if (id)
          c.set("principal", {
            appUserId: id,
            directusUserId: c.req.header("x-directus") ?? null,
            isStaff: false,
          } as Signed);
        await next();
      });
      app.route(
        "/",
        projectRoutes({
          db: database.db,
          access,
          queue: jobs,
          now: () => NOW,
          participantEmail: flag === "on",
        }),
      );
      app.onError((err, c) =>
        err instanceof PlatformError
          ? c.json({ code: err.code, detail: err.details ?? err.message }, err.status as 400)
          : c.json({ detail: String(err) }, 500),
      );
      apps[flag] = app;
    }
    owner = { appUserId: newId(), directusUserId: newId(), isStaff: false };
    await sql`insert into directus_users (id) values (${owner.directusUserId})`;
    await sql`insert into app_user (id, directus_user_id) values (${owner.appUserId}, ${owner.directusUserId})`;
    const org = newId();
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    const ba = newId();
    await sql`insert into billing_account (id, tier, org_id) values (${ba}, 'pioneer', ${org})`;
    ws = newId();
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${ba})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner')`;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function project(fields: { email?: boolean; notify?: boolean } = {}) {
    const id = newId();
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, directus_user_id,
        default_conversation_ask_for_participant_email, is_project_notification_subscription_allowed)
      values (${id}, 'P', ${ws}, true, ${owner.directusUserId}, ${fields.email ?? false}, ${fields.notify ?? false})`;
    return id;
  }

  const patch = (flag: "off" | "on", id: string, body: Record<string, unknown>) =>
    apps[flag].request(`/api/v2/bff/projects/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-app": owner.appUserId,
        "x-directus": owner.directusUserId,
      },
      body: JSON.stringify(body),
    });

  const stored = async (id: string) => {
    const [r] = await sql<
      {
        email: boolean;
        notify: boolean;
        cross: boolean;
      }[]
    >`select default_conversation_ask_for_participant_email as email,
        is_project_notification_subscription_allowed as notify,
        is_get_reply_cross_pollination_enabled as cross
      from project where id = ${id}`;
    return r;
  };

  test("flag off: asking for email cannot be switched on, with a proper code", async () => {
    const id = await project();
    const res = await patch("off", id, { default_conversation_ask_for_participant_email: true });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("project.participant_email_off");
    expect(await stored(id)).toMatchObject({ email: false });
  });

  test("flag off: report notifications cannot be switched on either", async () => {
    const id = await project();
    const res = await patch("off", id, { is_project_notification_subscription_allowed: true });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("project.participant_email_off");
    expect(await stored(id)).toMatchObject({ notify: false });
  });

  test("flag off: the editor's save of everything else still works with both settings off", async () => {
    const id = await project();
    const res = await patch("off", id, {
      default_conversation_ask_for_participant_email: false,
      is_project_notification_subscription_allowed: false,
      default_conversation_title: "Hello",
    });
    expect(res.status).toBe(200);
  });

  test("flag off: a project that already asks for email keeps it and can switch it off", async () => {
    const id = await project({ email: true, notify: true });
    const keep = await patch("off", id, {
      default_conversation_ask_for_participant_email: true,
      is_project_notification_subscription_allowed: true,
      default_conversation_title: "Still on",
    });
    expect(keep.status).toBe(200);
    expect(await stored(id)).toMatchObject({ email: true, notify: true });
    const off = await patch("off", id, {
      default_conversation_ask_for_participant_email: false,
      is_project_notification_subscription_allowed: false,
    });
    expect(off.status).toBe(200);
    expect(await stored(id)).toMatchObject({ email: false, notify: false });
    // Once off, it stays off while the flag is.
    const again = await patch("off", id, { default_conversation_ask_for_participant_email: true });
    expect(again.status).toBe(422);
  });

  test("flag on: both settings switch on as before", async () => {
    const id = await project();
    const res = await patch("on", id, {
      default_conversation_ask_for_participant_email: true,
      is_project_notification_subscription_allowed: true,
    });
    expect(res.status).toBe(200);
    expect(await stored(id)).toMatchObject({ email: true, notify: true });
  });

  test("cross-pollination is off for a new project and the PATCH switches it", async () => {
    const id = await project();
    expect(await stored(id)).toMatchObject({ cross: false });
    const on = await patch("off", id, { is_get_reply_cross_pollination_enabled: true });
    expect(on.status).toBe(200);
    expect(await stored(id)).toMatchObject({ cross: true });
    const off = await patch("off", id, { is_get_reply_cross_pollination_enabled: false });
    expect(off.status).toBe(200);
    expect(await stored(id)).toMatchObject({ cross: false });
  });
});
