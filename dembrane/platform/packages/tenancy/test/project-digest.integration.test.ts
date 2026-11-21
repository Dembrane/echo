import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DrizzleAccessStore } from "@dembrane/access";
import { invalidateFreeLimits } from "@dembrane/allowance";
import { newId, PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { projectTemplate, templateHostGuide, templateTags } from "@dembrane/projects";
import { Hono } from "hono";
import type postgres from "postgres";
import { MemoryJobSink } from "../src/jobs";
import { tenancyRoutes } from "../src/routes";

// ECHO-1055: POST /v2/workspaces/:id/projects with `digest` (what the host kept from the
// context digest) writes each part in the creating transaction, on the free path and the
// paid one, and refuses anything outside its allow-list before anything is written.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_project_digest_${process.pid}`;

run("creating from a digest", () => {
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
    const [org, ba, ws] = [newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, tier, org_id) values (${ba}, ${tier}, ${org})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${ba})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.app}, 'owner')`;
    return { owner, ws };
  }

  const create = (w: Awaited<ReturnType<typeof workspace>>, body: Record<string, unknown>) =>
    Promise.resolve(
      app.request(`/api/v2/workspaces/${w.ws}/projects`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app": w.owner.app,
          "x-directus": w.owner.directus,
        },
        body: JSON.stringify({ name: "Bewonersavond", language: "nl", ...body }),
      }),
    );
  const row = async (id: string) =>
    ((await sql`select * from project where id = ${id}`)[0] ?? {}) as Record<string, unknown>;
  const tags = async (id: string) =>
    (await sql`select text from project_tag where project_id = ${id} order by sort`).map(
      (t) => t.text as string,
    );
  const goals = async (id: string) =>
    await sql`select content, set_by, created_by from project_goal_revision where project_id = ${id}`;
  const count = async () => Number((await sql`select count(*)::int as n from project`)[0]?.n);

  const FULL = {
    context: "Bewonersavond in het Klokgebouw over het warmtenet.",
    key_terms: ["Klokgebouw", "Woonbedrijf", "klokgebouw", "VvE Strijp-R"],
    tags: ["Wat gaat goed", "Wat moet anders"],
    name_label: "Tafel",
    verify_topics: ["agreements", "disagreements"],
    explore_prompt: "Stel de groep één open vraag over het warmtenet. Geef nooit een mening.",
    host_script_additions: ["Begin met de vraag wat goed gaat in de wijk."],
    goal: "Horen wat bewoners willen veranderen aan het warmtenet.",
  };

  for (const tier of ["free", "innovator"] as const)
    test(`every part is written with the template (${tier})`, async () => {
      const w = await workspace(tier);
      const res = await create(w, { template_key: "resident_evening", digest: FULL });
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      const r = await row(id);
      expect(r.template_key).toBe("resident_evening");
      expect(r.context).toBe(FULL.context);
      expect(r.default_conversation_transcript_prompt).toBe(
        "Klokgebouw, Woonbedrijf, VvE Strijp-R",
      );
      expect(await tags(id)).toEqual(FULL.tags);
      expect(r.conversation_ask_for_participant_name_label).toBe("Tafel");
      expect(r.selected_verification_key_list).toBe("agreements,disagreements");
      expect([r.is_get_reply_enabled, r.get_reply_mode, r.get_reply_prompt]).toEqual([
        true,
        "custom",
        FULL.explore_prompt,
      ]);
      const guide = r.host_guide as { steps: { content: string }[]; title: string };
      const base = templateHostGuide(projectTemplate("resident_evening"), "nl");
      expect(guide.title).toBe(base?.title as string);
      expect(guide.steps.map((s) => s.content)).toEqual([
        ...(base?.steps.map((s) => s.content) ?? []),
        "Begin met de vraag wat goed gaat in de wijk.",
      ]);
      // The rest of the preset stands.
      expect(r.is_verify_enabled).toBe(true);
      expect(r.default_conversation_tutorial_slug).toBe("advanced");
      const [goal] = await goals(id);
      expect(goal).toMatchObject({
        content: FULL.goal,
        set_by: "host-edit",
        created_by: w.owner.directus,
      });
    });

  test("each part is optional: without one, the template's own stays", async () => {
    const w = await workspace("innovator");
    const res = await create(w, { template_key: "resident_evening", digest: { goal: "Leren." } });
    const { id } = (await res.json()) as { id: string };
    const r = await row(id);
    const t = projectTemplate("resident_evening");
    expect(await tags(id)).toEqual(templateTags(t, "nl"));
    expect(r.get_reply_mode).toBe("summarize");
    expect(r.selected_verification_key_list).toBe("agreements");
    expect(r.context).toBeNull();
    expect((await goals(id)).length).toBe(1);
  });

  test("without a template: context, key terms, tags and goal still land", async () => {
    const w = await workspace("innovator");
    const res = await create(w, {
      digest: { context: "Iets", key_terms: ["Klokgebouw"], tags: ["Ronde A"], goal: "Doel." },
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect((await row(id)).context).toBe("Iets");
    expect(await tags(id)).toEqual(["Ronde A"]);
  });

  test("anything outside the allow-list is a 422 naming it, and nothing is written", async () => {
    const w = await workspace("innovator");
    const before = await count();
    for (const digest of [
      { anonymize_transcripts: false },
      { legal_basis: "consent" },
      { privacy_policy_url: "https://x" },
      { is_conversation_allowed: false },
      { verify_topics: ["votes"] },
      { verify_topics: [] },
      { tags: Array.from({ length: 9 }, (_, i) => `R${i}`) },
      { key_terms: Array.from({ length: 31 }, (_, i) => `Term ${i}`) },
      { name_label: "x".repeat(81) },
      { explore_prompt: "x".repeat(601) },
      { host_script_additions: ["a", "b", "c", "d"] },
      { context: "x".repeat(20_001) },
      { goal: 42 },
    ]) {
      const res = await create(w, { template_key: "resident_evening", digest });
      expect([digest, res.status]).toEqual([digest, 422]);
    }
    // Host script steps need a template with a host guide.
    const bare = await create(w, { digest: { host_script_additions: ["a"] } });
    expect(bare.status).toBe(422);
    const blank = await create(w, { template_key: "blank", digest: { verify_topics: ["heard"] } });
    expect(blank.status).toBe(422);
    expect(await count()).toBe(before);
  });
});
