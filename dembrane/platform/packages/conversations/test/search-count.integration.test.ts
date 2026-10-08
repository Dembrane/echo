import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import postgres from "postgres";
import { searchStorage } from "../src/search/storage";
import { admin, freshDatabase } from "./pipeline-harness";

// Home search shows each project's live conversations, as the project list does.
const run = admin ? describe : describe.skip;

run("search project counts", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const url = await freshDatabase("conv_search_count_test");
    database = createDb({ url, poolMax: 2 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const [org, billing, ws, project] = [newId(), newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id) values (${billing}, ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${project}, 'Batman', ${ws}, true)`;
    await sql`insert into conversation (id, project_id, participant_name, created_at, updated_at, deleted_at) values
      (${newId()}, ${project}, 'P', now(), now(), null),
      (${newId()}, ${project}, 'P', now(), now(), now())`;
  });
  afterAll(async () => {
    await sql.end();
    await database.close();
  });

  test("a project's deleted conversations leave its count", async () => {
    const rows = await searchStorage(database.db).projects("batman", 10);
    expect(rows.map((r) => r.conversations_count)).toEqual([1]);
  });
});
