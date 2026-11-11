import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect, createDb, migrate } from "@dembrane/db";
import { type LlmSettings, PROFILES } from "@dembrane/llm";
import type postgres from "postgres";
import { configuredModels, loadOverrides, priceBook } from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `metering_store_${process.pid}`;
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

run("price book", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 1, onnotice: () => {} });
    db = createDb({ url, poolMax: 2 });
  });

  afterAll(async () => {
    await sql?.end();
    await db?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("starts empty, then holds the newest row per model and the latest rate after reload", async () => {
    const book = priceBook(db.db, quiet);
    expect(book.current().prices.size).toBe(0);

    await sql`insert into ai_price
      (provider, model, currency, input_per_m, output_per_m, source, effective_from)
      values ('vertex', 'a', 'USD', 1, 2, 'models.dev', '2026-10-01T00:00:00Z'),
             ('vertex', 'a', 'USD', 3, 4, 'models.dev', '2026-11-01T00:00:00Z'),
             ('openai-compatible', 'w', 'EUR', null, null, 'override', '2026-11-01T00:00:00Z')`;
    await sql`update ai_price set per_audio_second = 0.00005 where model = 'w'`;
    await sql`update ai_price set long_context_threshold = 200000, long_input_per_m = 6,
      long_cached_input_per_m = null, long_output_per_m = 8, cached_input_per_m = 0.3,
      per_search_query = 0.014 where model = 'a' and effective_from = '2026-11-01T00:00:00Z'`;
    await sql`insert into ai_fx_rate (day, usd_to_eur) values ('2026-11-01', 0.9), ('2026-11-02', 0.92)`;

    await book.reload();
    const snap = book.current();
    expect(snap.usdToEur).toBe(0.92);
    expect(snap.prices.size).toBe(2);
    const a = snap.prices.get("vertex/a");
    expect(a).toMatchObject({
      provider: "vertex",
      model: "a",
      currency: "USD",
      source: "models.dev",
      inputPerM: 3,
      cachedInputPerM: 0.3,
      audioInputPerM: null,
      outputPerM: 4,
      longContext: { threshold: 200000, inputPerM: 6, cachedInputPerM: null, outputPerM: 8 },
      perAudioSecond: null,
      perSearchQuery: 0.014,
    });
    expect(typeof a?.id).toBe("number");
    expect(a?.effectiveFrom.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(snap.prices.get("openai-compatible/w")).toMatchObject({
      currency: "EUR",
      source: "override",
      inputPerM: null,
      longContext: null,
      perAudioSecond: 0.00005,
    });
  });

  test("missing names the models the book has no price for", async () => {
    const book = priceBook(db.db, quiet);
    await book.reload();
    expect(book.missing(["vertex/x"])).toEqual(["vertex/x"]);
    expect(book.missing(["vertex/a", "vertex/x", "openai-compatible/w"])).toEqual(["vertex/x"]);
  });

  test("a failed reload keeps the last snapshot and does not throw", async () => {
    const lost = createDb({ url: "postgres://nobody:x@127.0.0.1:1/none", poolMax: 1 });
    const book = priceBook(lost.db, quiet);
    await book.reload();
    expect(book.current().prices.size).toBe(0);
    await lost.close();
  });
});

describe("configuredModels", () => {
  const settings: LlmSettings = {
    provider: "vertex",
    searchGrounding: true,
    textFast: ["gemini-3.5-flash"],
    multiModalFast: ["gemini-3.7-flash"],
    multiModalPro: ["gemini-3.8-flash", "gemini-3.7-flash"],
    compatTextFast: ["glm-5.3"],
    compatMultiModalFast: ["glm-5.3"],
    compatMultiModalPro: ["glm-5.3"],
    vertexProject: "p",
    vertexLocation: "europe-west4",
    embeddingModel: "text-embedding-004",
    compatEmbeddingModel: "qwen3-embedding-8b",
    embeddingLocation: "europe-west4",
    embeddingDimensions: 768,
  };

  test("Vertex: the groups, the embedding model and Gemini speech", () => {
    expect(configuredModels(settings, PROFILES["dembrane-26-10-gemini"])).toEqual([
      "vertex/gemini-3.5-flash",
      "vertex/gemini-3.7-flash",
      "vertex/gemini-3.8-flash",
      "vertex/text-embedding-004",
    ]);
  });

  test("the compatible provider: its groups, embeddings, Whisper and the clean-up model", () => {
    const eu = { ...settings, provider: "openai-compatible" as const };
    const models = configuredModels(eu, PROFILES["dembrane-26-10-whisper-eu"]);
    expect(models).toEqual([
      "openai-compatible/glm-5.3",
      "openai-compatible/qwen3-embedding-8b",
      "openai-compatible/whisper-large-v3",
    ]);
    expect(models.filter((m) => !loadOverrides().models[m])).toEqual([]);
  });
});
