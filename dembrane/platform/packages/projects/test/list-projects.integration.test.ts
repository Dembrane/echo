import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import postgres from "postgres";
import { listMyProjects, type ProjectDeps } from "../src/projects";
import { projectsStorage } from "../src/storage";

// The BFF project list the move dialog reads: scoped to one workspace when asked.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = "projects_list_test";

run("BFF project list", () => {
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let d: ProjectDeps;
  const owner: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
  const [wsA, wsB] = [newId(), newId()];
  const [alpha, beta, gamma] = [newId(), newId(), newId()];

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${DB}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const org = newId();
    await sql`insert into app_user (id, directus_user_id) values (${owner.appUserId}, ${owner.directusUserId})`;
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    for (const ws of [wsA, wsB]) {
      const billing = newId();
      await sql`insert into billing_account (id, org_id) values (${billing}, ${org})`;
      await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
      await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner')`;
    }
    for (const [id, ws, name] of [
      [alpha, wsA, "Alpha"],
      [beta, wsA, "Beta"],
      [gamma, wsB, "Gamma"],
    ] as const) {
      await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${id}, ${name}, ${ws}, true)`;
    }
    d = {
      store: projectsStorage(database.db),
      access: new Access(new DrizzleAccessStore(database.db)),
      jobs: { enqueue: async () => "job" },
      now: () => new Date(),
    };
  });
  afterAll(async () => {
    await sql.end();
    await database.close();
  });

  const ids = async (opts: { search?: string; workspaceId?: string }) =>
    (
      await listMyProjects(d, owner, {
        limit: 50,
        offset: 0,
        search: opts.search ?? null,
        workspaceId: opts.workspaceId ?? null,
      })
    )
      .map((r) => r.id)
      .sort();

  test("without a workspace, every reachable project is listed", async () => {
    expect(await ids({})).toEqual([alpha, beta, gamma].sort());
  });

  test("a workspace scopes the list to its own projects, and search still applies", async () => {
    expect(await ids({ workspaceId: wsA })).toEqual([alpha, beta].sort());
    expect(await ids({ workspaceId: wsA, search: "bet" })).toEqual([beta]);
    expect(await ids({ workspaceId: newId() })).toEqual([]);
  });
});
