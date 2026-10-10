import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DrizzleAccessStore } from "@dembrane/access";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { MemoryJobSink } from "../src/jobs";
import { orgService } from "../src/service/orgs";
import { workspaceService } from "../src/service/workspaces";

// A new organisation's default workspace and every added workspace queue their copy of the
// best-practices sample; the worker seeds it once the creation commits.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_sample_seed_${process.pid}`;

run("workspace creation queues the sample", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const jobs = new MemoryJobSink();
  const who = {
    appUserId: crypto.randomUUID(),
    directusUserId: crypto.randomUUID(),
    isStaff: false,
  };

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    await sql`insert into directus_users (id, email) values (${who.directusUserId}, 'o@example.com')`;
    await sql`insert into app_user (id, directus_user_id, email) values (${who.appUserId}, ${who.directusUserId}, 'o@example.com')`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const deps = () => ({
    db: database.db,
    accessStore: new DrizzleAccessStore(database.db),
    jobs,
    dashboardUrl: "https://dashboard.example.test",
    inviteSecret: "s".repeat(32),
  });
  const seeds = () =>
    jobs.jobs.filter((j) => j.name === "samples.seed-best-practices").map((j) => j.payload);

  test("a new organisation's default workspace and an added workspace each queue one", async () => {
    const { org_id, workspace_id } = await orgService(deps()).create(who, "Org");
    expect(seeds()).toEqual([{ workspaceId: workspace_id }]);
    // Paid, so the free tier's one-workspace limit does not stand in the way.
    await sql`update billing_account set tier = 'innovator' where org_id = ${org_id}`;
    const added = await workspaceService(deps()).create(who, {
      name: "Second",
      org_id,
      visibility: "open_to_organisation",
      data_owner_org_name: null,
      data_owner_email: null,
      partner_agreement_accepted: false,
    });
    expect(seeds()).toEqual([{ workspaceId: workspace_id }, { workspaceId: added.id }]);
  });
});
