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

// "Improving transcript" is shown only while a final pass is queued or running for the
// conversation; one that ended on a provider that improves nothing is never promised one.
run("the dashboard's final transcript state", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let app: Hono<Env>;
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
    const d = {
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

  const recorded = async () => {
    const id = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, is_finished, created_at, updated_at)
      values (${id}, ${project}, 'P', 'PORTAL_AUDIO', true, now(), now())`;
    await sql`insert into conversation_chunk (id, conversation_id, path, timestamp, created_at)
      values (${newId()}, ${id}, 'audio/a.mp3', now(), now())`;
    return id;
  };
  const state = async (id: string) =>
    (await (await app.request(`/api/v2/bff/conversations/${id}/final-transcript`)).json()) as {
      available: boolean;
      expected: boolean;
    };
  const workflow = (id: string, status: string) =>
    sql`insert into dbos.workflow_status (workflow_uuid, status, name, created_at, updated_at)
      values (${`conversations.final-transcript:${id}:whisper:h`}, ${status}, 'conversations.final-transcript', 0, 0)`;

  test("a conversation that finished without a final pass is not said to be improving", async () => {
    const id = await recorded();
    expect(await state(id)).toEqual({ available: false, expected: false });
  });

  test("one with a final pass queued or running is, and not once it has ended", async () => {
    const queued = await recorded();
    await workflow(queued, "ENQUEUED");
    expect(await state(queued)).toEqual({ available: false, expected: true });
    const running = await recorded();
    await workflow(running, "PENDING");
    expect(await state(running)).toEqual({ available: false, expected: true });
    const ended = await recorded();
    await workflow(ended, "ERROR");
    expect(await state(ended)).toEqual({ available: false, expected: false });
  });
});
