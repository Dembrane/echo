import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { newId } from "@dembrane/core";
import {
  decide,
  type LlmSettings,
  PROFILES,
  profileForProvider,
  routingPolicyOf,
  STUB_VERTEX_AUTH,
  speechModels,
  type TranscriptionProfile,
  wireStubs,
} from "@dembrane/llm";
import { dbRoutingStore, providerResolver } from "@dembrane/metering";
import { GeminiFinal } from "@dembrane/transcription";
import { buildSpeechKit, type SpeechRouter } from "../src";
import { finalTranscript } from "../src/pipeline/defs";
import { currentChunkHash } from "../src/pipeline/final";
import { bursts } from "./final-helpers";
import { admin, freshDatabase, type Harness, quiet, startWorker, until } from "./pipeline-harness";

// The final pass of a project on Google, moved to Scaleway while it runs: nothing is sent to
// Vertex after the move, whichever call of the pass would have gone there next.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

const SETTINGS: LlmSettings = {
  provider: "openai-compatible",
  providers: ["scaleway", "google"],
  baseUrl: "https://scaleway.final.test/v1",
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
// Google's profile with a final pass: Gemini hears the whole recording again after it ends.
const GOOGLE_WITH_FINAL: TranscriptionProfile = {
  ...PROFILES["dembrane-26-10-gemini"],
  recordings: "redo",
  uploads: "redo",
  redo: { provider: "gemini", model: "gemini-3.8-flash" },
};
// Both parsers read the same answer: the timed sentences and the redacted text.
const ANSWER = JSON.stringify({
  segments: [{ start: 0, end: 2, text: "google heard this" }],
  corrected_transcript: "redacted by whoever answered",
  note: "",
});

run("a final pass whose project leaves Google", () => {
  setDefaultTimeout(120_000);
  let h: Harness;
  let router: SpeechRouter;
  const wire = wireStubs({ text: ANSWER, speech: "whisper heard this" });
  // What the next Vertex request does once it has been answered, and the status it answers with.
  const vertex = {
    after: (_n: number) => Promise.resolve() as Promise<unknown>,
    status: null as number | null,
  };

  beforeAll(async () => {
    const url = await freshDatabase("conv_final_route");
    const hooks = {
      attemptsPerDeployment: 2,
      backoffMs: 0,
      sleep: async () => {},
      transport: {
        vertex: {
          fetch: (async (...a: Parameters<typeof fetch>) => {
            const res = await wire.vertex(...a);
            await vertex.after(wire.seen.vertex.length);
            return vertex.status ? new Response("{}", { status: vertex.status }) : res;
          }) as typeof fetch,
          ...STUB_VERTEX_AUTH,
        },
        compatFetch: wire.compat,
      },
    };
    const kit = (id: "scaleway" | "google") => {
      const profile = id === "google" ? GOOGLE_WITH_FINAL : profileForProvider(SETTINGS, id);
      const built = buildSpeechKit({
        settings: SETTINGS,
        profile,
        hooks,
        logger: quiet,
        withFinal: true,
      });
      if (id !== "google" || !built.final) return built;
      // Pieces of nine seconds, so a short recording is read in several requests.
      const gemini = new GeminiFinal(speechModels(SETTINGS, profile, "gemini", hooks), quiet, {
        maxSeconds: 9,
      });
      return { ...built, final: { ...built.final, transcribers: { gemini } } };
    };
    router = {
      default: "scaleway",
      kits: { scaleway: kit("scaleway"), google: kit("google") },
      decide: async () => {
        throw new Error("replaced below, once the database is up");
      },
    };
    h = await startWorker(url, {
      transcriber: router.kits.scaleway?.transcriber as never,
      speech: router,
    });
    const resolver = providerResolver(dbRoutingStore(h.deps.db), policy, { ttlMs: 0 });
    (router as { decide: SpeechRouter["decide"] }).decide = (who) => decide(resolver, policy, who);
  });
  afterAll(async () => {
    await h?.stop();
  });

  /** A finished conversation of a project on Google, its live text in place and its recording in the bucket. */
  async function conversation(anonymised: boolean) {
    const orgId = newId();
    await h.sql`insert into org (id, name, ai_providers, ai_default_provider)
      values (${orgId}, 'o', array['scaleway','google'], 'scaleway')`;
    const accountId = newId();
    await h.sql`insert into billing_account (id, tier, org_id) values (${accountId}, 'paid', ${orgId})`;
    const workspaceId = newId();
    await h.sql`insert into workspace (id, name, org_id, billing_account_id)
      values (${workspaceId}, 'w', ${orgId}, ${accountId})`;
    const projectId = newId();
    await h.sql`insert into project (id, name, language, is_conversation_allowed, workspace_id, ai_provider)
      values (${projectId}, 'P', 'en', true, ${workspaceId}, 'google')`;
    const id = newId();
    await h.sql`insert into conversation (id, project_id, participant_name, source, ai_provider, is_anonymized,
        is_finished, is_all_chunks_transcribed, created_at, updated_at)
      values (${id}, ${projectId}, 'T', 'PORTAL_AUDIO', 'google', ${anonymised}, true, true,
        now() - interval '1 hour', now())`;
    for (let n = 0; n < 2; n++) {
      const chunkId = newId();
      const key = `conversation/${id}/chunks/${chunkId}-rec${n}.mp3`;
      await h.deps.audio.put(key, await bursts(join(h.bucket.root, `r${n}-${id}.mp3`), 3));
      await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, path, source, transcript)
        values (${chunkId}, ${id}, ${new Date(Date.now() + n * 1000)}, ${h.deps.audioUrls.fileUrl(key)},
          'PORTAL_AUDIO', 'live')`;
    }
    return { id, projectId };
  }
  const toScaleway = (projectId: string) => () =>
    h.sql`update project set ai_provider = 'scaleway' where id = ${projectId}`;
  const startFinal = async (id: string) =>
    h.queue.enqueue(finalTranscript, {
      conversationId: id,
      provider: "gemini",
      record: true,
      hash: await currentChunkHash(h.deps, id),
    });
  const finals = (id: string) =>
    h.sql`select provider, text from conversation_final_transcript where conversation_id = ${id}`;
  const vertexRequests = () => wire.seen.vertex.length;
  const whisperRequests = () =>
    wire.seen.compat.filter((r) => r.url.endsWith("/audio/transcriptions")).length;

  test("a pass that stays on Google reads every piece there", async () => {
    const c = await conversation(false);
    const before = vertexRequests();
    await startFinal(c.id);
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    expect(rows.map((r) => r.provider)).toEqual(["gemini"]);
    // Several pieces; the next test moves the project after the first.
    expect(vertexRequests() - before).toBeGreaterThanOrEqual(3);
  });

  test("a move at the second piece sends no piece, retry or fallback to Vertex after it, and Scaleway finishes", async () => {
    const c = await conversation(false);
    const before = vertexRequests();
    const whisperBefore = whisperRequests();
    vertex.after = async (n) => {
      if (n === before + 1) await toScaleway(c.projectId)();
    };
    await startFinal(c.id);
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    vertex.after = () => Promise.resolve();
    // Only the first piece reached Vertex; the transcript people read is Whisper's.
    expect(vertexRequests() - before).toBe(1);
    expect(rows.map((r) => r.provider)).toEqual(["whisper"]);
    expect(String(rows[0]?.text)).toContain("whisper heard this");
    expect(whisperRequests() - whisperBefore).toBeGreaterThanOrEqual(1);
  });

  test("a move while a piece is retried sends no second attempt and no fast-model fallback to Vertex", async () => {
    const c = await conversation(false);
    const before = vertexRequests();
    vertex.status = 429;
    vertex.after = async (n) => {
      if (n === before + 1) await toScaleway(c.projectId)();
    };
    await startFinal(c.id);
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    vertex.status = null;
    vertex.after = () => Promise.resolve();
    expect(vertexRequests() - before).toBe(1);
    expect(rows.map((r) => r.provider)).toEqual(["whisper"]);
  });

  test("a move after the last piece sends the redaction of an anonymised conversation nowhere near Vertex", async () => {
    const c = await conversation(true);
    // Every piece is read on Google; the project moves as the last one is answered.
    const probe = await conversation(false);
    const sizing = vertexRequests();
    await startFinal(probe.id);
    await until(async () => (await finals(probe.id)).length || null);
    const pieces = vertexRequests() - sizing;
    expect(pieces).toBeGreaterThanOrEqual(3);

    const before = vertexRequests();
    vertex.after = async (n) => {
      if (n === before + pieces) await toScaleway(c.projectId)();
    };
    await startFinal(c.id);
    const rows = await until(async () => {
      const r = await finals(c.id);
      return r.length ? r : null;
    });
    vertex.after = () => Promise.resolve();
    // The pieces went to Vertex; neither the text pass nor the redaction did.
    expect(vertexRequests() - before).toBe(pieces);
    expect(rows.map((r) => r.provider)).toEqual(["whisper"]);
  });
});
