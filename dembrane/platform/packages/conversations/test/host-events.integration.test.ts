import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Capture } from "@dembrane/analytics";
import { newId } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import postgres from "postgres";
import { conversationCreated, FIRST_VALUE, hostEventStore } from "../src/host-events";
import { admin, freshDatabase, quiet } from "./pipeline-harness";

// The first-value claim against a real database: the primary key lets exactly one of many
// concurrent conversations through, the creator is read from the project, a sample project
// never claims, and hosts who had conversations before the migration count as reached.
const run = admin ? describe : describe.skip;

run("host milestones", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  const host = newId();
  const veteran = newId();
  const project = newId();
  const sample = newId();

  beforeAll(async () => {
    const url = await freshDatabase("conv_host_milestones_test");
    database = createDb({ url, poolMax: 5 });
    sql = postgres(url, { max: 2, onnotice: () => {} });
    for (const [id, email] of [
      [host, "Host@Example.nl"],
      [veteran, "veteran@example.nl"],
    ] as const) {
      await sql`insert into directus_users (id, email) values (${id}, ${email})`;
      await sql`insert into app_user (id, directus_user_id, email, display_name) values (${newId()}, ${id}, ${email}, ${email})`;
    }
    await sql`insert into project (id, name, directus_user_id, is_conversation_allowed, language)
      values (${project}, 'Mine', ${host}, true, 'nl')`;
    await sql`insert into project (id, name, directus_user_id, is_conversation_allowed, is_sample)
      values (${sample}, 'Best practices (sample)', ${host}, true, true)`;
  });
  afterAll(async () => {
    await sql?.end();
    await database?.close();
  });

  test("reads the creator, their email and the sample flag from the project", async () => {
    const store = hostEventStore(database.db);
    expect(await store.projectOwner(project)).toEqual({
      directusUserId: host,
      email: "Host@Example.nl",
      isSample: false,
      language: "nl",
    });
    expect((await store.projectOwner(sample))?.isSample).toBe(true);
    expect(await store.projectOwner(newId())).toBeNull();
  });

  test("one claim wins among concurrent conversations, and a sample claims nothing", async () => {
    const sent: string[] = [];
    const capture: Capture = async (distinctId, event) => {
      sent.push(`${distinctId} ${event}`);
    };
    const d = { store: hostEventStore(database.db), capture, logger: quiet, now: () => new Date() };
    await conversationCreated(d, {
      conversationId: newId(),
      projectId: sample,
      source: "DASHBOARD_UPLOAD",
      byHost: true,
    });
    expect(sent).toEqual(["host@example.nl server_conversation_created"]);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        conversationCreated(d, {
          conversationId: newId(),
          projectId: project,
          source: "PORTAL_AUDIO",
          byHost: false,
        }),
      ),
    );
    expect(sent.filter((s) => s.endsWith("server_first_value_reached"))).toEqual([
      "host@example.nl server_first_value_reached",
    ]);
    const rows = await sql`select project_id from host_milestone where directus_user_id = ${host}`;
    expect(rows.map((r) => r.project_id)).toEqual([project]);
  });

  test("the migration's backfill marks hosts who already had a conversation", async () => {
    const old = newId();
    await sql`insert into project (id, name, directus_user_id, is_conversation_allowed)
      values (${old}, 'Old', ${veteran}, true)`;
    await sql`insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
      values (${newId()}, ${old}, 'P', 'PORTAL_AUDIO', now() - interval '30 days', now())`;
    const migration = await Bun.file(
      new URL("../../db/migrations/0053_expand_host_milestone.sql", import.meta.url),
    ).text();
    for (const statement of migration.split("--> statement-breakpoint"))
      await sql.unsafe(statement);
    const [row] =
      await sql`select milestone, project_id from host_milestone where directus_user_id = ${veteran}`;
    expect(row).toEqual({ milestone: FIRST_VALUE, project_id: old });
    // Run twice: nothing changes, nothing fails.
    for (const statement of migration.split("--> statement-breakpoint"))
      await sql.unsafe(statement);
    const [n] = await sql`select count(*)::int as n from host_milestone`;
    expect(n?.n).toBe(2);
  });
});
