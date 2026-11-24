import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import {
  decide,
  type LlmSettings,
  profileForProvider,
  routingPolicyOf,
  STUB_VERTEX_AUTH,
  wireStubs,
} from "@dembrane/llm";
import { dbRoutingStore, providerResolver } from "@dembrane/metering";
import { createLogger, routing } from "@dembrane/observability";
import type postgres from "postgres";
import { buildSpeechKit, type SpeechRouter } from "../src";
import { handOver, type PipelineDeps, withSpeech } from "../src/pipeline/steps";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `speech_routing_${process.pid}`;

const SETTINGS: LlmSettings = {
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
  baseUrl: "https://scaleway.speech.test/v1",
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
const policy = routingPolicyOf(SETTINGS);
const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, ...new Array(2000).fill(1)]);

run("transcription follows the conversation's provider", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;
  let router: SpeechRouter;
  let deps: PipelineDeps;
  const enqueued: { def: string; payload: { conversationId: string; provider: string } }[] = [];
  const wire = wireStubs({
    text: '{"corrected_transcript":"gemini heard this","note":""}',
    speech: "whisper heard this",
  });

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
    const resolver = providerResolver(dbRoutingStore(db), policy, { ttlMs: 0 });
    const hooks = {
      transport: { vertex: { fetch: wire.vertex, ...STUB_VERTEX_AUTH }, compatFetch: wire.compat },
    };
    router = {
      default: "scaleway",
      kits: Object.fromEntries(
        policy.providers.map((id) => [
          id,
          buildSpeechKit({
            settings: SETTINGS,
            profile: profileForProvider(SETTINGS, id),
            hooks,
            logger,
            withFinal: true,
          }),
        ]),
      ),
      decide: (who) => decide(resolver, policy, who),
    };
    const base = router.kits.scaleway;
    deps = {
      db,
      logger,
      speech: router,
      transcriber: base?.transcriber,
      liveProvider: base?.liveProvider,
      final: base?.final,
      jobs: {
        enqueue: async (def: { name: string }, payload: never) => {
          enqueued.push({ def: def.name, payload });
          return null;
        },
      },
    } as unknown as PipelineDeps;
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function world() {
    const orgId = randomUUID();
    await sql`insert into org (id, name, ai_providers, ai_default_provider)
      values (${orgId}, 'o', array['scaleway','google'], 'scaleway')`;
    const accountId = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'paid', ${orgId})`;
    const workspaceId = randomUUID();
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${workspaceId}, 'w', ${orgId}, ${accountId})`;
    const project = async (choice: string | null) => {
      const id = randomUUID();
      await sql`insert into project (id, is_conversation_allowed, workspace_id, ai_provider) values (${id}, true, ${workspaceId}, ${choice})`;
      return id;
    };
    return { orgId, project };
  }
  const conversation = async (projectId: string, began: string | null, source = "PORTAL_AUDIO") => {
    const id = randomUUID();
    await sql`insert into conversation (id, project_id, ai_provider, source, is_finished, is_all_chunks_transcribed)
      values (${id}, ${projectId}, ${began}, ${source}, true, false)`;
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript)
      values (${randomUUID()}, ${id}, now(), 'x')`;
    return id;
  };

  test("a Scaleway conversation is heard by Whisper, a Google one by Gemini, each with its own final pass", async () => {
    const w = await world();
    const a = await conversation(await w.project("scaleway"), "scaleway");
    const b = await conversation(await w.project("google"), "google");
    const before = { compat: wire.seen.compat.length, vertex: wire.seen.vertex.length };

    const heardA = await withSpeech(deps, a, async (d) => ({
      profile: d.final?.profile,
      live: d.liveProvider,
      clean: d.final?.edit?.providers,
      routed: routing()?.provider,
      text: (await d.transcriber.transcribe({ audio: mp3, language: "en" })).transcript,
    }));
    expect(heardA).toEqual({
      profile: "dembrane-26-10-whisper-eu",
      live: "whisper",
      clean: ["whisper"],
      routed: "scaleway",
      text: "whisper heard this",
    });
    expect(wire.seen.vertex.length).toBe(before.vertex);

    const compatAfterA = wire.seen.compat.length;
    const heardB = await withSpeech(deps, b, async (d) => ({
      profile: d.final?.profile,
      live: d.liveProvider,
      routed: routing()?.provider,
      text: (await d.transcriber.transcribe({ audio: mp3, language: "en" })).transcript,
    }));
    // Gemini has no final pass and no clean-up: nothing runs after the recording.
    expect(heardB).toEqual({
      profile: undefined,
      live: "gemini",
      routed: "google",
      text: "gemini heard this",
    });
    expect(wire.seen.compat.length).toBe(compatAfterA);
    expect(JSON.parse(wire.seen.vertex.at(-1)?.body ?? "{}").labels).toEqual({
      organisation_id: w.orgId,
    });

    // The hand-over queues a final pass for the Scaleway conversation only.
    enqueued.length = 0;
    await handOver(deps, a);
    await handOver(deps, b);
    expect(
      enqueued.map((e) => [e.def, e.payload.conversationId, e.payload.provider]),
    ).toContainEqual(["conversations.final-transcript", a, "whisper"]);
    expect(
      enqueued.some(
        (e) => e.def === "conversations.final-transcript" && e.payload.conversationId === b,
      ),
    ).toBe(false);
  });

  test("going back to Scaleway applies to the next piece, final pass included; going to Google waits for new conversations", async () => {
    const w = await world();
    const p = await w.project("google");
    const onGoogle = await conversation(p, "google");
    expect(await withSpeech(deps, onGoogle, async (d) => d.liveProvider)).toBe("gemini");

    await sql`update project set ai_provider = 'scaleway' where id = ${p}`;
    expect(await withSpeech(deps, onGoogle, async (d) => d.liveProvider)).toBe("whisper");
    enqueued.length = 0;
    await handOver(deps, onGoogle);
    expect(
      enqueued
        .filter((e) => e.def === "conversations.final-transcript")
        .map((e) => e.payload.provider),
    ).toEqual(["whisper"]);

    // A conversation that began on Scaleway stays there when the project moves to Google; a new one begins on Google.
    const earlier = await conversation(p, "scaleway");
    await sql`update project set ai_provider = 'google' where id = ${p}`;
    expect(await withSpeech(deps, earlier, async (d) => d.liveProvider)).toBe("whisper");
    const later = await conversation(p, "google");
    expect(await withSpeech(deps, later, async (d) => d.liveProvider)).toBe("gemini");
    // An upload, too: the first reading is Whisper's and the upload keeps it for the final transcript.
    const upload = await conversation(p, "scaleway", "DASHBOARD_UPLOAD");
    expect(await withSpeech(deps, upload, async (d) => d.final?.uploads)).toBe("first-pass");
  });

  test("a conversation with no recorded provider, or one that cannot be resolved, is on the default", async () => {
    const w = await world();
    const p = await w.project("google");
    const old = await conversation(p, null);
    expect(await withSpeech(deps, old, async (d) => d.liveProvider)).toBe("whisper");
    const gone = randomUUID();
    expect(await withSpeech(deps, gone, async (d) => [d.liveProvider, routing()?.reason])).toEqual([
      "whisper",
      "fail-closed:unknown-project",
    ]);
  });
});
