import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate } from "@dembrane/db";
import { type CompletionRequest, FakeCompleter } from "@dembrane/llm";
import postgres from "postgres";
import { runPopcornTick, type TickDeps } from "../src/tick/run";
import { tickDeps } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";
import { freshDatabase } from "./fixtures/tick/seed";

// A read's memory follows the deck, never the deck times the conversations (prod, October
// 13th 2026: a shown-text set per conversation held 2 GB for an 850-conversation session
// and OOM-killed every worker). Needs a scratch Postgres: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

const CONVERSATIONS = 400;
const ids = {
  user: "d1000000-0000-4000-8000-000000000009",
  appUser: "a1000000-0000-4000-8000-000000000009",
  project: "f1000000-0000-4000-8000-000000000009",
  loop: "ca100000-0000-4000-8000-000000000009",
};
const conv = (i: number) => `c1100000-0000-4000-8000-${String(i).padStart(12, "0")}`;

// Words no two sentences share by chance, so every phrase adds runs of its own.
let seed = 7;
const SYL = ["ka", "lo", "mi", "ren", "tas", "vo", "bel", "dri", "nu", "sel", "par", "gon"];
const word = () =>
  Array.from({ length: 3 }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return SYL[seed % SYL.length];
  }).join("");
const sentence = (i: number) => `Table ${i} says ${Array.from({ length: 14 }, word).join(" ")}.`;
const said = (text: string) => text.match(/says [^.]+/g)?.map((s) => s.slice(5)) ?? [];

run("a read of a large session", () => {
  setDefaultTimeout(240_000);
  let database: ReturnType<typeof createDb>;
  let raw: postgres.Sql;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
  // Every phrase quoted from its transcript and confirmed; everything else answered empty.
  const fake = new FakeCompleter().on(
    () => true,
    (r: CompletionRequest) => {
      const user = typeof r.user === "string" ? r.user : r.user.join("\n");
      const required = ((r.jsonSchema as { required?: string[] })?.required ?? []).join(",");
      if (required === "items")
        return JSON.stringify({
          items: said(user)
            .slice(0, 15)
            .map((phrase) => ({ phrase })),
        });
      if (required === "grounded,quote,reason")
        return JSON.stringify({
          grounded: true,
          quote: user.trim().split("\n").pop(),
          reason: "said at the table",
        });
      return JSON.stringify({});
    },
  );
  const deps = (): TickDeps => ({
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
    heartbeatMs: 1000,
  });

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "popcorn_memory_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 6 });
    raw = postgres(url, { max: 2, onnotice: () => {} });
    await raw`insert into directus_users (id, email) values (${ids.user}, 'memory@example.com')`;
    await raw`insert into app_user (id, directus_user_id) values (${ids.appUser}, ${ids.user})`;
    await raw`insert into project (id, name, language, directus_user_id, is_conversation_allowed,
      is_canvas_enabled, anonymize_transcripts, visibility)
      values (${ids.project}, 'Memory', 'en', ${ids.user}, true, true, false, 'workspace')`;
    await raw`insert into project_report (id, project_id, kind, status, user_instructions, content, public_token, date_created)
      values (9, ${ids.project}, 'popcorn', 'published', '', '', 'memory-token', now())`;
    await raw`insert into canvas_config_revision (id, report_id, popcorn_settings, created_at, cadence_minutes)
      values (${crypto.randomUUID()}, 9, ${raw.json({ title: "Memory", presentation: { blocks: ["popcorn"] } })}, now(), 2)`;
    await raw`insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes,
      acting_directus_user_id, failure_count, caps, popcorn_state, created_at)
      values (${ids.loop}, ${ids.project}, 9, 'Memory', 'paused', '2026-09-01T09:00:00Z', 2, ${ids.user}, 0,
        ${raw.json({ kind: "popcorn" })}, ${raw.json({})}, now())`;
    for (let i = 1; i <= CONVERSATIONS + 1; i++) {
      const at = new Date(Date.UTC(2026, 9, 13, 9) + i * 1000).toISOString();
      const text = Array.from({ length: 16 }, () => sentence(i)).join(" ");
      await raw`insert into conversation (id, project_id, participant_name, created_at, duration)
        values (${conv(i)}, ${ids.project}, ${`Table ${i}`}, ${at}, 600)`;
      if (i <= CONVERSATIONS)
        await raw`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
          values (${crypto.randomUUID()}, ${conv(i)}, ${text}, ${at}, ${at})`;
    }
    // The deck a host's Analyse left: fifteen phrases on the stage from every conversation.
    expect((await runPopcornTick(deps(), ids.loop, "manual", crypto.randomUUID())).status).toBe(
      "ok",
    );
    const at = new Date().toISOString();
    await raw`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
      values (${crypto.randomUUID()}, ${conv(CONVERSATIONS + 1)}, ${sentence(CONVERSATIONS + 1)}, ${at}, ${at})`;
  });
  afterAll(async () => {
    await raw?.end();
    await database?.close();
  });

  test("a finished conversation's read holds memory like the deck, not the deck per conversation", async () => {
    const [row] =
      await raw`select pg_column_size(popcorn_state) as bytes from agent_loop where id = ${ids.loop}`;
    expect(Number(row?.bytes)).toBeGreaterThan(500_000);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 5);
    const got = await runPopcornTick(deps(), ids.loop, "finish", crypto.randomUUID(), [
      conv(CONVERSATIONS + 1),
    ]);
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    expect(got.status).toBe("ok");
    // A shown-text set per conversation grew the heap by 1.3 GB here, the whole-session read
    // a finished conversation used to start by 260 MB; this read stays near 100 MB.
    expect((peak - before) / 2 ** 20).toBeLessThan(200);
  });
});
