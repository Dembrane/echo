import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import {
  AudioUrls,
  buildSpeechKit,
  ParticipantTokens,
  replyProtocol,
  type SpeechRouter,
} from "@dembrane/conversations";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import {
  decide,
  type LlmSettings,
  profileForProvider,
  STUB_VERTEX_AUTH,
  type WireRequest,
  wireStubs,
} from "@dembrane/llm";
import { aiRouting, modelCallRecorder, modelCallTable, type PriceRow } from "@dembrane/metering";
import { createLogger, withPayer } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import { verifyRoutes } from "@dembrane/verify";
import { Hono } from "hono";
import type postgres from "postgres";

/**
 * Explore and Verify with audio in the request, on every pairing of the two jobs: the
 * recording goes to the provider that has the transcription job, the prompt, the project's
 * context and the other conversations only to the one that has the analysis job. With one
 * provider for both the single call stays; with two the audio is read to text first.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `api_audio_split_${process.pid}`;

const SETTINGS: LlmSettings = {
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
  baseUrl: "https://scaleway.e2e.test/v1",
  apiKey: "k",
  searchGrounding: true,
  textFast: ["gemini-a"],
  multiModalFast: ["gemini-a"],
  multiModalPro: ["gemini-a"],
  compatTextFast: ["glm-5.3"],
  compatMultiModalFast: ["glm-5.3"],
  compatMultiModalPro: ["glm-5.3"],
  vertexProject: "p",
  vertexLocation: "eu",
  embeddingModel: "text-embedding-004",
  compatEmbeddingModel: "qwen3-embedding-8b",
  embeddingLocation: "europe-west4",
  embeddingDimensions: 8,
};
const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(2000).fill(1)]);
const HEARD = "WORDSHEARDINTHEROOM";
const price = (provider: string, model: string): [string, PriceRow] => [
  `${provider}/${model}`,
  {
    id: 1,
    provider,
    model,
    source: "override",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    currency: "EUR",
    inputPerM: 1,
    cachedInputPerM: null,
    audioInputPerM: null,
    outputPerM: 1,
    longContext: null,
    perAudioSecond: 1,
    perSearchQuery: 1,
  },
];
const prices = {
  current: () => ({
    prices: new Map([
      price("vertex", "gemini-a"),
      price("openai-compatible", "glm-5.3"),
      price("openai-compatible", "whisper-large-v3"),
    ]),
    usdToEur: 1,
  }),
};

type Provider = "scaleway" | "google";
/** One project per pairing: what it chose for each job (null follows the account's Scaleway default). */
const WORLDS = {
  ss: { transcription: null, analysis: null },
  gg: { transcription: "google", analysis: "google" },
  tg: { transcription: "google", analysis: null },
  ag: { transcription: null, analysis: "google" },
} as const;
type Key = keyof typeof WORLDS;
const KEYS = Object.keys(WORLDS) as Key[];
const providerOf = (key: Key, job: "transcription" | "analysis"): Provider =>
  WORLDS[key][job] ?? "scaleway";

const analysisMarks = (key: Key) => [
  `PROJECTCONTEXT-${key}`,
  `OTHERSUMMARY-${key}`,
  `ALREADYTRANSCRIBED-${key}`,
];

