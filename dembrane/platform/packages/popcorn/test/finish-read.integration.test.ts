import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import { type CompletionRequest, FakeCompleter } from "@dembrane/llm";
import postgres from "postgres";
import type { Json } from "../src/py";
import { runPopcornTick, type TickDeps } from "../src/tick/run";
import { tickDeps } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";
import { fixture, freshDatabase, ids, insertChunk, seed } from "./fixtures/tick/seed";

// A finish read outside a live session reads the conversations that finished and nothing
// session-wide (prod, October 13th 2026: one finish re-read 794 conversations' analysis).
// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

const [first, second] = fixture.seed.conversation?.map((c) => String(c.id)) ?? [];
const SESSION_WIDE = [
  "positions",
  "collisions",
  "tension-verify",
  "tension-write",
  "tensions-handed",
];

/** The fixture's recorded answers, and the name of the prompt behind every request. */
function recorded() {
  const answers = new Map<string, Json>();
  const names = new Map<string, string>();
  for (const t of fixture.ticks)
    for (const c of t.calls) {
      answers.set(`${c.system}\u0000${c.user}`, c.answer);
      names.set(c.system, c.name);
    }
  const fake = new FakeCompleter().on(
    () => true,
    (r: CompletionRequest) => {
      if (names.get(r.system ?? "") === "popcorn-translate") {
        const p = JSON.parse(r.user as string) as { texts: { i: number; text: string }[] };
        return JSON.stringify({
          translations: p.texts.map((t) => ({ i: t.i, text: `NL ${t.text}` })),
        });
      }
      const answer = answers.get(`${r.system}\u0000${r.user as string}`);
      if (!answer) throw new Error("no recorded answer");
      return JSON.stringify(answer);
    },
  );
  const asked = (from: number) =>
    [...new Set(fake.calls.slice(from).map((r) => names.get(r.system ?? "") ?? "unknown"))].sort();
  return { fake, asked };
}

