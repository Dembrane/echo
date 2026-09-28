import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { AudioUrls, ParticipantTokens } from "@dembrane/conversations";
import { PlatformError } from "@dembrane/core";
import { createDb } from "@dembrane/db";
import type { Models } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import { FilesystemStorage } from "@dembrane/storage";
import { Hono } from "hono";
import postgres from "postgres";
import { verifyRoutes } from "../src";

/**
 * Generation and revision against a copy of the parity seed with a fake model: the
 * parity stack's Python API has no model credentials and answers 500 before reading
 * anything, so these paths are proven here.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const TEMPLATE = process.env.PARITY_TEMPLATE ?? "parity_template_platform";
const DB = "conv_verify_test";
const base = admin ? admin.slice(0, admin.lastIndexOf("/")) : "";
const hasTemplate = admin
  ? await (async () => {
      const sql = postgres(admin, { max: 1, onnotice: () => {} });
      const [row] = await sql`select 1 from pg_database where datname = ${TEMPLATE}`;
      await sql.end();
      return Boolean(row);
    })().catch(() => false)
  : false;
const run = hasTemplate ? describe : describe.skip;

const id = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const c1 = id("c1", 1);
const c3 = id("c1", 3);
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

/** A model that records each prompt and answers from a script. */
function fakeModels(answers: string[], prompts: unknown[]): Models {
  const model = {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    async doGenerate(o: { prompt: unknown }) {
      prompts.push(o.prompt);
      return {
        content: [{ type: "text", text: answers.shift() ?? "answer" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("not used");
    },
  };
  return { model: () => model as never, embedding: () => ({}) as never };
}

run("verify generation against the seed", () => {
  setDefaultTimeout(20_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const prompts: unknown[] = [];
  const answers: string[] = [];
  const tokens = new ParticipantTokens("s".repeat(48), false);
  let app: Hono;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.unsafe(`create database ${DB} template ${TEMPLATE}`);
    await a.end();
    database = createDb({ url: `${base}/${DB}`, poolMax: 4 });
    sql = postgres(`${base}/${DB}`, { max: 1, onnotice: () => {} });
    const root = mkdtempSync(join(tmpdir(), "conv-verify-"));
    const audio = new FilesystemStorage(root, "http://local.test", "/_local-audio");
    await audio.put(`conversation/${c1}/chunks/late.mp3`, new Uint8Array([1, 2, 3]));
    const routes = verifyRoutes({
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio,
      audioUrls: new AudioUrls("http://s3.test", "bucket"),
      models: fakeModels(answers, prompts),
      tokens,
      logger: quiet,
      now: () => new Date("2026-09-27T12:00:00Z"),
    });
    // The API's error handler, as the app mounts these routes.
    app = new Hono().route("/", routes);
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  afterAll(async () => {
    await sql.end();
    await database.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: path.includes("/artifact/") ? "PUT" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  test("generate writes an artifact from the transcript and attaches untranscribed audio", async () => {
    await sql`insert into conversation_chunk (id, conversation_id, timestamp, path, source)
      values (${id("c2", 9)}, ${c1}, '2026-09-01T09:40:00Z', ${`http://s3.test/bucket/conversation/${c1}/chunks/late.mp3`}, 'PORTAL_AUDIO')`;
    answers.push("# Hidden gems\n\nCharging matters.");
    const res = await post("/api/verify/generate", { topic_list: ["gems"], conversation_id: c1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact_list: Record<string, unknown>[] };
    expect(body.artifact_list).toHaveLength(1);
    expect(body.artifact_list[0]).toMatchObject({
      key: "gems",
      topic_label: "Hidden gems",
      content: "# Hidden gems\n\nCharging matters.",
      conversation_id: c1,
      approved_at: null,
      read_aloud_stream_url: "",
    });
    const [row] =
      await sql`select key, content, user_created from conversation_artifact where conversation_id = ${c1}`;
    expect(row).toMatchObject({ key: "gems", user_created: null });
    const prompt = JSON.stringify(prompts.at(-1));
    expect(prompt).toContain("Conversation ID: c1000000");
    expect(prompt).toContain("We need more charging points");
    expect(prompt).toContain("Audio attachments for chunks without transcripts");
    expect(prompt).toContain(`Audio chunk ${id("c2", 9)} captured at 2026-09-01T09:40:00+00:00`);
    expect(prompt).toContain('"type":"file"');
  });

  test("an unknown topic, a project without verify, and a wrong token are refused", async () => {
    expect(
      (await post("/api/verify/generate", { topic_list: ["nope"], conversation_id: c1 })).status,
    ).toBe(400);
    const off = await post("/api/verify/generate", { topic_list: ["gems"], conversation_id: c3 });
    expect(off.status).toBe(403);
    const wrong = await post(
      "/api/verify/generate",
      { topic_list: ["gems"], conversation_id: c1 },
      { "x-participant-token": tokens.issue({ conversationId: c3, projectId: id("f0", 3) }) },
    );
    expect(wrong.status).toBe(403);
    const right = await post(
      "/api/verify/generate",
      { topic_list: ["gems"], conversation_id: c1 },
      { "x-participant-token": tokens.issue({ conversationId: c1, projectId: id("f0", 1) }) },
    );
    expect(right.status).toBe(200);
  });

  test("a conversation without chunks answers NO_CHUNKS", async () => {
    await sql`insert into conversation (id, project_id, participant_name) values (${id("c1", 8)}, ${id("f0", 1)}, 'Empty')`;
    const res = await post("/api/verify/generate", {
      topic_list: ["gems"],
      conversation_id: id("c1", 8),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      detail: { code: "NO_CHUNKS", message: "Conversation has no chunks yet" },
    });
  });

  test("revision uses feedback after the timestamp, only on the artifact's own conversation", async () => {
    const [artifact] =
      await sql`select id from conversation_artifact where conversation_id = ${c1} limit 1`;
    const path = `/api/verify/artifact/${artifact?.id}`;
    const other = await post(path, {
      useConversation: { conversationId: c3, timestamp: "2026-09-01T00:00:00Z" },
    });
    expect(other.status).toBe(400);
    const none = await post(path, {
      useConversation: { conversationId: c1, timestamp: "2027-01-01T00:00:00Z" },
    });
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({
      detail: {
        code: "NO_NEW_FEEDBACK",
        message: "No new feedback found since provided timestamp",
      },
    });
    answers.push("Revised outcome");
    const res = await post(path, {
      useConversation: { conversationId: c1, timestamp: "2026-09-01T09:21:00Z" },
      approvedAt: "2026-09-27T12:00:00Z",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      content: "Revised outcome",
      approved_at: "2026-09-27T12:00:00.000Z",
    });
    const prompt = JSON.stringify(prompts.at(-1));
    expect(prompt).toContain("Buses stop running at eleven");
  });
});
