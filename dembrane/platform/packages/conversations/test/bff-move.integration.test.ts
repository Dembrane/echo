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

// A conversation moves to another project in the same billing and data-ownership context,
// the rule project moves follow.
const run = admin ? describe : describe.skip;

run("BFF conversation move", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  const owner: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
  const [wsA, wsB, wsC] = [newId(), newId(), newId()];
  const [alpha, beta, gamma, delta, legacy] = [newId(), newId(), newId(), newId(), newId()];

  beforeAll(async () => {
    const url = await freshDatabase("conv_bff_move_test");
    const database = createDb({ url, poolMax: 3 });
    close = () => database.close();
    sql = postgres(url, { max: 2, onnotice: () => {} });
    const org = newId();
    await sql`insert into app_user (id, directus_user_id, email) values (${owner.appUserId}, ${owner.directusUserId}, 'o@example.com')`;
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    for (const ws of [wsA, wsB]) {
      const billing = newId();
      await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'innovator')`;
      await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
      await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner')`;
    }
    // Billed on its own, not through the org: a separate billing context.
    const own = newId();
    await sql`insert into billing_account (id, tier) values (${own}, 'innovator')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${wsC}, 'C', ${org}, ${own})`;
    await sql`update billing_account set workspace_id = ${wsC} where id = ${own}`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${wsC}, ${owner.appUserId}, 'owner')`;
    for (const [id, ws, name] of [
      [alpha, wsA, "Alpha"],
      [beta, wsA, "Beta"],
      [gamma, wsB, "Gamma"],
      [delta, wsC, "Delta"],
    ] as const) {
      await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${id}, ${name}, ${ws}, true)`;
    }
    await sql`insert into directus_users (id, email) values (${owner.directusUserId}, 'o@example.com')`;
    await sql`insert into project (id, name, directus_user_id, is_conversation_allowed) values (${legacy}, 'Legacy', ${owner.directusUserId}, true)`;
    const d = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      hub: null,
      jobs: { enqueue: async () => null },
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: quiet,
      tokens: new ParticipantTokens("t".repeat(48), false),
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

  const conversationIn = async (project: string) => {
    const id = newId();
    await sql`insert into conversation (id, project_id, participant_name, source, created_at, updated_at)
      values (${id}, ${project}, 'P', 'PORTAL_AUDIO', now(), now())`;
    return id;
  };
  const move = (id: string, target: string) =>
    app.request(`/api/v2/bff/conversations/${id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_project_id: target }),
    });
  const stored = async (id: string) =>
    (
      await sql<{ project_id: string; move_history: unknown[] | null }[]>`
        select project_id, move_history from conversation where id = ${id}`
    )[0];

  test("a move within the workspace lands and is recorded", async () => {
    const id = await conversationIn(alpha);
    const res = await move(id, beta);
    expect(res.status).toBe(200);
    const row = await stored(id);
    expect(row?.project_id).toBe(beta);
    expect(row?.move_history).toHaveLength(1);
  });

  test("a project in another workspace of the same billing context lands", async () => {
    const id = await conversationIn(alpha);
    const res = await move(id, gamma);
    expect(res.status).toBe(200);
    expect((await stored(id))?.project_id).toBe(gamma);
  });

  test("a workspace billed separately is refused and nothing moves", async () => {
    const id = await conversationIn(alpha);
    const res = await move(id, delta);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "conversation.move_context_mismatch",
    );
    expect(await stored(id)).toEqual({ project_id: alpha, move_history: null });
  });

  test("a legacy project outside any workspace is refused", async () => {
    const id = await conversationIn(alpha);
    const res = await move(id, legacy);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "conversation.move_context_mismatch",
    );
    expect(await stored(id)).toEqual({ project_id: alpha, move_history: null });
  });

  test("the conversation's own project is refused and no history is written", async () => {
    const id = await conversationIn(alpha);
    const res = await move(id, alpha);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("conversation.move_same_project");
    expect(await stored(id)).toEqual({ project_id: alpha, move_history: null });
  });

  test("nothing moves into or out of a sample project, whose conversations count toward no limit", async () => {
    const sample = newId();
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample)
      values (${sample}, 'Best practices (sample)', ${wsA}, false, true)`;
    const recorded = await conversationIn(alpha);
    const into = await move(recorded, sample);
    expect(into.status).toBe(400);
    expect(((await into.json()) as { code: string }).code).toBe("conversation.move_sample");
    expect(await stored(recorded)).toEqual({ project_id: alpha, move_history: null });
    const seeded = await conversationIn(sample);
    const out = await move(seeded, beta);
    expect(out.status).toBe(400);
    expect((await stored(seeded))?.project_id).toBe(sample);
  });

  test("the detail says whether a conversation is typed text only, as the list does", async () => {
    const typed = await conversationIn(alpha);
    const recorded = await conversationIn(alpha);
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, source, transcript, created_at, updated_at) values
      (${newId()}, ${typed}, now(), 'PORTAL_TEXT', 'hello', now(), now()),
      (${newId()}, ${recorded}, now(), 'PORTAL_AUDIO', null, now(), now())`;
    const detail = async (id: string) =>
      (
        (await (await app.request(`/api/v2/bff/conversations/${id}`)).json()) as Record<
          string,
          unknown
        >
      ).has_only_text_chunks;
    expect(await detail(typed)).toBe(true);
    expect(await detail(recorded)).toBe(false);
  });

  test("the list says which conversations still have chunks waiting for a transcript", async () => {
    const project = newId();
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${project}, 'Pending', ${wsA}, true)`;
    const [waiting, done, failed, empty] = [
      await conversationIn(project),
      await conversationIn(project),
      await conversationIn(project),
      await conversationIn(project),
    ];
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, source, transcript, error, created_at, updated_at) values
      (${newId()}, ${waiting}, now(), 'PORTAL_AUDIO', 'heard', null, now(), now()),
      (${newId()}, ${waiting}, now(), 'PORTAL_AUDIO', null, null, now(), now()),
      (${newId()}, ${done}, now(), 'PORTAL_AUDIO', 'heard', null, now(), now()),
      (${newId()}, ${failed}, now(), 'PORTAL_AUDIO', null, 'Audio not playable', now(), now())`;
    const rows = (await (
      await app.request(`/api/v2/bff/conversations?project_id=${project}`)
    ).json()) as { id: string; has_pending_chunks: unknown }[];
    const pending = Object.fromEntries(rows.map((r) => [r.id, r.has_pending_chunks]));
    expect(pending).toEqual({ [waiting]: true, [done]: false, [failed]: false, [empty]: false });
  });
});