run("a finish read outside a live session", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let raw: postgres.Sql;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const { fake, asked } = recorded();
  const maps: string[] = [];
  let afterFirstRead: Json = {};

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "popcorn_finish_read_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 6 });
    raw = postgres(url, { max: 2, onnotice: () => {} });
    await seed(raw);
    // The map shows in the room, beside every analysis view.
    await raw`update canvas_config_revision set popcorn_settings =
      popcorn_settings::jsonb || ${raw.json({
        presentation: { blocks: ["popcorn", "tensions", "stakeholders", "map"] },
      })}`;
    // The session as a host's first Analyse left it, then the second conversation grows.
    const got = await runPopcornTick(deps(), ids.loop, "manual", newId());
    expect(got.status).toBe("ok");
    afterFirstRead = (await loop()).popcorn_state as Json;
    await insertChunk(raw, fixture.second_chunk);
    maps.length = 0;
  });
  afterAll(async () => {
    await raw?.end();
    await database?.close();
  });

  function deps(): TickDeps {
    return {
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
        newId(),
        NO_ANALYSIS,
      ),
      requestMap: async (projectId) => {
        maps.push(projectId);
      },
      heartbeatMs: 50,
    };
  }
  const loop = async () => (await raw`select * from agent_loop where id = ${ids.loop}`)[0] as Json;
  const fingerprints = async () => dict(dict((await loop()).popcorn_state).analysis).fingerprints;
  const dict = (v: unknown) => (v ?? {}) as Json;

  test("a conversation still recording is left alone when another one finishes", async () => {
    expect((await loop()).status).toBe("paused");
    const from = fake.calls.length;
    const got = await runPopcornTick(deps(), ids.loop, "finish", newId(), [first as string]);
    expect(got.status).toBe("no_op");
    expect(fake.calls.length).toBe(from);
    expect(maps).toEqual([]);
  });

  test("the finished conversation is read, the session-wide views and the map are not", async () => {
    const before = await fingerprints();
    const from = fake.calls.length;
    const got = await runPopcornTick(deps(), ids.loop, "finish", newId(), [second as string]);
    expect(got.status).toBe("ok");
    expect(String(got.run.detail)).toStartWith("run 2: 1 of 2 conversations re-read");
    const names = asked(from);
    expect(names).toContain("popcorn-v1.10");
    for (const n of [...SESSION_WIDE, "stakeholders-v0.9"]) expect(names).not.toContain(n);
    expect(await fingerprints()).toEqual(before);
    expect(maps).toEqual([]);
  });

  test("the host's Analyse then brings the views and the map up to date", async () => {
    const from = fake.calls.length;
    const got = await runPopcornTick(deps(), ids.loop, "manual", newId());
    expect(got.status).toBe("ok");
    expect(String(got.run.detail)).toStartWith("run 3: 0 of 2 conversations re-read");
    const names = asked(from);
    expect(names).toContain("positions");
    expect(names).not.toContain("popcorn-v1.10");
    expect(maps).toEqual([ids.project]);
    // Up to date: a second Analyse finds nothing to do.
    const again = await runPopcornTick(deps(), ids.loop, "manual", newId());
    expect(again.status).toBe("no_op");
    expect(maps).toEqual([ids.project]);
  });

  test("a live session reads the finished conversation and the whole session, as before", async () => {
    await raw`update agent_loop set status = 'active', expires_at = now() + interval '1 hour',
      popcorn_state = ${raw.json(afterFirstRead as never)} where id = ${ids.loop}`;
    maps.length = 0;
    const from = fake.calls.length;
    const got = await runPopcornTick(deps(), ids.loop, "finish", newId(), [second as string]);
    expect(got.status).toBe("ok");
    const names = asked(from);
    expect(names).toContain("popcorn-v1.10");
    expect(names).toContain("positions");
    expect(maps).toEqual([ids.project]);
  });

  test("a finish read does not list conversations it was not asked to read", async () => {
    await raw`update agent_loop set status = 'paused' where id = ${ids.loop}`;
    const [named, unread] = [newId(), newId()];
    for (const [cid, words] of [
      [named, "We want the market open late."],
      [unread, "We want the library open on Sundays."],
    ] as const) {
      await raw`insert into conversation (id, project_id, participant_name, created_at, duration)
        values (${cid}, ${ids.project}, 'Late table', now(), 60)`;
      await raw`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
        values (${newId()}, ${cid}, ${words}, now(), now())`;
    }
    // The named one is read and saved; the unread one must not show as being read.
    await runPopcornTick(deps(), ids.loop, "finish", newId(), [named]);
    const conversations = dict((await loop()).popcorn_state).conversations as Json;
    expect(Object.keys(conversations)).toContain(named);
    expect(Object.keys(conversations)).not.toContain(unread);
    await raw`update conversation set deleted_at = now() where id in ${raw([named, unread])}`;
  });

  // A session saved before the map fingerprint existed: its map is as current as its last read.
  test("a session from before the map fingerprint asks for no map until something changes", async () => {
    await raw`update agent_loop set status = 'paused',
      popcorn_state = popcorn_state::jsonb - 'map_fingerprint' where id = ${ids.loop}`;
    maps.length = 0;
    expect((await runPopcornTick(deps(), ids.loop, "manual", newId())).status).toBe("no_op");
    expect(maps).toEqual([]);
  });

  test("a map that cannot be asked for does not keep every read going", async () => {
    await raw`update agent_loop set status = 'paused',
      popcorn_state = jsonb_set(popcorn_state::jsonb, '{map_fingerprint}', '"stale"') where id = ${ids.loop}`;
    const failing = { ...deps(), requestMap: async () => Promise.reject(new Error("map down")) };
    expect((await runPopcornTick(failing, ids.loop, "manual", newId())).status).toBe("ok");
    expect((await runPopcornTick(failing, ids.loop, "manual", newId())).status).toBe("no_op");
    await raw`update agent_loop set popcorn_state = jsonb_set(popcorn_state::jsonb, '{map_fingerprint}', '"stale"') where id = ${ids.loop}`;
    const none = { ...deps(), requestMap: null };
    expect((await runPopcornTick(none, ids.loop, "manual", newId())).status).toBe("no_op");
  });

  test("a small session that loses a conversation keeps no tensions cache", async () => {
    await raw`update agent_loop set status = 'paused' where id = ${ids.loop}`;
    const gone = newId();
    await raw`insert into conversation (id, project_id, participant_name, created_at, duration)
      values (${gone}, ${ids.project}, 'Short table', now(), 60)`;
    await raw`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
      values (${newId()}, ${gone}, 'We want more benches in the park.', now(), now())`;
    await runPopcornTick(deps(), ids.loop, "finish", newId(), [gone]);
    expect(Object.keys(dict(dict((await loop()).popcorn_state).conversations))).toContain(gone);
    await raw`update conversation set deleted_at = now() where id = ${gone}`;
    await runPopcornTick(deps(), ids.loop, "finish", newId(), [first as string]);
    const rows = await raw`select 1 from popcorn_tensions_cache where loop_id = ${ids.loop}`;
    expect(rows.length).toBe(0);
  });
});