run("Explore and Verify with audio: each job sees only what it is for", () => {
  setDefaultTimeout(120_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;
  let recorder: ReturnType<typeof modelCallRecorder>;
  let models: ReturnType<typeof aiRouting>["kit"]["models"];
  let speech: SpeechRouter;
  let audio: FilesystemStorage;
  let verify: Hono;
  const wire = wireStubs({
    text: `{"corrected_transcript":"${HEARD}","note":"","verdict":"x"}`,
    speech: HEARD,
  });
  const ids = {} as Record<Key, { project: string; conversation: string }>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const made = createDb({ url, poolMax: 4 });
    db = made.db;
    close = made.close;

    const orgId = randomUUID();
    await sql`insert into org (id, name, ai_transcription_providers, ai_analysis_providers, ai_transcription_default, ai_analysis_default)
      values (${orgId}, 'both', array['scaleway','google'], array['scaleway','google'], 'scaleway', 'scaleway')`;
    const accountId = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'paid', ${orgId})`;
    const workspaceId = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${workspaceId}, 'w', ${orgId}, ${accountId})`;
    await sql`insert into verification_topic (key, prompt, sort) values ('agreements', 'List the agreements.', 1)`;

    audio = new FilesystemStorage(
      mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "audio-split-")),
      "http://local.test",
      "/_local-audio",
    );
    for (const key of KEYS) {
      const choice = WORLDS[key];
      const project = randomUUID();
      const conversation = randomUUID();
      const other = randomUUID();
      ids[key] = { project, conversation };
      await sql`insert into project (id, name, language, context, is_conversation_allowed, is_get_reply_enabled, get_reply_mode,
          is_get_reply_cross_pollination_enabled, is_verify_enabled, workspace_id, ai_transcription_provider, ai_analysis_provider)
        values (${project}, ${`project ${key}`}, 'en', ${`PROJECTCONTEXT-${key}`}, true, true, 'summarize', true, true, ${workspaceId}, ${choice.transcription}, ${choice.analysis})`;
      // The conversation began on the provider its project chose for transcription.
      await sql`insert into conversation (id, project_id, ai_transcription_provider) values (${conversation}, ${project}, ${providerOf(key, "transcription")})`;
      await sql`insert into conversation (id, project_id, summary, ai_transcription_provider) values (${other}, ${project}, ${`OTHERSUMMARY-${key}`}, ${providerOf(key, "transcription")})`;
      const path = `conversation/${conversation}/chunks/late.mp3`;
      await audio.put(path, mp3);
      await sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, source)
        values (${randomUUID()}, ${conversation}, '2026-09-01T09:30:00Z', ${`ALREADYTRANSCRIBED-${key}`}, 'PORTAL_AUDIO')`;
      await sql`insert into conversation_chunk (id, conversation_id, timestamp, path, source)
        values (${randomUUID()}, ${conversation}, '2026-09-01T09:40:00Z', ${`http://s3.test/bucket/${path}`}, 'PORTAL_AUDIO')`;
    }

    recorder = modelCallRecorder({
      sink: modelCallTable(db),
      logger,
      service: "echo-api",
      prices,
      flushMs: 60_000,
    });
    const hooks = {
      observe: recorder.observe,
      attemptsPerDeployment: 1,
      backoffMs: 0,
      sleep: async () => {},
      transport: { vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH }, compatFetch: wire.compat },
    };
    const ai = aiRouting({ settings: SETTINGS, db, hooks, resolverOptions: { ttlMs: 0 } });
    models = ai.kit.models;
    speech = {
      default: ai.policy.default,
      kits: Object.fromEntries(
        ai.policy.providers.map((id) => [
          id,
          buildSpeechKit({
            settings: SETTINGS,
            profile: profileForProvider(SETTINGS, id),
            hooks,
            logger,
            withFinal: false,
          }),
        ]),
      ),
      decide: (who) => decide(ai.resolver, ai.policy, "transcription", who),
      decideAnalysis: (who) => decide(ai.resolver, ai.policy, "analysis", who),
    };
    verify = new Hono().route(
      "/",
      verifyRoutes({
        db,
        access: new Access(new DrizzleAccessStore(db)),
        audio,
        audioUrls: new AudioUrls("http://s3.test", "bucket"),
        models,
        speech,
        tokens: new ParticipantTokens("s".repeat(48), false),
        limiter: new RateLimiter(new MemoryRateCounter()),
        logger,
        now: () => new Date(),
      }),
    );
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const reply = async (key: Key) => {
    const d = {
      db,
      models,
      speech,
      audio,
      audioUrls: new AudioUrls("http://s3.test", "bucket"),
      logger,
      now: () => new Date(),
    };
    const lines: string[] = [];
    // The route's payer middleware runs the request as its conversation's.
    const who = { ref: "conversation", id: ids[key].conversation } as const;
    await withPayer(who, async () => {
      for await (const l of replyProtocol(d, ids[key].conversation, "en")) lines.push(l);
    });
    expect(lines.join("")).not.toContain("3:");
  };
  const draft = async (key: Key) => {
    const res = await verify.request("/api/verify/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic_list: ["agreements"], conversation_id: ids[key].conversation }),
    });
    expect(res.status).toBe(200);
  };

  /** A request that carries the recording itself, to either provider; the speech endpoint's is audio too. */
  const hasAudio = (side: "vertex" | "compat", r: WireRequest) =>
    side === "vertex"
      ? r.body.includes("audio/mp3") || r.body.includes("audio/mpeg")
      : r.url.endsWith("/audio/transcriptions") || r.body.includes("input_audio");
  const hasAnalysis = (r: WireRequest, key: Key) =>
    analysisMarks(key).some((m) => r.body.includes(m));
  const side = { scaleway: "compat", google: "vertex" } as const;

  for (const feature of ["Explore", "Verify"] as const) {
    describe(feature, () => {
      for (const key of KEYS) {
        test(`${key}: transcription on ${providerOf(key, "transcription")}, analysis on ${providerOf(key, "analysis")}`, async () => {
          wire.seen.vertex.length = 0;
          wire.seen.compat.length = 0;
          await (feature === "Explore" ? reply(key) : draft(key));
          const hearing = providerOf(key, "transcription");
          const reading = providerOf(key, "analysis");
          const all = { vertex: wire.seen.vertex, compat: wire.seen.compat };
          const audioOn = (p: Provider) => all[side[p]].filter((r) => hasAudio(side[p], r));
          const analysisOn = (p: Provider) => all[side[p]].filter((r) => hasAnalysis(r, key));

          // The recording reached the provider that has the transcription job, and only that one.
          expect(audioOn(hearing).length).toBeGreaterThan(0);
          if (hearing !== reading) {
            expect(audioOn(reading)).toHaveLength(0);
            // That provider saw nothing of the analysis: not the prompt, the context or other conversations.
            expect(analysisOn(hearing)).toHaveLength(0);
            // The analysis provider read the words as text.
            expect(analysisOn(reading).length).toBeGreaterThan(0);
            expect(analysisOn(reading).some((r) => r.body.includes(HEARD))).toBe(true);
          } else {
            // One provider with both jobs: today's single call, on that provider alone. On Google
            // the request carries the audio itself; on Scaleway the model reads it with Whisper.
            expect(analysisOn(hearing).length).toBeGreaterThan(0);
            expect(all[side[hearing === "google" ? "scaleway" : "google"]]).toHaveLength(0);
            if (hearing === "google")
              expect(analysisOn(hearing).some((r) => hasAudio("vertex", r))).toBe(true);
          }
        });
      }
    });
  }

  test("the call log records the speech step as transcription and the text call as analysis", async () => {
    await recorder.flush();
    const rows = await sql<
      { project_id: string; provider: string; routed_provider: string; routing_job: string }[]
    >`select project_id::text, provider, routed_provider, routing_job from model_call`;
    for (const key of KEYS) {
      const own = rows.filter((r) => r.project_id === ids[key].project);
      for (const job of ["transcription", "analysis"] as const) {
        const mine = own.filter((r) => r.routing_job === job);
        // One provider keeps the single call, which the routing layer logs as transcription
        // whole; two providers log the speech step and the text call each under its own job.
        const mixed = providerOf(key, "transcription") !== providerOf(key, "analysis");
        if (mixed || job === "transcription")
          expect([key, job, mine.length > 0]).toEqual([key, job, true]);
        const google = providerOf(key, job) === "google";
        expect(
          mine.every((r) =>
            google
              ? r.provider === "vertex" && r.routed_provider === "google"
              : r.provider === "openai-compatible" && r.routed_provider === "scaleway",
          ),
        ).toBe(true);
      }
    }
  });
});
