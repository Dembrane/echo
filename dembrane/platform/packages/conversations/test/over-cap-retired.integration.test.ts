import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { assetPath, newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import postgres from "postgres";
import { overCapActive } from "../src/bff/lock";
import { bffStore } from "../src/bff/storage";
import { workspaceOverCapActive } from "../src/live/monitor";
import { type PipelineDeps, stampOverCap } from "../src/pipeline/steps";
import { admin, freshDatabase } from "./pipeline-harness";

// The lifetime hour lock is retired: no stamp, no live lock, old stamps cleared.
const run = admin ? describe : describe.skip;
const TAG = "0029_expand_clear_over_cap";

run("the retired over-cap lock", () => {
  setDefaultTimeout(60_000);
  let url: string;
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  const ws = newId();
  const proj = newId();
  const stamped = newId();

  beforeAll(async () => {
    url = await freshDatabase("conv_over_cap_retired_test");
    database = createDb({ url, poolMax: 3 });
    sql = postgres(url, { max: 2, onnotice: () => {} });
    const org = newId();
    const billing = newId();
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${proj}, 'P', ${ws}, true)`;
    // 3 h of lifetime audio, one conversation stamped by the old lock.
    await sql`insert into conversation (id, project_id, participant_name, source, duration, is_finished, is_over_cap, created_at, updated_at) values
      (${newId()}, ${proj}, 'A', 'PORTAL_AUDIO', 7200, true, false, now(), now()),
      (${stamped}, ${proj}, 'B', 'PORTAL_AUDIO', 3600, true, true, now(), now())`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
  });

  test("the migration clears existing stamps", async () => {
    const journal = (await Bun.file(
      assetPath("db", "migrations", "meta", "_journal.json"),
    ).json()) as { entries: { tag: string; when: number }[] };
    const entry = journal.entries.find((e) => e.tag === TAG);
    expect(entry).toBeDefined();
    // Forget 0029 so the next migrate applies it over the stamped row.
    await sql`delete from drizzle.__drizzle_migrations where created_at = ${entry?.when ?? -1}`;
    const res = await migrate(url, { appEnv: "test" });
    expect(res.applied).toBe(1);
    const [row] = await sql`select is_over_cap from conversation where id = ${stamped}`;
    expect(row?.is_over_cap).toBe(false);
  });

  test("the live lock never applies, even past the old hour", async () => {
    const store = bffStore(database.db);
    expect(await store.workspaceSeconds(ws)).toBe(10800);
    expect(await overCapActive(ws, "free", (w) => store.workspaceSeconds(w))).toBe(false);
    expect(await workspaceOverCapActive(database.db, ws, "free")).toBe(false);
  });

  test("finishing a conversation no longer stamps it", async () => {
    const next = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, duration, is_finished, created_at, updated_at)
      values (${next}, ${proj}, 'C', 'PORTAL_AUDIO', 600, true, now(), now())`;
    const deps = { db: database.db, now: () => new Date() } as unknown as PipelineDeps;
    await stampOverCap(deps, next);
    const [row] = await sql`select is_over_cap from conversation where id = ${next}`;
    expect(row?.is_over_cap).toBe(false);
  });
});
