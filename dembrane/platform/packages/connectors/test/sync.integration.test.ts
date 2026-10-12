import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId, PlatformError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import type { EnqueueOptions, JobDefinition } from "@dembrane/queue";
import { Hono } from "hono";
import postgres from "postgres";
import { admin, freshDatabase, quiet } from "../../conversations/test/pipeline-harness";
import type { Miro, MiroBoard, MiroFrame, MiroItem, MiroTokens } from "../src/miro";
import { connectorDeps, connectorRoutes } from "../src/routes";
import { tokenSealer } from "../src/seal";
import type { ConnectorDeps } from "../src/service";
import { runSync } from "../src/sync";

// A board's frames through the routes and the sync, against a real database and a fake Miro.
const run = admin ? describe : describe.skip;

const KEY = Buffer.alloc(32, 3).toString("base64");
const BOARD = "uXjVboard1=";
const PROJECT = "c0000000-0000-4000-8000-0000000000c1";

class FakeMiro implements Miro {
  frameList: MiroFrame[] = [
    { id: "f1", title: "Goals", x: 0, y: 0 },
    { id: "f2", title: "Risks", x: 2000, y: 0 },
    { id: "f3", title: "Empty", x: 4000, y: 0 },
  ];
  items: Record<string, MiroItem[]> = {
    f1: [sticky("s2", 300, 0, "Fewer cars"), sticky("s1", 0, 0, "<p>Safe crossings</p>")],
    f2: [sticky("r1", 0, 0, "Budget &amp; timing")],
    f3: [],
  };
  refreshed = 0;
  async exchange(code: string): Promise<MiroTokens> {
    if (code !== "good") throw new Error("bad code");
    return tokens("access-1");
  }
  async refresh(): Promise<MiroTokens> {
    this.refreshed++;
    return tokens(`access-r${this.refreshed}`);
  }
  async team() {
    return { teamId: "T1", teamName: "Ministry design team" };
  }
  async boards(): Promise<MiroBoard[]> {
    return [{ id: BOARD, name: "Event design", url: `https://miro.com/app/board/${BOARD}/` }];
  }
  async board(_t: string, id: string) {
    return id === BOARD ? ((await this.boards())[0] ?? null) : null;
  }
  async frames() {
    return this.frameList;
  }
  async frameItems(_t: string, _b: string, frameId: string) {
    return this.items[frameId] ?? [];
  }
}

function sticky(id: string, x: number, y: number, text: string): MiroItem {
  return { id, type: "sticky_note", text, x, y, width: 100, height: 100 };
}
function tokens(access: string): MiroTokens {
  return {
    accessToken: access,
    refreshToken: "refresh-1",
    expiresIn: 3600,
    scope: "boards:read",
    teamId: "T1",
    userId: "u-miro",
  };
}

