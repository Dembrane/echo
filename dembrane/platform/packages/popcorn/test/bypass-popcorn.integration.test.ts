import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { Access, Policy } from "@dembrane/access";
import { allowanceForProject, invalidateFreeLimits, usedThisPeriod } from "@dembrane/allowance";
import { analysisRoutes } from "@dembrane/analysis";
import { newId } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import { type CompletionRequest, FakeCompleter, FakeEmbedder } from "@dembrane/llm";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import type postgres from "postgres";
import { popcornAllowance } from "../src/free";
import { runPopcornTick, type TickDeps } from "../src/tick/run";
import { tickDeps } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";
import { freshDatabase } from "./fixtures/tick/seed";

// Adversarial review (group D): paths that let a free account run more popcorn analyses than its 12.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = `popcorn_bypass_${process.pid}`;

run("popcorn bypasses", () => {
  setDefaultTimeout(120_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, DB);
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 8 });
    sql = connect(url, { max: 2, onnotice: () => {} });
  });
  beforeEach(() => invalidateFreeLimits());
  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.end();
  });

  let chunkN = 0;
  async function say(conversationId: string, text: string) {
    const at = new Date(Date.now() - 60_000 + chunkN++).toISOString();
    await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
      values (${newId()}, ${conversationId}, ${text}, ${at}, ${at})`;
  }

  async function addConversation(projectId: string, name: string, text: string) {
    const conv = newId();
    await sql`insert into conversation (id, project_id, participant_name, created_at, duration)
      values (${conv}, ${projectId}, ${name}, now() - interval '1 hour', 600)`;
    await say(conv, text);
    return conv;
  }

  async function seed(blocks: string[]) {
    const [org, billing, ws, user, appUser, projectId, loopId] = [
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
    ];
    const reportId = Math.floor(Math.random() * 1_000_000_000);
    await sql`insert into directus_users (id, email) values (${user}, ${`${user}@example.com`})`;
    await sql`insert into app_user (id, directus_user_id) values (${appUser}, ${user})`;
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role)
      values (${newId()}, ${ws}, ${appUser}, 'owner')`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed,
      is_canvas_enabled, anonymize_transcripts, visibility)
      values (${projectId}, 'P', 'en', ${ws}, true, true, false, 'workspace')`;
    await sql`insert into project_report (id, project_id, kind, status, user_instructions, content, public_token, date_created)
      values (${reportId}, ${projectId}, 'popcorn', 'published', '', '', ${newId()}, now())`;
    await sql`insert into canvas_config_revision (id, report_id, popcorn_settings, created_at, cadence_minutes)
      values (${newId()}, ${reportId}, ${sql.json({ title: "P", presentation: { blocks } })}, now(), 2)`;
    await sql`insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes,
      acting_directus_user_id, failure_count, caps, popcorn_state, created_at)
      values (${loopId}, ${projectId}, ${reportId}, 'P', 'paused', '2026-09-01T09:00:00Z', 2,
        ${user}, 0, ${sql.json({ kind: "popcorn" })}, ${sql.json({})}, now())`;
    return { projectId, loopId, reportId, user, appUser };
  }

  async function ledger(projectId: string) {
    const a = await allowanceForProject(database.db, projectId, new Date());
    if (!a) throw new Error("expected a free account");
    return (await usedThisPeriod(database.db, a)).popcorn_analyses;
  }

  const required = (r: CompletionRequest) =>
    ((r.jsonSchema as { required?: string[] })?.required ?? []).join(",");

  // Extraction of a transcript saying BROKEN always fails; the stakeholders view answers.
  const completer = () =>
    new FakeCompleter().on(
      () => true,
      (r: CompletionRequest) => {
        const user = typeof r.user === "string" ? r.user : r.user.join("\n");
        const req = required(r);
        if (req === "items" && user.includes("BROKEN")) throw new Error("model refused");
        if (req === "stakeholders,relations")
          return JSON.stringify({
            stakeholders: [
              {
                name: "Ferry riders",
                role: "People who ride the night ferry",
                stake: "Getting home after late shifts",
                rung: "voiced",
                stakeWeight: 0.8,
                mentionsWeight: 0.6,
                quotes: [],
              },
              {
                name: "Bridge cyclists",
                role: "People who cycle over the bridge",
                stake: "A safe lane across the river",
                rung: "voiced",
                stakeWeight: 0.6,
                mentionsWeight: 0.4,
                quotes: [],
              },
            ],
            relations: [],
          });
        return JSON.stringify(req === "items" ? { items: [] } : {});
      },
    );

  const deps = (c: FakeCompleter): TickDeps => ({
    ...tickDeps(
      {
        db: database.db,
        logger: quiet,
        completer: c,
        flags: { present: true, canvas: true },
        participantBaseUrl: "http://localhost:5174",
        adminBaseUrl: "http://localhost:5173",
        databaseUrl: "unused",
        analysis: () => NO_ANALYSIS,
      },
      newId(),
      NO_ANALYSIS,
    ),
    heartbeatMs: 1000,
  });

  // BYPASS D-P1: a conversation whose extraction keeps failing stays "changed" (its fingerprint
  // is not saved on error), so every later Analyse now re-analyses the whole session's views
  // and is refunded as "read nothing". The stakeholders slide is remade each time, uncounted.
  test("analyses that remade the stakeholders slide are each counted", async () => {
    const s = await seed(["popcorn", "stakeholders"]);
    await addConversation(s.projectId, "Table 1", "Table 1 says the ferry should run all night.");
    await addConversation(s.projectId, "Table 2", "BROKEN");
    let analysed = 0;
    for (let i = 0; i < 14; i++) {
      const c = completer();
      const got = await runPopcornTick(deps(c), s.loopId, "manual", newId());
      if (got.status === "no_op") break;
      expect(got.status).toBe("ok");
      if (c.calls.some((r) => required(r) === "stakeholders,relations")) analysed++;
    }
    const [loop] = await sql`select popcorn_state from agent_loop where id = ${s.loopId}`;
    const slide = (
      loop?.popcorn_state as { analysis?: { stakeholders?: { stakeholders?: unknown[] } } }
    )?.analysis?.stakeholders;
    expect(slide?.stakeholders?.length).toBe(2);
    // Every analysis that made the slide counts, so no more than 12 ran.
    expect(analysed).toBeLessThanOrEqual(12);
    expect(await ledger(s.projectId)).toBe(analysed);
  });

  // BYPASS D-P2: the generic analysis route runs the stakeholders and tensions recipes (and the
  // arguments recipe the map is made from) with no free allowance check at all.
  test("the analysis route refuses a stakeholders run once the 12 are used", async () => {
    const s = await seed(["popcorn", "stakeholders", "tensions"]);
    await addConversation(s.projectId, "Table 1", "Table 1 says the ferry should run all night.");
    await addConversation(s.projectId, "Table 2", "Table 2 says the bridge needs a cycle lane.");
    const pop = popcornAllowance(database.db);
    for (let i = 0; i < 12; i++) await pop.admit(s.projectId, new Date());
    expect(await ledger(s.projectId)).toBe(12);

    const access = {
      project: async (_who: unknown, projectId: string, _policy: Policy) => ({
        tier: "free",
        role: "owner",
        source: "workspace",
        extra: [],
        project: { id: projectId, isSample: false },
      }),
    } as unknown as Access;
    const dispatched: string[] = [];
    const jobs = {
      enqueue: async (def: { name: string }) => {
        dispatched.push(def.name);
        return newId();
      },
    };
    const app = new Hono();
    app.use(async (c, next) => {
      c.set("principal" as never, { appUserId: s.appUser, directusUserId: s.user } as never);
      await next();
    });
    app.onError((err, c) =>
      c.json(
        { code: (err as { code?: string }).code, details: (err as { details?: unknown }).details },
        ((err as { status?: number }).status ?? 500) as 402,
      ),
    );
    app.route(
      "/",
      analysisRoutes({
        db: database.db,
        access,
        limiter: new RateLimiter(new MemoryRateCounter()),
        logger: quiet,
        jobs: jobs as never,
        completer: new FakeCompleter(),
        embedder: new FakeEmbedder(),
        enablePresent: true,
        embeddingModel: "text-embedding-005",
        embeddingLocation: "europe-west4",
      }),
    );
    for (const recipe of ["stakeholders", "tensions"]) {
      const res = await app.request(`/api/v2/bff/analysis/projects/${s.projectId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipe_id: recipe, mode: "regenerate" }),
      });
      const body = (await res.json()) as { details?: { limit?: string } };
      expect({ recipe, status: res.status, limit: body.details?.limit }).toEqual({
        recipe,
        status: 402,
        limit: "popcorn",
      });
    }
    expect(dispatched).toEqual([]);
  });
});
