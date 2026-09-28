import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createDb, migrate } from "@dembrane/db";
import { type CompletionRequest, FakeCompleter } from "@dembrane/llm";
import postgres from "postgres";
import type { Json } from "../src/py";
import { reconcileMissingTicks, runPopcornTick, type TickDeps } from "../src/tick/run";
import { tickDeps, tickWorkflowId } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";
import {
  type Call,
  fixture,
  freshDatabase,
  ids,
  insertChunk,
  seed,
  type Tick,
} from "./fixtures/tick/seed";

// The whole tick against Postgres, answered by the model answers the Python tick recorded
// when it ran over the same rows (fixtures/tick/gen/tick_full.py). A request the Python
// never made, or made with other words, has no answer and fails the tick.
// Needs a scratch Postgres with pgvector: TEST_DATABASE_ADMIN_URL=postgres://u:p@host:5432/postgres
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

/**
 * Answers exactly the requests the Python made, and checks the knobs it set on each. A
 * translation batch holds whatever texts were owed when it went out, which depends on the
 * order the second passes finished in; it is answered by the rule the Python's script used
 * ("NL " before each text), and the texts it asked for are compared as a set.
 */
function recorded(ticks: readonly Tick[], translated: string[] = []) {
  const answers = new Map<string, Call>();
  let translate: Call | undefined;
  for (const t of ticks)
    for (const c of t.calls) {
      answers.set(`${c.system}\u0000${c.user}`, c);
      if (c.name === "popcorn-translate") translate = c;
    }
  const fake = new FakeCompleter();
  fake.on(
    () => true,
    (r: CompletionRequest) => {
      if (translate && r.system === translate.system) {
        expect(r.maxTokens).toBe(translate.max_tokens);
        expect(r.thinkingBudget).toBe(0);
        const payload = JSON.parse(r.user as string) as {
          target: string;
          texts: { i: number; text: string }[];
        };
        translated.push(...payload.texts.map((t) => `${payload.target}|${t.text}`));
        return JSON.stringify({
          translations: payload.texts.map((t) => ({ i: t.i, text: `NL ${t.text}` })),
        });
      }
      const call = answers.get(`${r.system}\u0000${r.user as string}`);
      if (!call) throw new Error(`no recorded answer: ${String(r.user).slice(0, 200)}`);
      expect(r.maxTokens).toBe(call.max_tokens);
      expect(r.thinkingBudget).toBe(call.fast ? 0 : undefined);
      expect(r.temperature).toBe(0);
      expect(r.group).toBe("multi_modal_fast");
      return JSON.stringify(call.answer);
    },
  );
  return fake;
}

const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/;

/**
 * Two runs compared on what they mean: quote ids become the words they name (completion
 * order decides which id a quote gets, in Python as here), times become T, and the
 * outcome lines after the first are a set with their millisecond counts dropped.
 */
function canonical(state: Json): unknown {
  const byId = new Map<string, string>();
  for (const q of (state.quotes as Json[] | undefined) ?? [])
    byId.set(String(q.id), `Q[${q.transcript}] ${q.text}`);
  return walk(state, byId);
}

function walk(v: unknown, byId: ReadonlyMap<string, string>, key = ""): unknown {
  if (typeof v === "string") {
    if (TIME.test(v) && (key.endsWith("_at") || key === "tensions" || key === "stakeholders"))
      return "T";
    return v;
  }
  if (Array.isArray(v)) {
    const out = v.map((x) => walk(x, byId, key));
    if (key === "quoteIds") return out.map((q) => byId.get(String(q)) ?? q);
    if (key === "quotes")
      return [...out].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return out;
  }
  if (v && typeof v === "object") {
    const out: Json = {};
    for (const [k, x] of Object.entries(v as Json)) {
      if (k === "quoteId") out[k] = byId.get(String(x)) ?? x;
      else if (k === "id" && typeof x === "string" && byId.has(x) && key === "quotes")
        out[k] = byId.get(x);
      else out[k] = walk(x, byId, k);
    }
    return out;
  }
  return v;
}

function detailSet(detail: string) {
  const [first, ...rest] = detail.split("; ");
  return { first, rest: rest.map((s) => s.replace(/ in \d+ ms/g, " in N ms")).sort() };
}

const floats = (html: string) =>
  [...html.matchAll(/"(duration|stake|mentions|intensity|sentiment)": (-?[\d.]+)/g)]
    .map((m) => `${m[1]}=${m[2]}`)
    .sort();

