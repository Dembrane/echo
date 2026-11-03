import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, createDb, migrate } from "@dembrane/db";
import type { ModelCall } from "@dembrane/llm";
import type postgres from "postgres";
import { type OverrideFile, priceBook, priceCall, priceStartup, syncPrices } from "../src";
import { loadOverrides } from "../src/prices/book";
import fixture from "./fixtures/models-dev.json";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `metering_sync_${process.pid}`;

const MODELS_DEV = "https://models.dev.test/api.json";
const ECB = "https://ecb.test/eurofxref-daily.xml";
const ecbXml = (usd: string) => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time='2026-11-02'><Cube currency='USD' rate='${usd}'/><Cube currency='JPY' rate='163.21'/></Cube></Cube>
</gesmes:Envelope>`;

type Fixture = typeof fixture;
const clone = (): Fixture => structuredClone(fixture);
const cost = (f: Fixture, model: string) =>
  (f["google-vertex"].models as Record<string, { cost: Record<string, unknown> }>)[model]
    ?.cost as Record<string, unknown>;

const logs: { level: string; msg: string }[] = [];
const logger = {
  info: (_o: unknown, msg?: string) => logs.push({ level: "info", msg: msg ?? "" }),
  warn: (_o: unknown, msg?: string) => logs.push({ level: "warn", msg: msg ?? "" }),
  error: (_o: unknown, msg?: string) => logs.push({ level: "error", msg: msg ?? "" }),
  debug() {},
} as never;

const configured = Object.keys(loadOverrides().models).sort();
const fromModelsDev = Object.entries(loadOverrides().models)
  .filter(([, e]) => "modelsDev" in e)
  .map(([k]) => k)
  .sort();
const day = new Date().toISOString().slice(0, 10);

run("price sync", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: ReturnType<typeof createDb>;
  let slack: ReturnType<typeof Bun.serve>;
  const posts: string[] = [];
  let slackUrl = "";

  const deps = (fetchText: (url: string) => Promise<string>) => ({
    db: db.db,
    fetchText,
    logger,
    slackUrl,
    modelsDevUrl: MODELS_DEV,
    ecbUrl: ECB,
    now: () => new Date(),
  });
  const serve =
    (f: unknown, usd = "1.0800") =>
    async (url: string) => {
      if (url === MODELS_DEV) return JSON.stringify(f);
      if (url === ECB) return ecbXml(usd);
      throw new Error(`unexpected ${url}`);
    };
  const offline = async (): Promise<string> => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const rows = () =>
    sql<{ provider: string; model: string }[]>`
      select * from ai_price order by provider, model, effective_from, id`;
  const fx = () => sql`select day::text, usd_to_eur::text, fetched_at from ai_fx_rate order by day`;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 1, onnotice: () => {} });
    db = createDb({ url, poolMax: 2 });
    slack = Bun.serve({
      port: 0,
      fetch: async (req) => {
        posts.push(((await req.json()) as { text: string }).text);
        return new Response("ok");
      },
    });
    slackUrl = `http://localhost:${slack.port}/hook`;
  });

  afterAll(async () => {
    slack?.stop(true);
    await sql?.end();
    await db?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("startup with no prices stored and models.dev unreachable logs an error and posts", async () => {
    const book = priceBook(db.db, logger);
    logs.length = 0;
    posts.length = 0;
    // The download hangs until released: startup returns on the loaded book without it.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated = async (): Promise<string> => {
      await gate;
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const started = await priceStartup(deps(gated), book, [
      "vertex/gemini-3.8-flash",
      "openai-compatible/glm-5.3",
    ]);
    expect(book.current().prices.size).toBe(0);
    expect(posts).toHaveLength(0);
    release();
    await started.settled;
    // Hand prices do not need the download; models.dev's models stay unpriced.
    expect(new Set((await rows()).map((r) => (r as { source?: string }).source))).toEqual(
      new Set(["override"]),
    );
    expect(book.current().prices.has("openai-compatible/glm-5.3")).toBe(true);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("vertex/gemini-3.8-flash");
    // The next sync prices it: no hand price is asked for, and hand prices are held now.
    expect(posts[0]).toContain("models.dev could not be read, so the next sync prices them");
    expect(posts[0]).not.toContain("hand price");
    expect(posts[0]).toContain("charged at the highest price held");
    expect(posts[0]).not.toContain("glm-5.3");
    expect(posts[0]).not.toContain("\u2014");
  });

  test("startup whose sync throws logs an error, posts, and does not throw", async () => {
    const broken = createDb({ url: "postgres://nobody:x@127.0.0.1:1/none", poolMax: 1 });
    logs.length = 0;
    posts.length = 0;
    const started = await priceStartup(
      { ...deps(serve(fixture)), db: broken.db },
      priceBook(broken.db, logger),
      ["vertex/gemini-3.8-flash"],
    );
    await started.settled;
    expect(logs.filter((l) => l.level === "error").length).toBeGreaterThanOrEqual(1);
    expect(posts.some((p) => p.startsWith("AI price sync failed at startup"))).toBe(true);
    await broken.close();
  });

  test("first sync stores one row per configured model and today's rate; a second stores nothing", async () => {
    posts.length = 0;
    const first = await syncPrices(deps(serve(fixture)));
    const stored = await rows();
    expect(stored.map((r) => `${r.provider}/${r.model}`).sort()).toEqual(configured);
    expect(first.changed.slice().sort()).toEqual(fromModelsDev);
    expect(first.rejected).toEqual([]);
    expect(first.fxChanged).toBe(true);
    const rate = await fx();
    expect(rate).toHaveLength(1);
    expect(rate[0]?.day).toBe(day);
    expect(Number(rate[0]?.usd_to_eur)).toBeCloseTo(1 / 1.08, 10);

    posts.length = 0;
    const second = await syncPrices(deps(serve(fixture)));
    expect(second).toEqual({ changed: [], rejected: [], fxChanged: false, sourceRead: true });
    expect(await rows()).toHaveLength(stored.length);
    expect(await fx()).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  test("an override's euro prices are stored as EUR with source override", async () => {
    const [glm] = await sql`
      select currency, source, input_per_m::float8 as input, output_per_m::float8 as output
      from ai_price where provider = 'openai-compatible' and model = 'glm-5.3'`;
    expect(glm).toEqual({ currency: "EUR", source: "override", input: 1.8, output: 5.5 });
    const [flash] = await sql`
      select currency, source from ai_price where model = 'gemini-3.8-flash'`;
    expect(flash).toEqual({ currency: "USD", source: "models.dev" });
  });

  test("the search lookup price lands on every row of its provider, and a stored-book lookup costs", async () => {
    const r = await sql<{ provider: string; q: number | null }[]>`
      select provider, per_search_query::float8 as q from ai_price`;
    for (const row of r)
      if (row.provider === "vertex") expect(row.q).toBe(0.014);
      else expect(row.q).toBeNull();

    const book = priceBook(db.db, logger);
    await book.reload();
    const call: ModelCall = {
      startedAt: new Date(),
      group: "text_fast",
      provider: "vertex",
      model: "gemini-3.8-flash",
      kind: "generate",
      status: "ok",
      error: null,
      finishReason: "stop",
      attempt: 1,
      fallback: false,
      ms: 10,
      inputTokens: null,
      cachedInputTokens: null,
      audioInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      audioSeconds: null,
      searchQueries: 1,
      usageEstimated: false,
    } as ModelCall;
    const priced = priceCall(call, book.current());
    expect(priced.priceMissing).toBe(false);
    expect(priced.costMicroEur).toBeGreaterThan(0);
  });

  test("a price that more than triples stores a new row and posts a large change", async () => {
    const f = clone();
    cost(f, "gemini-3.8-flash").input = 3;
    posts.length = 0;
    const res = await syncPrices(deps(serve(f)));
    expect(res.changed).toEqual(["vertex/gemini-3.8-flash"]);
    expect(res.rejected).toEqual([]);
    const flash = await sql`
      select input_per_m::float8 as input from ai_price where model = 'gemini-3.8-flash'
      order by effective_from`;
    expect(flash.map((x) => x.input)).toEqual([0.75, 3]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toStartWith("Large change: ");
    expect(posts[0]).toContain(
      "vertex/gemini-3.8-flash input price changed from 0.75 to 3 per million",
    );
  });

  test("a price that disappears is rejected: the old row stays and one post goes out", async () => {
    const f = clone();
    cost(f, "gemini-3.8-flash").input = 3;
    delete cost(f, "gemini-3.7-flash").input;
    const before = await rows();
    posts.length = 0;
    const res = await syncPrices(deps(serve(f)));
    expect(res.changed).toEqual([]);
    expect(res.rejected).toEqual(["vertex/gemini-3.7-flash"]);
    expect(await rows()).toEqual(before);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("vertex/gemini-3.7-flash");
    expect(posts[0]).not.toContain("\u2014");
  });

  test("a price that drops to zero is rejected and the last good price kept", async () => {
    const f = clone();
    cost(f, "gemini-3.8-flash").input = 3;
    cost(f, "gemini-3.5-flash").output = 0;
    const before = await rows();
    posts.length = 0;
    const res = await syncPrices(deps(serve(f)));
    expect(res.rejected).toEqual(["vertex/gemini-3.5-flash"]);
    expect(await rows()).toEqual(before);
    expect(posts).toHaveLength(1);
  });

  test("unreachable or unreadable sources change nothing", async () => {
    const before = { prices: await rows(), fx: await fx() };
    const res = await syncPrices(deps(offline));
    expect(res).toEqual({ changed: [], rejected: [], fxChanged: false, sourceRead: false });
    expect({ prices: await rows(), fx: await fx() }).toEqual(before);

    logs.length = 0;
    const garbage = async () => "<html>maintenance</html>";
    expect(await syncPrices(deps(garbage))).toEqual({
      changed: [],
      rejected: [],
      fxChanged: false,
      sourceRead: false,
    });
    expect({ prices: await rows(), fx: await fx() }).toEqual(before);
    expect(logs.filter((l) => l.level === "warn").length).toBeGreaterThanOrEqual(2);
  });

  test("a new ECB rate replaces today's row", async () => {
    const f = clone();
    cost(f, "gemini-3.8-flash").input = 3;
    const res = await syncPrices(deps(serve(f, "1.2500")));
    expect(res.fxChanged).toBe(true);
    const rate = await fx();
    expect(rate).toHaveLength(1);
    expect(Number(rate[0]?.usd_to_eur)).toBeCloseTo(0.8, 10);
  });

  test("a search price in another currency is converted at the stored rate", async () => {
    const base = loadOverrides();
    const overrides: OverrideFile = {
      models: {
        "vertex/eur-model": {
          provider: "vertex",
          prices: {
            currency: "EUR",
            inputPerM: 1,
            cachedInputPerM: null,
            audioInputPerM: null,
            outputPerM: 2,
            longContext: null,
            perAudioSecond: null,
            perSearchQuery: null,
          },
        },
      },
      searchQuery: base.searchQuery,
    };
    // models.dev unreachable: hand prices are still stored, at the stored rate (0.8).
    await syncPrices({ ...deps(offline), overrides });
    const [row] = await sql`
      select per_search_query::float8 as q from ai_price where model = 'eur-model'`;
    expect(row?.q).toBeCloseTo(0.014 * 0.8, 12);
  });

  test("startup with every configured model priced loads them without syncing", async () => {
    const book = priceBook(db.db, logger);
    logs.length = 0;
    posts.length = 0;
    let fetched = 0;
    const counting = async (url: string) => {
      fetched++;
      return serve(fixture)(url);
    };
    const started = await priceStartup(deps(counting), book, ["vertex/gemini-3.8-flash"]);
    expect(book.current().prices.has("vertex/gemini-3.8-flash")).toBe(true);
    await started.settled;
    expect(fetched).toBe(0);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  test("startup syncs when a configured model has no stored price, then names what is still missing", async () => {
    const book = priceBook(db.db, logger);
    logs.length = 0;
    posts.length = 0;
    let fetched = 0;
    const counting = async (url: string) => {
      fetched++;
      return serve(fixture)(url);
    };
    const started = await priceStartup(deps(counting), book, [
      "vertex/gemini-3.8-flash",
      "vertex/x",
    ]);
    // Loaded before startup returns; the sync and the missing-price check follow in settled.
    expect(book.current().prices.has("vertex/gemini-3.8-flash")).toBe(true);
    await started.settled;
    expect(fetched).toBeGreaterThan(0);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(1);
    // The sync may also post price changes; one post names what is still missing.
    const missing = posts.filter((p) => p.startsWith("No AI price"));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("vertex/x");
    // vertex/x has no overrides entry: the post asks for one.
    expect(missing[0]).toContain("not in prices/overrides.json, so add an entry there");
    expect(missing[0]).not.toContain("gemini-3.8-flash");
    expect(missing[0]).not.toContain("\u2014");
  });

  test("a model added in a deploy is priced by the startup sync, with no post", async () => {
    // The stored table lacks one configured model, as after a deploy that adds it.
    await sql`delete from ai_price where provider = 'vertex' and model = 'gemini-3.8-flash'`;
    const book = priceBook(db.db, logger);
    logs.length = 0;
    posts.length = 0;
    const started = await priceStartup(deps(serve(fixture)), book, [
      "vertex/gemini-3.8-flash",
      "openai-compatible/glm-5.3",
    ]);
    expect(book.current().prices.has("vertex/gemini-3.8-flash")).toBe(false);
    await started.settled;
    expect(book.current().prices.has("vertex/gemini-3.8-flash")).toBe(true);
    expect(logs.filter((l) => l.level === "error")).toHaveLength(0);
    expect(posts.filter((p) => p.startsWith("No AI price"))).toEqual([]);
  });
});
