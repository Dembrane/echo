import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate } from "@dembrane/db";
import { type CompletionRequest, FakeCompleter } from "@dembrane/llm";
import postgres from "postgres";
import { runPopcornTick, type TickDeps } from "../src/tick/run";
import { NEIGHBOURS } from "../src/tick/scale";
import { tickDeps } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";
import { freshDatabase } from "./fixtures/tick/seed";

// A large session's tensions against Postgres: what each read asks the model.
// Needs a scratch Postgres: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

const N = 120;
const ids = {
  user: "d1000000-0000-4000-8000-00000000000a",
  appUser: "a1000000-0000-4000-8000-00000000000a",
  project: "f1000000-0000-4000-8000-00000000000a",
  loop: "ca100000-0000-4000-8000-00000000000a",
};
const conv = (i: number) => `c1100000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const TOPICS = [
  "night buses",
  "the market square",
  "rent levels",
  "tree planting",
  "the youth centre",
  "noise rules",
];
const sentence = (i: number, k: number) =>
  `Table ${i} says ${TOPICS[(i + k) % TOPICS.length]} ${k % 2 ? "must get more money" : "should be cut back"} number ${k}.`;

run("tensions of a large session", () => {
  setDefaultTimeout(240_000);
  let database: ReturnType<typeof createDb>;
  let raw: postgres.Sql;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const asked: { label: string; user: string }[] = [];
  const labelOf = (r: CompletionRequest) => {
    const req = ((r.jsonSchema as { required?: string[] } | undefined)?.required ?? []).join(",");
    if (req === "positions") return "positions";
    if (req === "collides") return "collisions";
    if (req === "collisions") return "collisions-batch";
    if (req.startsWith("valid")) return "verify";
    return req;
  };
  const fake = new FakeCompleter().on(
    () => true,
    (r: CompletionRequest) => {
      const user = typeof r.user === "string" ? r.user : r.user.join("\n");
      const label = labelOf(r);
      asked.push({ label, user });
      if (label === "positions") {
        const said = user.match(/Table \d+ says [^.]+/g) ?? [];
        return JSON.stringify({
          positions: said.slice(0, 2).map((s) => ({
            position: s.slice(s.indexOf("says ") + 5),
            holder: "a table",
            kind: "want",
            hedged: false,
            quote: s,
          })),
        });
      }
      return JSON.stringify({});
    },
  );
  const deps = (similar = true, collisionCalls?: number): TickDeps => ({
    ...tickDeps(
      {
        db: database.db,
        logger: quiet,
        completer: fake,
        flags: { present: true, canvas: true },
        participantBaseUrl: "http://localhost:5174",
        adminBaseUrl: "http://localhost:5173",
        databaseUrl: "unused",
        analysis: () => NO_ANALYSIS,
      },
      crypto.randomUUID(),
      NO_ANALYSIS,
    ),
    // Words as vectors: positions on one topic are each other's neighbours.
    similar: similar
      ? async (_projectId, texts) =>
          new Map(texts.map((t) => [t, TOPICS.map((topic) => (t.includes(topic) ? 1 : 0.01))]))
      : null,
    heartbeatMs: 1000,
    ...(collisionCalls !== undefined && { collisionCalls }),
  });
  const addConversation = async (i: number, sentences = 4) => {
    const at = new Date(Date.UTC(2026, 9, 13, 9) + i * 1000).toISOString();
    await raw`insert into conversation (id, project_id, participant_name, created_at, duration)
      values (${conv(i)}, ${ids.project}, ${`Table ${i}`}, ${at}, 600) on conflict do nothing`;
    const text = Array.from({ length: sentences }, (_, k) => sentence(i, k)).join(" ");
    await raw`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
      values (${crypto.randomUUID()}, ${conv(i)}, ${text}, ${at}, ${at})`;
  };
  const read = async (
    kind: string,
    finished: string[] | null = null,
    similar = true,
    collisionCalls?: number,
  ) => {
    const from = asked.length;
    const out = await runPopcornTick(
      deps(similar, collisionCalls),
      ids.loop,
      kind,
      crypto.randomUUID(),
      finished,
    );
    const calls = asked.slice(from);
    const by = (label: string) => calls.filter((c) => c.label === label);
    return { out, calls, by };
  };

  const cache = async () => {
    const [row] = await raw`select cache from popcorn_tensions_cache where loop_id = ${ids.loop}`;
    return row?.cache as { positions: Record<string, unknown> } | undefined;
  };

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "popcorn_large_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 6 });
    raw = postgres(url, { max: 2, onnotice: () => {} });
    await raw`insert into directus_users (id, email) values (${ids.user}, 'large@example.com')`;
    await raw`insert into app_user (id, directus_user_id) values (${ids.appUser}, ${ids.user})`;
    await raw`insert into project (id, name, language, directus_user_id, is_conversation_allowed,
      is_canvas_enabled, anonymize_transcripts, visibility)
      values (${ids.project}, 'Large', 'en', ${ids.user}, true, true, false, 'workspace')`;
    await raw`insert into project_report (id, project_id, kind, status, user_instructions, content, public_token, date_created)
      values (10, ${ids.project}, 'popcorn', 'published', '', '', 'large-token', now())`;
    await raw`insert into canvas_config_revision (id, report_id, popcorn_settings, created_at, cadence_minutes)
      values (${crypto.randomUUID()}, 10, ${raw.json({
        title: "Large",
        presentation: { blocks: ["popcorn", "tensions"] },
      })}, now(), 2)`;
    await raw`insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes,
      acting_directus_user_id, failure_count, caps, popcorn_state, created_at)
      values (${ids.loop}, ${ids.project}, 10, 'Large', 'paused', '2026-09-01T09:00:00Z', 2, ${ids.user}, 0,
        ${raw.json({ kind: "popcorn" })}, ${raw.json({})}, now())`;
    for (let i = 1; i <= N; i++) await addConversation(i);
  });
  afterAll(async () => {
    await raw?.end();
    await database?.close();
  });

  test("the first Analyse asks every conversation's positions once, the next one none", async () => {
    const first = await read("manual");
    expect(first.out.status).toBe("ok");
    expect(first.by("positions").length).toBe(N);
    await addConversation(N + 1);
    const second = await read("manual");
    expect(second.by("positions").length).toBe(1);
    expect(second.by("positions")[0]?.user).toContain(conv(N + 1));
  });

  test("a conversation finishing in a paused large session gets its positions then, and Analyse asks none", async () => {
    await addConversation(N + 2);
    const finish = await read("finish", [conv(N + 2)]);
    expect(finish.by("positions").length).toBe(1);
    expect(finish.by("collisions-batch").length + finish.by("collisions").length).toBe(0);
    const analyse = await read("manual");
    expect(analyse.by("positions").length).toBe(0);
  });

  test("the deck's state does not carry what the tensions keep", async () => {
    const [row] = await raw`select popcorn_state from agent_loop where id = ${ids.loop}`;
    expect(Object.keys(row?.popcorn_state as object)).not.toContain("tensions_cache");
    expect(Object.keys((await cache())?.positions ?? {}).length).toBeGreaterThan(N);
  });

  test("a changed transcript is read again", async () => {
    await raw`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
      values (${crypto.randomUUID()}, ${conv(3)}, ${sentence(3, 9)}, now(), now())`;
    const again = await read("manual");
    expect(again.by("positions").map((c) => c.user.includes(conv(3)))).toEqual([true]);
  });

  test("collisions ask ten positions a call over their nearest, and a later read only new ones", async () => {
    // Every position unasked, and a new conversation so the read has work.
    await raw`delete from popcorn_tensions_cache where loop_id = ${ids.loop}`;
    await addConversation(N + 3);
    const first = await read("manual");
    const batches = first.by("collisions-batch");
    expect(first.by("collisions").length).toBe(0);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.length).toBeLessThanOrEqual(Math.ceil((2 * (N + 3)) / 10));
    // Each batch lists its focal ten and their nearest, never the whole session.
    for (const b of batches)
      expect(b.user.split("\n").filter((l) => /^P\d+ /.test(l)).length).toBeLessThanOrEqual(
        10 + 10 * NEIGHBOURS,
      );
    await addConversation(N + 4);
    const next = await read("manual");
    expect(next.by("collisions-batch").length).toBe(1);
    expect(next.by("collisions-batch")[0]?.user).toMatch(/FOCAL POSITIONS: P\d+(, P\d+)?$/);
  });

  test("without embeddings the listing is every position, still batched", async () => {
    await addConversation(N + 5);
    const next = await read("manual", null, false);
    const batch = next.by("collisions-batch");
    expect(batch.length).toBe(1);
    expect(batch[0]?.user.split("\n").filter((l) => /^P\d+ /.test(l)).length).toBeGreaterThan(N);
  });

  test("a vanished conversation leaves the cache", async () => {
    await raw`update conversation set deleted_at = now() where id = ${conv(5)}`;
    const next = await read("manual");
    expect(next.out.status).toBe("ok");
    expect(Object.keys((await cache())?.positions ?? {})).not.toContain(conv(5));
  });

  test("a rerun asks about every position again", async () => {
    const again = await read("rerun");
    expect(again.by("positions").length).toBeGreaterThan(N - 5);
    expect(again.by("collisions-batch").length).toBeGreaterThan(5);
  });

  test("a large session's Analyse stays within its budget", async () => {
    await raw`delete from popcorn_tensions_cache where loop_id = ${ids.loop}`;
    await addConversation(N + 6);
    const first = await read("manual");
    const tokens = (cs: readonly { user: string }[]) =>
      cs.reduce((n, c) => n + c.user.length / 4, 0);
    const positions = first.by("positions").length;
    const collisions = (r: typeof first) => [...r.by("collisions"), ...r.by("collisions-batch")];
    // A tenth as many collisions calls as positions, each a small listing.
    expect(collisions(first).length).toBeLessThanOrEqual(Math.ceil(positions / 10) + 1);
    expect(tokens(collisions(first))).toBeLessThan(150_000);
    await addConversation(N + 7);
    const next = await read("manual");
    const asked = next.calls.filter((c) =>
      ["positions", "collisions", "collisions-batch"].includes(c.label),
    );
    expect(asked.length).toBeLessThanOrEqual(2);
  });

  test("positions past the ceiling are asked by the next Analyse, with nothing else changed", async () => {
    await raw`delete from popcorn_tensions_cache where loop_id = ${ids.loop}`;
    await addConversation(N + 8);
    const first = await read("manual", null, true, 2);
    expect(first.by("collisions-batch").length).toBe(2);
    const again = await read("manual", null, true, 2);
    expect(again.out.status).toBe("ok");
    expect(again.by("collisions-batch").length).toBe(2);
    expect(again.by("positions").length).toBe(0);
  });

  test("a deleted conversation leaves the cache at the next read, even a finish read", async () => {
    expect(Object.keys((await cache())?.positions ?? {})).toContain(conv(7));
    await raw`update conversation set deleted_at = now() where id = ${conv(7)}`;
    await addConversation(N + 9);
    await read("finish", [conv(N + 9)]);
    expect(Object.keys((await cache())?.positions ?? {})).not.toContain(conv(7));
  });

  test("when every conversation is gone, nothing derived from them stays", async () => {
    await raw`update conversation set deleted_at = now() where project_id = ${ids.project}`;
    await read("manual");
    expect(await cache()).toBeUndefined();
  });

  test("a cache that cannot be saved does not fail the read", async () => {
    // The session large again after the test that deleted everything.
    await raw`update conversation set deleted_at = null where project_id = ${ids.project}`;
    await addConversation(N + 20);
    const d = deps();
    const failing = {
      ...d,
      store: { ...d.store, saveTensionsCache: async () => Promise.reject(new Error("db blip")) },
    };
    const [before] = await raw`select failure_count from agent_loop where id = ${ids.loop}`;
    const out = await runPopcornTick(failing, ids.loop, "manual", crypto.randomUUID());
    expect(out.status).toBe("ok");
    const [after] = await raw`select failure_count from agent_loop where id = ${ids.loop}`;
    expect(after?.failure_count).toBe(before?.failure_count);
  });

  test("a read with no tensions work neither loads nor rewrites the cache", async () => {
    const d = deps();
    const io: string[] = [];
    const watched = {
      ...d,
      store: {
        ...d.store,
        tensionsCache: async (id: string) => {
          io.push("load");
          return d.store.tensionsCache(id);
        },
        saveTensionsCache: async (id: string, c: never, now: string) => {
          io.push("save");
          return d.store.saveTensionsCache(id, c, now);
        },
      },
    };
    // The kept cache up to date, then nothing changed: a no-op.
    const stale = () =>
      raw`update agent_loop set popcorn_state = jsonb_set(popcorn_state::jsonb, '{analysis,fingerprints}', '{}') where id = ${ids.loop}`;
    await stale();
    expect((await runPopcornTick(d, ids.loop, "manual", crypto.randomUUID())).status).toBe("ok");
    expect((await runPopcornTick(watched, ids.loop, "manual", crypto.randomUUID())).status).toBe(
      "no_op",
    );
    expect(io).toEqual([]);
    // The slides stale but nothing new to ask: the tensions run and keep nothing new.
    await stale();
    expect((await runPopcornTick(watched, ids.loop, "manual", crypto.randomUUID())).status).toBe(
      "ok",
    );
    expect(io).toEqual(["load"]);
  });
});
