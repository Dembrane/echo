import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import postgres from "postgres";
import { bffStore } from "../src/bff/storage";
import { workspaceOverCapActive } from "../src/live/monitor";
import { type PipelineDeps, stampOverCap } from "../src/pipeline/steps";
import { initiate, publicProject } from "../src/portal/service";
import { admin, freshDatabase } from "./pipeline-harness";

// A workspace's sample copy (project.is_sample) holds invented conversations no one
// recorded: they spend none of the free tier's lifetime hour, and the copy takes no new
// conversation whatever its portal toggle says, so nothing real escapes the count.
const run = admin ? describe : describe.skip;

run("a sample project and the free hour cap", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  const ws = newId();
  const real = newId();
  const sample = newId();

  beforeAll(async () => {
    const url = await freshDatabase("conv_sample_exemptions_test");
    database = createDb({ url, poolMax: 3 });
    sql = postgres(url, { max: 2, onnotice: () => {} });
    const org = newId();
    const billing = newId();
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${real}, 'Mine', ${ws}, true)`;
    // The toggle is on, as a user could set it: the sample still takes nothing.
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample)
      values (${sample}, 'Best practices (sample)', ${ws}, true, true)`;
    // 50 minutes of the workspace's own audio, and 40 invented minutes in the sample.
    await sql`insert into conversation (id, project_id, participant_name, source, duration, is_finished, created_at, updated_at) values
      (${newId()}, ${real}, 'Mine', 'PORTAL_AUDIO', 3000, true, now(), now()),
      (${newId()}, ${sample}, 'Invented', 'DASHBOARD_UPLOAD', 2400, true, now(), now())`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
  });

  const deps = () => ({ db: database.db, now: () => new Date() }) as unknown as PipelineDeps;

  test("a recording finished under the hour stays unlocked: the sample's minutes do not count", async () => {
    const next = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, duration, is_finished, created_at, updated_at)
      values (${next}, ${real}, 'Mine', 'PORTAL_AUDIO', 300, true, now(), now())`;
    await stampOverCap(deps(), next);
    const [row] = await sql`select is_over_cap from conversation where id = ${next}`;
    expect(row?.is_over_cap).toBe(false);
    expect(await bffStore(database.db).workspaceSeconds(ws)).toBe(3300);
    expect(await workspaceOverCapActive(database.db, ws, "free")).toBe(false);
  });

  test("the hour is still the workspace's own: its own audio past it locks the next one", async () => {
    const more = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, duration, is_finished, created_at, updated_at)
      values (${more}, ${real}, 'Mine', 'PORTAL_AUDIO', 600, true, now(), now())`;
    const after = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, duration, is_finished, created_at, updated_at)
      values (${after}, ${real}, 'Mine', 'PORTAL_AUDIO', 60, true, now(), now())`;
    await stampOverCap(deps(), after);
    const [row] = await sql`select is_over_cap from conversation where id = ${after}`;
    expect(row?.is_over_cap).toBe(true);
  });

  test("the portal refuses the sample even with its toggle on", async () => {
    const d = { db: database.db } as never;
    await expect(publicProject(d, sample)).rejects.toMatchObject({ code: "conversation.not_open" });
    await expect(
      initiate(d, sample, {
        name: "x",
        email: null,
        tagIds: [],
        source: "PORTAL_AUDIO",
      } as never),
    ).rejects.toMatchObject({ code: "conversation.not_open" });
    const [n] = await sql`select count(*)::int as n from conversation where project_id = ${sample}`;
    expect(n?.n).toBe(1);
  });
});