run("popcorn tick against Postgres", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let raw: postgres.Sql;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "popcorn_tick_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 6 });
    raw = postgres(url, { max: 2, onnotice: () => {} });
    await seed(raw);
  });
  afterAll(async () => {
    await raw?.end();
    await database?.close();
  });

  function deps(completer: FakeCompleter, workflowId: string): TickDeps {
    return {
      ...tickDeps(
        {
          db: database.db,
          logger: quiet,
          completer,
          flags: { present: true, canvas: true },
          participantBaseUrl: "http://localhost:5174",
          adminBaseUrl: "http://localhost:5173",
          databaseUrl: "unused",
          analysis: () => NO_ANALYSIS,
        },
        workflowId,
        NO_ANALYSIS,
      ),
      heartbeatMs: 50,
    };
  }

  test("three reads leave the state, runs and saved runs the Python tick left", async () => {
    const translated: string[] = [];
    const completer = recorded(fixture.ticks, translated);
    for (const [i, expected] of fixture.ticks.entries()) {
      if (i === 1) await insertChunk(raw, fixture.second_chunk);
      translated.length = 0;
      const before = completer.calls.length;
      const workflowId = tickWorkflowId(expected.request_id, `t${i}`);
      const got = await runPopcornTick(
        deps(completer, workflowId),
        ids.loop,
        expected.kind,
        expected.request_id,
      );
      expect(got.status).toBe(expected.status);
      const askedPython = expected.calls
        .filter((c) => c.name === "popcorn-translate")
        .flatMap((c) => {
          const p = JSON.parse(c.user) as { target: string; texts: { text: string }[] };
          return p.texts.map((t) => `${p.target}|${t.text}`);
        });
      expect([...translated].sort()).toEqual(askedPython.sort());
      // Every other call the Python made, and no more.
      const judged = (calls: readonly { user: unknown }[]) =>
        calls
          .map((c) => String(c.user))
          .filter((u) => !u.startsWith('{"target"'))
          .sort();
      expect(judged(completer.calls.slice(before))).toEqual(judged(expected.calls));
      const [loop] = await raw`select * from agent_loop where id = ${ids.loop}`;
      expect(canonical(loop?.popcorn_state as Json)).toEqual(canonical(expected.state));
      expect(loop?.status).toBe(expected.loop.status);
      expect(loop?.failure_count).toBe(expected.loop.failure_count);
      expect(got.run.status).toBe(expected.run.status);
      expect(detailSet(String(got.run.detail))).toEqual(detailSet(String(expected.run.detail)));
      if (expected.request_id) expect(got.run.id).toBe(expected.request_id);
      const [version] = await raw`select * from canvas_generation order by created_at desc limit 1`;
      const want = expected.version as Json;
      expect(version?.tick_kind).toBe(want.tick_kind);
      expect(detailSet(String(version?.detail))).toEqual(detailSet(String(want.detail)));
      const html = String(version?.content_html);
      const wantHtml = String(want.content_html);
      expect(floats(html)).toEqual(floats(wantHtml));
      const files = (s: string) => {
        const parsed = JSON.parse(s) as { files: Json };
        const quotes = ((parsed.files["quotes.json"] as Json | undefined)?.quotes ?? []) as Json[];
        return canonical({ ...parsed.files, quotes });
      };
      expect(files(html)).toEqual(files(wantHtml));
      // The request ids this read booked and cancelled, by shape: the Python's rows too.
      const tasks = await raw`select payload, status from scheduled_task order by created_at`;
      const shape = (rows: readonly Json[]) =>
        rows.map((t) => `${t.status}:${JSON.stringify((t.payload as Json).tick_kind)}`).sort();
      expect(shape(tasks as unknown as Json[])).toEqual(shape(expected.tasks));
    }
    // A delivered request asked for again is a no-op that reads nothing.
    const again = recorded(fixture.ticks);
    const second = fixture.ticks[1] as Tick;
    const dup = await runPopcornTick(
      deps(again, tickWorkflowId(second.request_id)),
      ids.loop,
      "manual",
      second.request_id,
    );
    expect(dup.status).toBe("duplicate");
    expect(again.calls.length).toBe(0);
  });

  test("a scheduled read of a paused loop is a no-op, and a held lease turns a read away", async () => {
    const fake = recorded(fixture.ticks);
    const paused = await runPopcornTick(deps(fake, "w-scheduled"), ids.loop, "scheduled");
    expect(paused.status).toBe("no_op");
    expect(paused.run.detail).toBe("Loop is paused");
    await raw`insert into platform_rate_limit (key, count, reset_at)
      values (${`popcorn:run:${ids.loop}`}, 1, now() + interval '5 minutes')`;
    await raw`update agent_loop set status = 'active', expires_at = now() + interval '1 hour' where id = ${ids.loop}`;
    const held = await runPopcornTick(deps(fake, "w-held"), ids.loop, "scheduled");
    expect(held.status).toBe("duplicate");
    expect(held.run.detail).toBe("A tick is already running");
    await raw`delete from platform_rate_limit where key = ${`popcorn:run:${ids.loop}`}`;
  });

  test("the reconciler books one read for a live loop that lost its row", async () => {
    await raw`update scheduled_task set status = 'completed' where task_type = 'popcorn_tick'`;
    const d = deps(recorded(fixture.ticks), "w-reconcile");
    expect(await reconcileMissingTicks(d)).toBe(1);
    expect(await reconcileMissingTicks(d)).toBe(0);
    const [task] = await raw`select payload from scheduled_task where status = 'scheduled'`;
    expect(task?.payload).toEqual({ loop_id: ids.loop, tick_kind: "scheduled" });
  });
});
