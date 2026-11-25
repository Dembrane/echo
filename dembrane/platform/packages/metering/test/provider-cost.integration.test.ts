import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import { type LlmSettings, profileForProvider } from "@dembrane/llm";
import type postgres from "postgres";
import {
  accountVolume,
  costLine,
  googleSpendByAccount,
  listedUnitCosts,
  loggedUnitCosts,
  mergeUnitCosts,
  monthSpend,
  monthStart,
} from "../src";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `metering_cost_${process.pid}`;
const NOW = new Date("2026-11-25T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

run("what a provider costs, from the call log", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const made = createDb({ url, poolMax: 2 });
    db = made.db;
    close = made.close;
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const ORG_A = randomUUID();
  const ORG_B = randomUUID();
  const ORG_C = randomUUID();
  const ORG_D = randomUUID();
  const ORG_NEW = randomUUID();
  const PROJECT_1 = randomUUID();
  const PROJECT_2 = randomUUID();

  type Seed = {
    at: string;
    org: string;
    project?: string;
    provider: "scaleway" | "google";
    job: "transcription" | "analysis";
    micro: number;
    audioSeconds?: number;
    tokens?: number;
    status?: string;
    payer?: string;
  };
  const seed = (r: Seed) =>
    sql`insert into model_call (started_at, service, model_group, model, kind, status, attempt, ms,
        provider, routed_provider, routing_job, organisation_id, project_id, payer, audio_seconds,
        input_tokens, output_tokens, cost_micro_eur)
      values (${r.at}::timestamptz, 'echo-worker', 'g', 'm', ${r.job === "transcription" ? "speech" : "generate"},
        ${r.status ?? "ok"}, 1, 1, ${r.provider === "google" ? "vertex" : "openai-compatible"}, ${r.provider},
        ${r.job}, ${r.org}, ${r.project ?? null}, ${r.payer ?? "account"}, ${r.audioSeconds ?? null},
        ${r.tokens ? r.tokens - Math.floor(r.tokens / 10) : null}, ${r.tokens ? Math.floor(r.tokens / 10) : null}, ${r.micro})`;

  /** An organisation with a workspace and the given projects; conversations are added to them. */
  async function account(org: string, projects: string[]) {
    const billing = randomUUID();
    const workspace = randomUUID();
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'innovator')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${workspace}, 'W', ${org}, ${billing})`;
    for (const id of projects)
      await sql`insert into project (id, name, workspace_id, is_conversation_allowed) values (${id}, 'P', ${workspace}, true)`;
  }
  const conversation = (
    project: string,
    o: { seconds: number | null; at: string; deleted?: boolean },
  ) =>
    sql`insert into conversation (id, project_id, source, created_at, duration, deleted_at)
      values (${randomUUID()}, ${project}, 'PORTAL_AUDIO', ${o.at}::timestamptz, ${o.seconds}, ${o.deleted ? o.at : null}::timestamptz)`;

  beforeAll(async () => {
    await sql`delete from model_call`;
    await account(ORG_A, [PROJECT_1, PROJECT_2]);
    // Account A's recordings, 30 minutes of audio in all. Its speech rows below add up to one
    // hour, because the redo and the second listen hear the same audio again.
    await conversation(PROJECT_1, { seconds: 1200, at: daysAgo(2) });
    await conversation(PROJECT_1, { seconds: 600, at: daysAgo(5) });
    // Not part of the estimate: older than the window, deleted, not measured.
    await conversation(PROJECT_1, { seconds: 7200, at: daysAgo(40) });
    await conversation(PROJECT_1, { seconds: 7200, at: daysAgo(3), deleted: true });
    await conversation(PROJECT_1, { seconds: -1, at: daysAgo(3) });
    await conversation(PROJECT_1, { seconds: null, at: daysAgo(3) });
    // Account A: one hour of speech rows on Scaleway (EUR 0.18 in all), 10 analysis calls of 1000 tokens
    // on Scaleway (EUR 0.05), spread over two projects; one call 40 days back is outside the window.
    for (let i = 0; i < 6; i++)
      await seed({
        at: daysAgo(2),
        org: ORG_A,
        project: PROJECT_1,
        provider: "scaleway",
        job: "transcription",
        audioSeconds: 600,
        micro: 30_000,
      });
    for (let i = 0; i < 6; i++)
      await seed({
        at: daysAgo(3),
        org: ORG_A,
        project: i < 4 ? PROJECT_1 : PROJECT_2,
        provider: "scaleway",
        job: "analysis",
        tokens: 1000,
        micro: 5_000,
      });
    await seed({
      at: daysAgo(40),
      org: ORG_A,
      project: PROJECT_1,
      provider: "scaleway",
      job: "analysis",
      tokens: 90_000,
      micro: 900_000,
    });
    // Accounts B, C and D have each used Google: 30 minutes of audio at EUR 0.90 and 4 calls of
    // 2000 tokens at EUR 0.02 each; three accounts are enough for an average to be shown.
    for (const org of [ORG_B, ORG_C, ORG_D]) {
      await seed({
        at: daysAgo(1),
        org,
        provider: "google",
        job: "transcription",
        audioSeconds: 1800,
        micro: 900_000,
      });
      for (let i = 0; i < 4; i++)
        await seed({
          at: daysAgo(1),
          org,
          provider: "google",
          job: "analysis",
          tokens: 2000,
          micro: 20_000,
        });
      // A failed call costs money and counts in the average, but not as volume.
      await seed({
        at: daysAgo(1),
        org,
        provider: "google",
        job: "analysis",
        tokens: 2000,
        micro: 20_000,
        status: "error",
      });
    }
    // An internal payer is no account's use, of the average or of the volume.
    await seed({
      at: daysAgo(1),
      org: ORG_B,
      provider: "google",
      job: "analysis",
      tokens: 2000,
      micro: 9_000_000,
      payer: "internal",
    });
    await seed({
      at: daysAgo(1),
      org: ORG_A,
      project: PROJECT_1,
      provider: "scaleway",
      job: "analysis",
      tokens: 50_000,
      micro: 400_000,
      payer: "internal",
    });
  });

  test("an account's volume is its last 30 days, per job, and a project's is its own", async () => {
    // Audio is the conversations' own length, not the speech rows' (which hear it more than once);
    // text is the account's paid calls, not an internal payer's.
    expect(await accountVolume(db, { organisationId: ORG_A }, NOW)).toEqual({
      audioSeconds: 1800,
      calls: 6,
      tokens: 6000,
    });
    expect(await accountVolume(db, { organisationId: ORG_A, projectId: PROJECT_1 }, NOW)).toEqual({
      audioSeconds: 1800,
      calls: 4,
      tokens: 4000,
    });
    expect(await accountVolume(db, { organisationId: ORG_A, projectId: PROJECT_2 }, NOW)).toEqual({
      audioSeconds: 0,
      calls: 2,
      tokens: 2000,
    });
    expect(await accountVolume(db, { organisationId: ORG_NEW }, NOW)).toEqual({
      audioSeconds: 0,
      calls: 0,
      tokens: 0,
    });
  });

  test("a provider's cost per unit is its average over every account in the window", async () => {
    const unit = await loggedUnitCosts(db, NOW);
    // Google, three accounts: EUR 0.90 for each 1800 s; analysis counts the failed attempt's cost
    // over the calls that succeeded.
    expect(unit.google.perAudioSecond).toBeCloseTo(0.9 / 1800, 8);
    // EUR 0.10 over 4 successful calls and 8000 tokens each; the internal payer's EUR 9 is not an account's.
    expect(unit.google.perCall).toBeCloseTo(0.025, 8);
    expect(unit.google.perToken).toBeCloseTo(0.1 / 8000, 10);
  });

  test("an average over fewer than three accounts is not shown: one account's spend is not another's to read", async () => {
    // Scaleway has one account in the log, Account A: its own figures are not an average.
    const one = await loggedUnitCosts(db, NOW);
    expect(one.scaleway).toEqual({ perAudioSecond: null, perCall: null, perToken: null });
    // Two accounts still show nothing; a third makes it an average.
    const scalewayCall = (org: string) =>
      seed({
        at: daysAgo(1),
        org,
        provider: "scaleway",
        job: "analysis",
        tokens: 1000,
        micro: 5_000,
      });
    await scalewayCall(ORG_B);
    expect((await loggedUnitCosts(db, NOW)).scaleway.perCall).toBeNull();
    await scalewayCall(ORG_C);
    const three = await loggedUnitCosts(db, NOW);
    expect(three.scaleway.perCall).toBeCloseTo(0.005, 8);
    expect(three.scaleway.perToken).toBeCloseTo(0.005 / 1000, 10);
    // Audio still has only Account A's rows.
    expect(three.scaleway.perAudioSecond).toBeNull();
  });

  test("the estimate is the account's volume times the provider's average, in euros a month", async () => {
    const volume = await accountVolume(db, { organisationId: ORG_A }, NOW);
    const unit = mergeUnitCosts(await loggedUnitCosts(db, NOW), null);
    const speech = costLine("google", "transcription", volume, unit.google);
    // Half an hour of audio at Google's EUR 0.90 per half hour: the redo's second hearing is not counted.
    expect(speech).toMatchObject({ billing: "on_top", monthly_eur: 0.9, per_hour_eur: null });
    const text = costLine("google", "analysis", volume, unit.google);
    // 6000 tokens at EUR 0.10 per 8000.
    expect(text.monthly_eur).toBe(0.08);
    expect(costLine("scaleway", "analysis", volume, unit.scaleway)).toMatchObject({
      billing: "included",
    });
  });

  test("with no history the line is the cost of an hour of audio and of 100 analysis calls", async () => {
    const volume = await accountVolume(db, { organisationId: ORG_NEW }, NOW);
    const unit = mergeUnitCosts(await loggedUnitCosts(db, NOW), null);
    expect(costLine("google", "transcription", volume, unit.google)).toEqual({
      job: "transcription",
      provider: "google",
      billing: "on_top",
      monthly_eur: null,
      per_hour_eur: 1.8,
      per_100_calls_eur: null,
    });
    expect(costLine("google", "analysis", volume, unit.google)).toMatchObject({
      monthly_eur: null,
      per_hour_eur: null,
      per_100_calls_eur: 2.5,
    });
  });

  test("a provider with no history is priced from the price list", () => {
    const settings = {
      provider: "openai-compatible",
      textFast: ["gemini-flash"],
      multiModalFast: ["gemini-flash"],
      multiModalPro: ["gemini-pro"],
      compatTextFast: ["glm-5.3"],
      compatMultiModalFast: ["glm-5.3"],
      compatMultiModalPro: ["glm-5.3"],
      vertexProject: "p",
      vertexLocation: "eu",
      searchGrounding: true,
      embeddingModel: "e",
      compatEmbeddingModel: "e",
      embeddingLocation: "eu",
      embeddingDimensions: 8,
      baseUrl: "https://x",
      apiKey: "k",
    } as LlmSettings;
    const row = (provider: string, model: string, over: object) =>
      [
        `${provider}/${model}`,
        {
          id: 1,
          provider,
          model,
          source: "override" as const,
          effectiveFrom: new Date("2026-01-01T00:00:00Z"),
          currency: "EUR" as const,
          inputPerM: null,
          cachedInputPerM: null,
          audioInputPerM: null,
          outputPerM: null,
          longContext: null,
          perAudioSecond: null,
          perSearchQuery: null,
          ...over,
        },
      ] as const;
    const profile = (id: "scaleway" | "google") => profileForProvider(settings, id);
    const snap = {
      usdToEur: 1,
      prices: new Map([
        row("openai-compatible", profile("scaleway").live.model, { perAudioSecond: 0.00005 }),
        row("openai-compatible", "glm-5.3", { inputPerM: 1.8, outputPerM: 5.5 }),
        row("vertex", "gemini-flash", { inputPerM: 0.3, outputPerM: 2.5, audioInputPerM: 1 }),
      ]),
    };
    const listed = listedUnitCosts(snap, settings, profile);
    expect(listed.scaleway.perAudioSecond).toBeCloseTo(0.00005, 8);
    // A typical call: 4000 tokens in and 600 out at EUR 1.8 and 5.5 per million.
    expect(listed.scaleway.perCall).toBeCloseTo((4000 * 1.8 + 600 * 5.5) / 1e6, 6);
    expect(listed.google.perCall).toBeGreaterThan(0);
    // The log wins where it has an answer; the list fills the rest.
    const merged = mergeUnitCosts(
      {
        scaleway: { perAudioSecond: 0.1, perCall: null, perToken: null },
        google: { perAudioSecond: null, perCall: null, perToken: null },
      },
      listed,
    );
    expect(merged.scaleway.perAudioSecond).toBe(0.1);
    expect(merged.scaleway.perCall).toBe(listed.scaleway.perCall);
  });

  test("spend this month is per provider since the first of the calendar month, for one account", async () => {
    await seed({
      at: "2026-11-02T10:00:00Z",
      org: ORG_NEW,
      provider: "google",
      job: "analysis",
      tokens: 10,
      micro: 1_500_000,
    });
    await seed({
      at: "2026-11-20T10:00:00Z",
      org: ORG_NEW,
      provider: "scaleway",
      job: "analysis",
      tokens: 10,
      micro: 250_000,
    });
    await seed({
      at: "2026-10-31T23:59:00Z",
      org: ORG_NEW,
      provider: "google",
      job: "analysis",
      tokens: 10,
      micro: 7_000_000,
    });
    expect(monthStart(NOW).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(await monthSpend(db, ORG_NEW, NOW)).toEqual({ scaleway: 0.25, google: 1.5 });
    expect(await monthSpend(db, randomUUID(), NOW)).toEqual({ scaleway: 0, google: 0 });
  });

  test("the period's Google spend per account, for an invoice to read", async () => {
    const spend = await googleSpendByAccount(db, {
      from: new Date("2026-11-01T00:00:00Z"),
      until: new Date("2026-12-01T00:00:00Z"),
    });
    const byOrg = new Map(spend.map((s) => [s.organisationId, s.euros]));
    expect(byOrg.get(ORG_NEW)).toBe(1.5);
    // 0.90 + 4 * 0.02 + 0.02 (failed); the internal payer's EUR 9 is not billed to the account.
    expect(byOrg.get(ORG_B)).toBeCloseTo(0.9 + 0.08 + 0.02, 2);
    expect(byOrg.has(ORG_A)).toBe(false);
    // Half open: the first instant of the next period belongs to it.
    expect(
      await googleSpendByAccount(db, {
        from: new Date("2026-11-02T10:00:00Z"),
        until: new Date("2026-11-02T10:00:00.001Z"),
      }),
    ).toEqual([{ organisationId: ORG_NEW, euros: 1.5 }]);
  });
});