run("miro connector", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  let d: ConnectorDeps;
  const miro = new FakeMiro();
  const enqueued: { job: string; payload: Record<string, unknown>; opts?: EnqueueOptions }[] = [];
  const owner: Signed = { appUserId: newId(), directusUserId: newId(), isStaff: false };
  let principal: Signed | null = owner;

  beforeAll(async () => {
    const url = await freshDatabase("connectors_sync_test");
    const database = createDb({ url, poolMax: 3 });
    close = () => database.close();
    sql = postgres(url, { max: 2, onnotice: () => {} });
    // A legacy project (no workspace) its creator reaches by Directus id. The portal is
    // closed: inputs from other apps do not need it open.
    await sql`insert into directus_users (id) values (${owner.directusUserId})`;
    await sql`insert into app_user (id) values (${owner.appUserId})`;
    await sql`insert into project (id, name, language, directus_user_id, is_conversation_allowed)
      values (${PROJECT}, 'Street redesign', 'en', ${owner.directusUserId}, false)`;
    const deps = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      queue: {
        async enqueue<J extends JobDefinition>(def: J, payload: unknown, opts?: EnqueueOptions) {
          enqueued.push({
            job: def.name,
            payload: payload as Record<string, unknown>,
            ...(opts && { opts }),
          });
          return "run";
        },
      },
      logger: quiet,
      miro,
      miroClientId: "client-1",
      sealer: tokenSealer(KEY),
      stateSecret: "s".repeat(48),
      publicUrl: "https://api.test",
      dashboardUrl: "https://dashboard.test",
    };
    d = connectorDeps(deps);
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", principal);
      await next();
    });
    app.route("/", connectorRoutes(deps));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  afterAll(async () => {
    await sql.end();
    await close();
  });

  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  async function connect() {
    const auth = (await (
      await app.request(`/api/projects/${PROJECT}/connectors/miro/authorize`)
    ).json()) as { url: string };
    const u = new URL(auth.url);
    expect(u.origin + u.pathname).toBe("https://miro.com/oauth/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://api.test/api/connectors/miro/callback",
    );
    expect(u.searchParams.get("scope")).toBe("boards:read");
    return u.searchParams.get("state") as string;
  }

  test("a callback from someone other than who started it does not connect", async () => {
    const state = await connect();
    principal = { appUserId: newId(), directusUserId: newId(), isStaff: false };
    const res = await app.request(`/api/connectors/miro/callback?code=good&state=${state}`);
    principal = owner;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("status=expired");
    const [conns] = await sql<{ n: number }[]>`select count(*)::int as n from connector_connection`;
    expect(conns?.n).toBe(0);
  });

  test("connecting stores sealed tokens and returns to the dashboard", async () => {
    const state = await connect();
    const res = await app.request(`/api/connectors/miro/callback?code=good&state=${state}`);
    expect(res.headers.get("location")).toBe(
      "https://dashboard.test/?connector=miro&status=connected",
    );
    const [row] = await sql`select * from connector_connection`;
    expect(row?.account_id).toBe("T1");
    expect(row?.account_name).toBe("Ministry design team");
    expect(row?.access_token).not.toContain("access-1");
    const list = (await (await app.request("/api/connectors")).json()) as { connected: boolean }[];
    expect(list[0]).toMatchObject({ provider: "miro", configured: true, connected: true });
  });

  let sourceId = "";
  test("a source keeps only frames on the board and queues a sync", async () => {
    const res = await json("POST", `/api/projects/${PROJECT}/connector-sources`, {
      provider: "miro",
      board: `https://miro.com/app/board/${BOARD}/?share_link_id=9`,
      frame_ids: ["f1", "f2", "f3", "not-on-board"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; frame_ids: string[]; voice: string };
    expect(body.frame_ids).toEqual(["f1", "f2", "f3"]);
    expect(body.voice).toBe("organisers");
    sourceId = body.id;
    expect(enqueued.at(-1)).toMatchObject({ job: "connectors.sync", payload: { sourceId } });
  });

  test("a sync writes one organiser-voice input per frame with words, in reading order", async () => {
    enqueued.length = 0;
    expect(await runSync(d, sourceId)).toEqual({ written: 2, unchanged: 0, removed: 0 });
    const convs =
      await sql`select * from conversation where connector_source_id = ${sourceId} order by title`;
    expect(convs.map((c) => [c.title, c.source, c.voice, c.external_ref])).toEqual([
      ["Goals", "MIRO", "organisers", "f1"],
      ["Risks", "MIRO", "organisers", "f2"],
    ]);
    expect(convs[0]?.origin).toMatchObject({
      provider: "miro",
      board_name: "Event design",
      url: `https://miro.com/app/board/${BOARD}/?moveToWidget=f1`,
      items: 2,
    });
    const chunks = await sql`select transcript from conversation_chunk
      where conversation_id = ${convs[0]?.id} order by timestamp`;
    expect(chunks.map((c) => c.transcript)).toEqual(["Safe crossings", "Fewer cars"]);
    // Each input's finish is queued in the transaction that wrote it.
    expect(enqueued.map((e) => e.job)).toEqual(["conversations.finish", "conversations.finish"]);
    expect(enqueued[0]?.opts?.tx).toBeDefined();
    const [src] =
      await sql`select status, last_synced_at from connector_source where id = ${sourceId}`;
    expect(src?.status).toBe("ok");
    expect(src?.last_synced_at).not.toBeNull();
  });

  test("a second sync leaves unchanged frames alone and rewrites a changed one", async () => {
    enqueued.length = 0;
    expect(await runSync(d, sourceId)).toEqual({ written: 0, unchanged: 2, removed: 0 });
    const [before] = await sql`select id from conversation where external_ref = 'f1'`;
    await sql`update conversation set is_finished = true, summary = 'old' where id = ${before?.id}`;
    miro.items.f1 = [sticky("s1", 0, 0, "Safe crossings near the school")];
    expect(await runSync(d, sourceId)).toEqual({ written: 1, unchanged: 1, removed: 0 });
    const [after] = await sql`select * from conversation where external_ref = 'f1'`;
    expect(after?.id).toBe(before?.id);
    expect(after?.is_finished).toBe(false);
    expect(after?.summary).toBeNull();
    const chunks =
      await sql`select transcript from conversation_chunk where conversation_id = ${after?.id}`;
    expect(chunks.map((c) => c.transcript)).toEqual(["Safe crossings near the school"]);
  });

  test("an expiring token is refreshed and the new one stored sealed", async () => {
    await sql`update connector_connection set expires_at = now() - interval '1 minute'`;
    await runSync(d, sourceId);
    expect(miro.refreshed).toBe(1);
    const [row] = await sql`select expires_at, access_token from connector_connection`;
    expect(new Date(row?.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(d.sealer?.open(row?.access_token)).toBe("access-r1");
  });

  test("dropping a frame from the source deletes its input", async () => {
    const res = await json("PATCH", `/api/projects/${PROJECT}/connector-sources/${sourceId}`, {
      frame_ids: ["f1"],
      voice: "mixed",
    });
    expect(res.status).toBe(200);
    expect(await runSync(d, sourceId)).toMatchObject({ removed: 1 });
    const rows =
      await sql`select external_ref from conversation where connector_source_id = ${sourceId}`;
    expect(rows.map((r) => r.external_ref)).toEqual(["f1"]);
    const list = (await (
      await app.request(`/api/projects/${PROJECT}/connector-sources`)
    ).json()) as { inputs: number; voice: string }[];
    expect(list[0]).toMatchObject({ inputs: 1, voice: "mixed" });
  });

  test("a disconnected source records why instead of syncing", async () => {
    expect((await app.request("/api/connectors/miro", { method: "DELETE" })).status).toBe(204);
    expect(await runSync(d, sourceId)).toBeNull();
    const [src] =
      await sql`select status, error, connection_id from connector_source where id = ${sourceId}`;
    expect(src).toMatchObject({ status: "error", error: "not_connected", connection_id: null });
  });

  test("removing the source removes its inputs and their chunks", async () => {
    const res = await app.request(`/api/projects/${PROJECT}/connector-sources/${sourceId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    const [left] = await sql`select
      (select count(*)::int from conversation where source = 'MIRO') as convs,
      (select count(*)::int from conversation_chunk where source = 'MIRO') as chunks`;
    expect(left).toMatchObject({ convs: 0, chunks: 0 });
  });

  test("an invalid voice is refused", async () => {
    const res = await json("POST", `/api/projects/${PROJECT}/connector-sources`, {
      provider: "miro",
      board: BOARD,
      frame_ids: ["f1"],
      voice: "residents",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("connector.invalid_voice");
  });
});
