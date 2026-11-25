import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId, PlatformError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import postgres from "postgres";
import { bffConversationRoutes } from "../src/bff/routes";
import type { ConversationsDeps } from "../src/deps";
import { ParticipantTokens } from "../src/participant-token";
import { admin, freshDatabase, quiet } from "./pipeline-harness";

const run = admin ? describe : describe.skip;

// "Improving transcript" is shown for a conversation its provider improves, that has audio and
// is not so old that the job has given up. A deployment with one provider answers as it always
// has, a recording still in progress included; with several, the conversation's own provider
// says whether a pass will come. The API reads no job-queue table for it.
run("the dashboard's final transcript state", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  let deps: ConversationsDeps;
  const owner: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
  const [workspace, project] = [newId(), newId()];

  beforeAll(async () => {
    const url = await freshDatabase("conv_bff_final_test");
    const database = createDb({ url, poolMax: 3 });
    close = () => database.close();
    sql = postgres(url, { max: 2, onnotice: () => {} });
    const org = newId();
    const billing = newId();
    await sql`insert into app_user (id, directus_user_id, email) values (${owner.appUserId}, ${owner.directusUserId}, 'o@example.com')`;
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'innovator')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${workspace}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${workspace}, ${owner.appUserId}, 'owner')`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${project}, 'P', ${workspace}, true)`;
    deps = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      hub: null,
      jobs: { enqueue: async () => null },
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: quiet,
      tokens: new ParticipantTokens("t".repeat(48), false),
      // Whatever the conversation's provider would improve today, as the Scaleway kit does.
      settings: { improves: { recordings: true, uploads: true } },
      now: () => new Date(),
    } as unknown as ConversationsDeps;
    const d = deps;
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", owner);
      c.set("logger", quiet);
      await next();
    });
    app.route("/", bffConversationRoutes(d));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ code: err.code, detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  afterAll(async () => {
    await sql.end();
    await close();
  });

  const recorded = async (
    o: { finished?: boolean; ageHours?: number; audio?: boolean; provider?: string } = {},
  ) => {
    const id = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, is_finished, ai_transcription_provider, created_at, updated_at)
      values (${id}, ${project}, 'P', 'PORTAL_AUDIO', ${o.finished ?? true}, ${o.provider ?? null},
        now() - ${`${o.ageHours ?? 0} hours`}::interval, now())`;
    if (o.audio !== false)
      await sql`insert into conversation_chunk (id, conversation_id, path, timestamp, created_at)
        values (${newId()}, ${id}, 'audio/a.mp3', now(), now())`;
    return id;
  };
  const state = async (id: string) =>
    (await (await app.request(`/api/v2/bff/conversations/${id}/final-transcript`)).json()) as {
      available: boolean;
      expected: boolean;
    };
  const gaveUp = (id: string) =>
    sql`insert into processing_status (conversation_id, event, message, timestamp)
      values (${id}, 'task_final_transcript.gave_up', 'gave up', now())`;

  test("a recording still in progress is improving, as it is on a deployment with one provider", async () => {
    expect(await state(await recorded({ finished: false }))).toEqual({
      available: false,
      expected: true,
    });
  });

  test("a finished one with audio is improving, until the job gave up, and not once it is old or has no audio", async () => {
    expect(await state(await recorded())).toEqual({ available: false, expected: true });
    const failed = await recorded();
    await gaveUp(failed);
    expect(await state(failed)).toEqual({ available: false, expected: false });
    expect((await state(await recorded({ ageHours: 30 }))).expected).toBe(false);
    expect((await state(await recorded({ audio: false }))).expected).toBe(false);
  });

  test("with several providers, the conversation's own says whether a pass will come", async () => {
    const kit = (improves: boolean) => ({ improves: { recordings: improves, uploads: improves } });
    (deps as { speech?: unknown }).speech = {
      kits: { scaleway: kit(true), google: kit(false) },
      default: "scaleway",
      // As the database policy does for a conversation: the provider it began on.
      decide: async (who: { id: string }) => {
        const [c] =
          await sql`select ai_transcription_provider as p from conversation where id = ${who.id}`;
        return {
          provider: c?.p ?? "scaleway",
          job: "transcription",
          organisationId: null,
          reason: "conversation",
          allowed: null,
        };
      },
    } as unknown as ConversationsDeps["speech"];
    try {
      expect((await state(await recorded({ provider: "google" }))).expected).toBe(false);
      expect((await state(await recorded({ provider: "scaleway" }))).expected).toBe(true);
      expect((await state(await recorded())).expected).toBe(true);
    } finally {
      delete (deps as { speech?: unknown }).speech;
    }
  });
});
