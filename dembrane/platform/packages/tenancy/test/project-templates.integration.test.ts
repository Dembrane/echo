import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DrizzleAccessStore } from "@dembrane/access";
import { invalidateFreeLimits } from "@dembrane/allowance";
import { newId, PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import {
  PROJECT_TEMPLATES,
  PROJECT_UPDATE_FIELDS,
  templateColumns,
  templateTags,
} from "@dembrane/projects";
import { Hono } from "hono";
import type postgres from "postgres";
import { MemoryJobSink } from "../src/jobs";
import { tenancyRoutes } from "../src/routes";

// ECHO-1042: POST /v2/workspaces/:id/projects with a template_key writes the preset in the
// creating transaction, on the free path (under the allowance lock) and the paid one.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_project_templates_${process.pid}`;

// Every column a preset may touch, and the two the template is recorded in.
const SETTINGS = [
  ...PROJECT_UPDATE_FIELDS.filter((f) => f !== "tutorial_slug" && f !== "name"),
  "conversation_ask_for_participant_name_label",
  "is_conversation_allowed",
] as const;

run("project templates", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", {
        appUserId: c.req.header("x-app"),
        directusUserId: c.req.header("x-directus") ?? null,
        isStaff: false,
      } as Signed);
      await next();
    });
    app.route(
      "/",
      tenancyRoutes({
        db: database.db,
        accessStore: new DrizzleAccessStore(database.db),
        jobs: new MemoryJobSink(),
        dashboardUrl: "http://dashboard.test",
        inviteSecret: "h".repeat(32),
      }),
    );
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ code: err.code, params: err.params }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function workspace(tier: "free" | "innovator") {
    const owner = { app: newId(), directus: newId() };
    const email = `${owner.app}@example.com`;
    await sql`insert into directus_users (id, email) values (${owner.directus}, ${email})`;
    await sql`insert into app_user (id, directus_user_id, email) values (${owner.app}, ${owner.directus}, ${email})`;
    const org = newId();
    const ba = newId();
    const ws = newId();
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, tier, org_id) values (${ba}, ${tier}, ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${ba})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.app}, 'owner')`;
    return { owner, ws };
  }

  const create = (
    w: Awaited<ReturnType<typeof workspace>>,
    body: Record<string, unknown>,
  ): Promise<Response> =>
    Promise.resolve(
      app.request(`/api/v2/workspaces/${w.ws}/projects`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app": w.owner.app,
          "x-directus": w.owner.directus,
        },
        body: JSON.stringify(body),
      }),
    );

  const row = async (id: string) => {
    const [r] = await sql`select * from project where id = ${id}`;
    return r as Record<string, unknown>;
  };
  const tags = async (id: string) =>
    (await sql`select text from project_tag where project_id = ${id} order by sort`).map(
      (t) => t.text as string,
    );
  const settings = (r: Record<string, unknown>) =>
    Object.fromEntries(SETTINGS.map((k) => [k, r[k] ?? null]));

  test("the migration adds the template columns, null for a project made without one", async () => {
    const cols = await sql`
      select column_name, data_type from information_schema.columns
      where table_name = 'project' and column_name in ('template_key', 'template_version')
      order by column_name`;
    expect(cols.map((c) => [c.column_name, c.data_type])).toEqual([
      ["template_key", "character varying"],
      ["template_version", "integer"],
    ]);
    const w = await workspace("innovator");
    const res = await create(w, { name: "Old client", language: "en" });
    expect(res.status).toBe(200);
    const r = await row(((await res.json()) as { id: string }).id);
    expect([r.template_key, r.template_version]).toEqual([null, null]);
  });

  for (const tier of ["free", "innovator"] as const)
    for (const t of PROJECT_TEMPLATES)
      for (const language of ["en", "nl"])
        test(`${t.key} (${tier}, ${language}): the stored settings are the preset`, async () => {
          const w = await workspace(tier);
          const res = await create(w, { name: "From a template", language, template_key: t.key });
          expect(res.status).toBe(200);
          const { id } = (await res.json()) as { id: string };
          const r = await row(id);
          const expected = templateColumns(t, language);
          for (const [k, v] of Object.entries(expected)) expect([k, r[k]]).toEqual([k, v]);
          expect(r.template_key).toBe(t.key);
          expect(r.template_version).toBe(t.version);
          expect(await tags(id)).toEqual(templateTags(t, language));
          // Never preset, whatever the template: the database defaults stay.
          expect(r.anonymize_transcripts).toBe(false);
          expect(r.legal_basis).toBeNull();
          expect(r.privacy_policy_url).toBeNull();
          expect(r.is_dembrane_event_cta_enabled).toBe(true);
          expect(r.language).toBe(language);
        });

  test("event words its participant texts in the project's language", async () => {
    const w = await workspace("innovator");
    const res = await create(w, { name: "Avond", language: "nl", template_key: "event" });
    const { id } = (await res.json()) as { id: string };
    expect((await row(id)).conversation_ask_for_participant_name_label).toBe(
      "Naam van je tafel of groep",
    );
    expect(await tags(id)).toEqual(["Ronde 1", "Ronde 2"]);
    // A language without its own text falls back to English.
    const other = await create(w, { name: "X", language: "multi", template_key: "event" });
    const otherId = ((await other.json()) as { id: string }).id;
    expect(await tags(otherId)).toEqual(["Round 1", "Round 2"]);
  });

  test("blank is what the create wizard wrote before templates", async () => {
    const w = await workspace("innovator");
    // Before: the bare insert, then the wizard's PATCH of these four values.
    const before = (await (await create(w, { name: "Before", language: "en" })).json()) as {
      id: string;
    };
    await sql`update project set default_conversation_ask_for_participant_name = true,
      default_conversation_tutorial_slug = 'None', image_generation_model = 'MODEST'
      where id = ${before.id}`;
    const blank = (await (
      await create(w, { name: "Blank", language: "en", template_key: "blank" })
    ).json()) as { id: string };
    expect(settings(await row(blank.id))).toEqual(settings(await row(before.id)));
    expect(await tags(blank.id)).toEqual([]);
  });

  test("an unknown key is a validation error and writes nothing", async () => {
    const w = await workspace("free");
    const res = await create(w, { name: "Nope", language: "en", template_key: "festival" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; params: Record<string, unknown> };
    expect(body.code).toBe("project.template_unknown");
    expect(body.params.template_key).toBe("festival");
    const [n] = await sql`select count(*)::int as n from project where workspace_id = ${w.ws}`;
    expect(n?.n).toBe(0);
  });

  test("the workspace list says which project is the sample, so home can tell it apart", async () => {
    const w = await workspace("innovator");
    const own = (
      (await (await create(w, { name: "Mine", language: "en" })).json()) as {
        id: string;
      }
    ).id;
    const sample = newId();
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample)
      values (${sample}, 'Best practices (sample)', ${w.ws}, false, true)`;
    const res = await app.request(`/api/v2/workspaces/${w.ws}/projects`, {
      headers: { "x-app": w.owner.app, "x-directus": w.owner.directus },
    });
    const body = (await res.json()) as { projects: { id: string; is_sample: boolean }[] };
    const flags = Object.fromEntries(body.projects.map((p) => [p.id, p.is_sample]));
    expect(flags).toEqual({ [own]: false, [sample]: true });
  });
});
