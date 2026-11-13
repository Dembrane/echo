import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import type postgres from "postgres";
import { projectSettings } from "../src/data/project";

// ECHO-1052: with ENABLE_PARTICIPANT_EMAIL off the assistant does not see the email settings
// of a project that has them off, so proposeProjectUpdate (which offers only what this lists)
// cannot propose switching them on. A project that has one on still shows it.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `agentic_email_flag_${process.pid}`;
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("the assistant's view of email settings", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let access: Access;
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
    access = new Access(new DrizzleAccessStore(database.db));
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

  async function project(email: boolean) {
    const id = newId();
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, directus_user_id,
        default_conversation_ask_for_participant_email)
      values (${id}, 'P', ${ws}, true, ${owner.directusUserId}, ${email})`;
    return id;
  }

  const settings = (id: string, participantEmail: boolean) =>
    projectSettings(
      { db: database.db, access, logger: quiet, now: () => new Date(), participantEmail },
      owner,
      id,
    );

  test("flag off: email settings that are off are not offered", async () => {
    const s = await settings(await project(false), false);
    expect("default_conversation_ask_for_participant_email" in s).toBe(false);
    expect("is_project_notification_subscription_allowed" in s).toBe(false);
    expect(s).toHaveProperty("is_get_reply_cross_pollination_enabled", true);
  });

  test("flag off: an email setting a project has on stays visible, to switch off", async () => {
    const s = await settings(await project(true), false);
    expect(s).toHaveProperty("default_conversation_ask_for_participant_email", true);
    expect("is_project_notification_subscription_allowed" in s).toBe(false);
  });

  test("flag on: every setting is offered as before", async () => {
    const s = await settings(await project(false), true);
    expect(s).toHaveProperty("default_conversation_ask_for_participant_email", false);
    expect(s).toHaveProperty("is_project_notification_subscription_allowed", false);
  });
});
