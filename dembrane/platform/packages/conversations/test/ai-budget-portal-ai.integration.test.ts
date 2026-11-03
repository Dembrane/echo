import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { Access } from "@dembrane/access";
import { AI_SPEND_KEY, allowanceForProject, invalidateFreeLimits } from "@dembrane/allowance";
import type { Media } from "@dembrane/audio";
import { errorBody, newId, PlatformError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { fakeCalls, takeUnscopedFakeCalls } from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FakeTranscriber } from "@dembrane/transcription";
import { Hono } from "hono";
import postgres from "postgres";
import type { ConversationsDeps } from "../src/deps";
import { ParticipantTokens } from "../src/participant-token";
import { conversationAudioRoutes } from "../src/v1/audio-routes";
import { conversationV1Routes } from "../src/v1/routes";
import { admin, fakeModels, freshDatabase, localBucket, quiet } from "./pipeline-harness";

// Explore refuses plainly at a used-up AI budget; retranscribe refuses with ai_budget.
const run = admin ? describe : describe.skip;
const LIMIT = 5_000_000;
const NOW = new Date();
const host: Signed = { appUserId: "a", directusUserId: "u", isStaff: false };

run("portal AI and retranscribe at the AI budget", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let database: ReturnType<typeof createDb>;
  let app: Hono<Env>;
  const bucket = localBucket();
  const enqueued: unknown[] = [];

  beforeAll(async () => {
    const url = await freshDatabase("conv_ai_budget_portal_test");
    database = createDb({ url, poolMax: 4 });
    sql = postgres(url, { max: 2, onnotice: () => {} });
    const d: ConversationsDeps = {
      db: database.db,
      // Access is not under test: every host reaches every project.
      access: { project: async () => ({}) } as unknown as Access,
      audio: bucket.storage,
      audioUrls: bucket.urls,
      jobs: {
        enqueue: async (...args: unknown[]) => {
          enqueued.push(args);
          return "run";
        },
      } as unknown as ConversationsDeps["jobs"],
      models: fakeModels("Tell me more about the chargers.").models,
      media: {} as Media,
      transcriber: new FakeTranscriber(),
      hub: null,
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: quiet,
      tokens: new ParticipantTokens("t".repeat(48), false),
      settings: {
        participantTokenRequired: false,
        monitorEnabled: false,
        webhooksEnabled: false,
        dashboardUrl: "http://dashboard.test",
      },
      now: () => NOW,
    };
    app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.set("principal", host);
      await next();
    });
    app.route("/", conversationV1Routes(d));
    app.route("/", conversationAudioRoutes(d));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json(errorBody(err), err.status as 400)
        : c.json({ detail: "Internal Server Error" }, 500),
    );
  });
  beforeEach(() => invalidateFreeLimits());
  afterAll(async () => {
    invalidateFreeLimits();
    bucket.server.stop(true);
    await sql?.end();
    await database?.close();
  });

  async function seed(spent: number) {
    const [org, billing, ws, project, conversation] = [newId(), newId(), newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, is_get_reply_enabled)
      values (${project}, 'P', 'en', ${ws}, true, true)`;
    await sql`insert into conversation (id, project_id, participant_name, created_at, updated_at)
      values (${conversation}, ${project}, 'R', now(), now())`;
    await sql`insert into conversation_chunk (id, conversation_id, transcript, path, timestamp, created_at, updated_at)
      values (${newId()}, ${conversation}, 'We need chargers.', 's3://x/a.mp3', now(), now(), now())`;
    const a = await allowanceForProject(database.db, project, NOW);
    if (!a) throw new Error("expected a free account");
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${billing}, ${a.periodStart.toISOString()}, ${AI_SPEND_KEY}, ${spent})`;
    return { project, conversation };
  }

  const reply = (conversation: string) =>
    app.request(`/api/conversations/${conversation}/get-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "en" }),
    });

  test("Explore at zero budget is refused plainly and calls no model", async () => {
    const { conversation } = await seed(LIMIT);
    takeUnscopedFakeCalls();
    const res = await reply(conversation);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "portal.ai_unavailable",
      detail: "Not available right now.",
      action: "none",
    });
    expect(JSON.stringify(body)).not.toMatch(/budget|plan|upgrade|tier|limit/i);
    expect(fakeCalls().length).toBe(0);
    const [n] =
      await sql`select count(*)::int as n from conversation_reply where conversation_id = ${conversation}`;
    expect(n?.n).toBe(0);
  });

  test("Explore below the limit still streams a reply", async () => {
    const { conversation } = await seed(LIMIT - 1);
    takeUnscopedFakeCalls();
    const text = await withPayer({ ref: "conversation", id: conversation }, async () => {
      const res = await reply(conversation);
      expect(res.status).toBe(200);
      return res.text();
    });
    expect(text).toContain("0:");
    expect(text).toContain("chargers");
    expect(fakeCalls().length).toBe(1);
  });

  test("retranscribe at zero budget is refused with ai_budget and clones nothing", async () => {
    const { project, conversation } = await seed(LIMIT);
    enqueued.length = 0;
    const res = await app.request(`/api/conversations/${conversation}/retranscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_conversation_name: "Again" }),
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      code: "billing.tier_limit",
      detail: { limit: "ai_budget" },
    });
    expect(enqueued).toEqual([]);
    const [n] =
      await sql`select count(*)::int as n from conversation where project_id = ${project} and source = 'CLONE'`;
    expect(n?.n).toBe(0);
  });
});
