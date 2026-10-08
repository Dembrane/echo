import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import postgres from "postgres";
import { cloneProject, type ProjectDeps } from "../src/projects";
import { projectsStorage } from "../src/storage";

// A clone keeps every project setting and the project's own verify topics.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = "projects_clone_test";

const SETTINGS = {
  context: "City listening",
  default_conversation_ask_for_participant_email: true,
  is_verify_enabled: true,
  is_verify_on_finish_enabled: true,
  enable_ai_title_and_tags: true,
  conversation_title_prompt: "Short titles",
  anonymize_transcripts: true,
  is_get_reply_enabled: true,
  get_reply_mode: "explore",
  get_reply_prompt: "Ask about housing",
  is_canvas_enabled: true,
  is_dembrane_event_cta_enabled: false,
  legal_basis: "consent",
  privacy_policy_url: "https://example.com/privacy",
};

run("clone project", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let d: ProjectDeps;
  const owner: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
  const cloner: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
  const ws = newId();
  const src = newId();
  const billing = newId();
  const topicKey = "housing-abcdef12";

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
    for (const u of [owner, cloner]) {
      await sql`insert into directus_users (id) values (${u.directusUserId})`;
      await sql`insert into app_user (id, directus_user_id) values (${u.appUserId}, ${u.directusUserId})`;
    }
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'changemaker')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner'), (${newId()}, ${ws}, ${cloner.appUserId}, 'member')`;
    await sql`insert into project ${sql({
      id: src,
      name: "Source",
      workspace_id: ws,
      is_conversation_allowed: true,
      selected_verification_key_list: `agreements,${topicKey}`,
      host_guide: sql.json([{ title: "Welcome" }]),
      ...SETTINGS,
    })}`;
    await sql`insert into languages (code, name) values ('en-US', 'English'), ('nl-NL', 'Dutch') on conflict do nothing`;
    await sql`insert into verification_topic (key, project_id, prompt, icon, sort, user_updated, date_updated) values (${topicKey}, ${src}, 'What about housing?', 'house', 3, ${owner.directusUserId}, '2026-01-01')`;
    await sql`insert into verification_topic_translations (verification_topic_key, languages_code, label) values (${topicKey}, 'en-US', 'Housing'), (${topicKey}, 'nl-NL', 'Wonen')`;
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

  test("the clone keeps every setting", async () => {
    const id = await cloneProject(d, owner, src, { name: "Copy", language: null });
    const [row] = await sql`select * from project where id = ${id}`;
    expect(row).toMatchObject({ ...SETTINGS, name: "Copy", host_guide: [{ title: "Welcome" }] });
  });

  test("custom verify topics are copied under new keys, and the selection follows them", async () => {
    const id = await cloneProject(d, cloner, src, { name: null, language: null });
    const topics = await sql`select * from verification_topic where project_id = ${id}`;
    expect(topics).toHaveLength(1);
    const copy = topics[0] as Record<string, unknown>;
    expect(copy.key).not.toBe(topicKey);
    expect(copy.key).toStartWith("housing-");
    expect(copy).toMatchObject({ prompt: "What about housing?", icon: "house", sort: 3 });
    expect(copy).toMatchObject({
      user_created: cloner.directusUserId,
      user_updated: null,
      date_updated: null,
    });
    const labels =
      await sql`select languages_code, label from verification_topic_translations where verification_topic_key = ${copy.key as string} order by languages_code`;
    expect(labels.map((l) => [l.languages_code, l.label])).toEqual([
      ["en-US", "Housing"],
      ["nl-NL", "Wonen"],
    ]);
    const [row] = await sql`select selected_verification_key_list from project where id = ${id}`;
    expect(row?.selected_verification_key_list).toBe(`agreements,${copy.key}`);
    const [orig] = await sql`select project_id from verification_topic where key = ${topicKey}`;
    expect(orig?.project_id).toBe(src);
  });

  test("on the free plan the clone shows the event invitation again", async () => {
    await sql`update billing_account set tier = 'free' where id = ${billing}`;
    const id = await cloneProject(d, owner, src, { name: null, language: null }).finally(
      () => sql`update billing_account set tier = 'changemaker' where id = ${billing}`,
    );
    const [row] = await sql`select is_dembrane_event_cta_enabled from project where id = ${id}`;
    expect(row?.is_dembrane_event_cta_enabled).toBe(true);
  });
});
