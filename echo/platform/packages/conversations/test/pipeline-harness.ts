// Shared set-up for the pipeline's integration tests: a throwaway database with the
// platform schema and DBOS installed, the filesystem bucket served over HTTP (so the
// media code fetches and uploads presigned URLs as it does in the cloud), real ffmpeg,
// a fake transcriber and a fake model.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { LocalMedia, type Media } from "@echo/audio";
import { createDb, migrate } from "@echo/db";
import type { Models } from "@echo/llm";
import { createLogger, initTracing, type Logger } from "@echo/observability";
import { installQueueSchema, Queue } from "@echo/queue";
import { FilesystemStorage, localStorageHandler } from "@echo/storage";
import { FakeTranscriber } from "@echo/transcription";
import postgres from "postgres";
import { AudioUrls } from "../src/audio-urls";
import type { PipelineDeps } from "../src/pipeline/steps";
import { conversationWorker } from "../src/pipeline/worker";
import type { RetryPolicy } from "../src/pipeline/workflows";

export const admin = process.env.TEST_DATABASE_ADMIN_URL;

export const quiet: Logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
export const { tracer } = initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 });

/** Retries that finish within a test's timeout. */
export const FAST: RetryPolicy = {
  transcribe: { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 0.2, backoffRate: 1 },
  media: { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 0.2, backoffRate: 1 },
  llm: { retriesAllowed: true, maxAttempts: 2, intervalSeconds: 0.2, backoffRate: 1 },
  db: { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 0.1, backoffRate: 1 },
};

export async function freshDatabase(name: string): Promise<string> {
  const a = postgres(admin as string, { max: 1, onnotice: () => {} });
  await a.unsafe(`drop database if exists ${name} with (force)`);
  await a.unsafe(`create database ${name}`);
  await a.end();
  const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${name}`;
  await migrate(url);
  await installQueueSchema(url);
  return url;
}

export const PROJECT = "f7000000-0000-4000-8000-000000000001";

/** A project open for participation and one conversation in it. */
export async function seed(sql: postgres.Sql, conversationId: string, opts: { anonymise?: boolean } = {}) {
  await sql`insert into project (id, name, language, is_conversation_allowed, anonymize_transcripts)
    values (${PROJECT}, 'Pipeline', 'en', true, false) on conflict do nothing`;
  await sql`insert into conversation (id, project_id, participant_name, source, is_anonymized, created_at, updated_at)
    values (${conversationId}, ${PROJECT}, 'Tester', 'PORTAL_AUDIO', ${opts.anonymise ?? false}, now() - interval '1 hour', now())`;
}

/** A bucket on disk that answers presigned URLs over HTTP, like S3 does. */
export function localBucket(root = mkdtempSync(join(tmpdir(), "echo-pipeline-"))) {
  let storage: FilesystemStorage | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: (req) => localStorageHandler(storage as FilesystemStorage, "/_local-audio")(req),
  });
  storage = new FilesystemStorage(root, `http://127.0.0.1:${server.port}`, "/_local-audio");
  // Stored paths only name objects; a fixed host keeps them valid across worker processes.
  const urls = new AudioUrls("http://audio.test", "local");
  return { storage, urls, server, root };
}

/** A few seconds of tone, encoded by ffmpeg in the given container. */
export async function tone(path: string, seconds: number, codec: string[] = ["-c:a", "libopus"]) {
  const p = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, ...codec, "-y", path],
    { stdout: "ignore", stderr: "pipe" },
  );
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return Bun.file(path);
}

/** A model that answers every call with the same text, and counts the calls. */
export function fakeModels(text = "A short summary.") {
  const calls: string[] = [];
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    async doGenerate() {
      calls.push("generate");
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      } as never;
    },
    async doStream() {
      throw new Error("not used");
    },
  };
  const models: Models = {
    model: () => model,
    embedding: () => {
      throw new Error("not used");
    },
  };
  return { models, calls };
}

export interface Harness {
  readonly deps: PipelineDeps;
  readonly queue: Queue;
  readonly sql: postgres.Sql;
  readonly transcriber: FakeTranscriber;
  readonly bucket: ReturnType<typeof localBucket>;
  stop(): Promise<void>;
}

/** A running worker (DBOS executor) with the conversation pipeline registered. */
export async function startWorker(
  url: string,
  opts: {
    media?: Media;
    transcriber?: FakeTranscriber;
    maxChunkBytes?: number;
    executorId?: string;
    bucketRoot?: string;
  } = {},
): Promise<Harness> {
  const database = createDb({ url, poolMax: 5 });
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  const bucket = localBucket(opts.bucketRoot);
  const transcriber = opts.transcriber ?? new FakeTranscriber();
  const queue = new Queue(url, quiet, tracer, {
    executorId: opts.executorId ?? `test-${crypto.randomUUID().slice(0, 8)}`,
    recovery: { beatMs: 500, deadAfterS: 2 },
  });
  const deps: PipelineDeps = {
    db: database.db,
    audio: bucket.storage,
    audioUrls: bucket.urls,
    media: opts.media ?? new LocalMedia(),
    transcriber,
    models: fakeModels().models,
    jobs: queue,
    logger: quiet,
    now: () => new Date(),
    webhooks: { enabled: false, dashboardUrl: "http://dashboard.test" },
    ...(opts.maxChunkBytes && { maxChunkBytes: opts.maxChunkBytes }),
  };
  const worker = conversationWorker(deps, { retry: FAST });
  await queue.start(worker.jobs);
  await worker.register(queue);
  await queue.run();
  return {
    deps,
    queue,
    sql,
    transcriber,
    bucket,
    async stop() {
      await queue.stop();
      bucket.server.stop(true);
      await sql.end();
      await database.close();
    },
  };
}

export async function until<T>(check: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(100);
  }
}
