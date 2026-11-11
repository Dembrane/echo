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
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import postgres from "postgres";
import type { ProjectDeps } from "../src/projects";
import { projectsStorage } from "../src/storage";
import { reorderTags } from "../src/tags";

// Dragging a tag saves the project's whole tag order in one request, all or nothing.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = "projects_reorder_tags_test";

run("tag reorder", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let d: ProjectDeps;
  const owner: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
  const stranger: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
  const [project, other] = [newId(), newId()];
  const [a, b, c, boom, foreign] = [newId(), newId(), newId(), newId(), newId()];

  beforeAll(async () => {
    const adm = postgres(admin as string, { max: 1, onnotice: () => {} });
    await adm.unsafe(`drop database if exists ${DB} with (force)`);
    await adm.unsafe(`create database ${DB}`);
    await adm.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${DB}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [org, billing, ws] = [newId(), newId(), newId()];
    for (const who of [owner, stranger])
      await sql`insert into app_user (id, directus_user_id) values (${who.appUserId}, ${who.directusUserId})`;
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id) values (${billing}, ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner')`;
    for (const id of [project, other])
      await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${id}, 'P', ${ws}, true)`;
    // Any write to the "Boom" tag fails, like a dropped connection halfway through the save.
    await sql.unsafe(`
      create function fail_boom() returns trigger language plpgsql as $$
      begin if new.text = 'Boom' then raise exception 'boom'; end if; return new; end $$;
      create trigger fail_boom before update on project_tag for each row execute function fail_boom();`);
    d = {
      db: database.db,
      store: projectsStorage(database.db),
      access: new Access(new DrizzleAccessStore(database.db)),
      jobs: { enqueue: async () => "job" },
      now: () => new Date(),
    };
  });
  beforeEach(async () => {
    await sql`delete from project_tag`;
    for (const [id, text, sort] of [
      [a, "A", 1],
      [b, "B", 2],
      [c, "C", 3],
    ] as const)
      await sql`insert into project_tag (id, project_id, text, sort) values (${id}, ${project}, ${text}, ${sort})`;
    await sql`insert into project_tag (id, project_id, text, sort) values (${foreign}, ${other}, 'F', 7)`;
  });
  afterAll(async () => {
    await sql.end();
    await database.close();
  });

  const saved = async (projectId = project) =>
    (
      await sql`select text, sort from project_tag where project_id = ${projectId} order by sort, text`
    ).map((r) => `${r.text}:${r.sort}`);

  test("saves the order it is given", async () => {
    const out = await reorderTags(d, owner, { project_id: project, tag_ids: [c, a, b] });
    expect(out.map((t) => t.id)).toEqual([c, a, b]);
    expect(await saved()).toEqual(["C:1", "A:2", "B:3"]);
  });

  test("tags left out stay after the listed ones; another project's tags are not touched", async () => {
    await reorderTags(d, owner, { project_id: project, tag_ids: [c, foreign, c] });
    expect(await saved()).toEqual(["C:1", "A:2", "B:3"]);
    expect(await saved(other)).toEqual(["F:7"]);
  });

  test("a write that fails halfway leaves every tag where it was", async () => {
    await sql`insert into project_tag (id, project_id, text, sort) values (${boom}, ${project}, 'Boom', 4)`;
    // C and A are written before Boom fails.
    await expect(
      reorderTags(d, owner, { project_id: project, tag_ids: [c, a, boom, b] }),
    ).rejects.toThrow();
    expect(await saved()).toEqual(["A:1", "B:2", "C:3", "Boom:4"]);
  });

  test("someone without access to the project cannot reorder its tags", async () => {
    await expect(
      reorderTags(d, stranger, { project_id: project, tag_ids: [c, b, a] }),
    ).rejects.toThrow();
    expect(await saved()).toEqual(["A:1", "B:2", "C:3"]);
  });
});
