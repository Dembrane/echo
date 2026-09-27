import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { PaymentRequiredError } from "@echo/core";
import { createDb } from "@echo/db";
import type { Models } from "@echo/llm";
import { createLogger } from "@echo/observability";
import { FilesystemStorage } from "@echo/storage";
import postgres from "postgres";
import { AudioUrls } from "../src/audio-urls";
import { type ReplyDeps, replyProtocol } from "../src/v1/reply";
import { summarizeAndStore } from "../src/v1/summary";
import { computeTokenCount } from "../src/v1/token-count";

/**
 * Against a copy of the parity seed: the model-backed paths parity can only compare by
 * shape (the summary and its stored side effects, the streamed reply and the stored
 * conversation_reply), with a scripted model standing in for Vertex.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const TEMPLATE = "parity_template_platform";
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
const c2 = id("c1", 2);
const c3 = id("c1", 3);
const p1 = id("f0", 1);
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that answers from a queue of texts and records every prompt. */
function scripted(answers: string[], prompts: unknown[]): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    async doGenerate(o) {
      prompts.push(o.prompt);
      return {
        content: [{ type: "text", text: answers.shift() ?? "" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      } as never;
    },
    async doStream(o) {
      prompts.push(o.prompt);
      const parts: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        ...(answers.shift() ?? "")
          .split("|")
          .map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ];
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      } as never;
    },
  };
}

run("v1 conversation services against the seed", () => {
  setDefaultTimeout(20_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const now = new Date("2026-09-27T12:00:00Z");

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists conversations_v1_test with (force)");
    await a.unsafe(`create database conversations_v1_test template ${TEMPLATE}`);
    await a.end();
    database = createDb({ url: `${base}/conversations_v1_test`, poolMax: 4 });
    sql = postgres(`${base}/conversations_v1_test`, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await sql.end();
    await database.close();
  });

  function deps(answers: string[], prompts: unknown[] = []): ReplyDeps {
    const m = scripted(answers, prompts);
    const models = { model: () => m, embedding: () => ({}) } as unknown as Models;
    return {
      db: database.db,
      models,
      audio: new FilesystemStorage(mkdtempSync(join(tmpdir(), "echo-v1-")), "http://local.test"),
      audioUrls: new AudioUrls("http://local.test", "local"),
      logger: quiet,
      now: () => now,
    };
  }

  test("summarize stores the summary and, with AI titles on, a title and draft tags", async () => {
    await sql`update project set enable_ai_title_and_tags = true where id = ${p1}`;
    const prompts: unknown[] = [];
    const out = await summarizeAndStore(
      deps(["A clear summary.", "Grid delays", `{"tag_ids": ["${id("f2", 2)}", "nope"]}`], prompts),
      c1,
    );
    expect(out).toEqual({
      status: "success",
      message: "Summary generated",
      summary: "A clear summary.",
      title: "Grid delays",
      tag_ids: [id("f2", 2)],
    });
    const [row] = await sql`select summary, title, updated_at from conversation where id = ${c1}`;
    expect(row?.summary).toBe("A clear summary.");
    expect(row?.title).toBe("Grid delays");
    expect(new Date(row?.updated_at).toISOString()).toBe(now.toISOString());
    const tags =
      await sql`select project_tag_id from conversation_project_tag where conversation_id = ${c1} order by id`;
    expect(tags.map((t) => t.project_tag_id)).toEqual([id("f2", 1), id("f2", 2)]);
    // The summary prompt carries the transcript and the project context.
    expect(JSON.stringify(prompts[0])).toContain("charging points near the flats");
    expect(JSON.stringify(prompts[0])).toContain("project context: name: City listening 2026");
  });

  test("a locked conversation is refused with the 402 the dashboard reads", async () => {
    await sql`update conversation set is_over_cap = true where id = ${c3}`;
    await expect(summarizeAndStore(deps([]), c3)).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  test("the token count is stored only while the conversation reads as transcribed", async () => {
    await sql`update conversation set token_count = null where id in (${c1}, ${c2})`;
    const n = await computeTokenCount({ db: database.db, logger: quiet }, c1, () => now);
    expect(n).toBeGreaterThan(40);
    const [one] = await sql`select token_count from conversation where id = ${c1}`;
    expect(one?.token_count).toBe(n);
    await computeTokenCount({ db: database.db, logger: quiet }, c2, () => now);
    const [two] = await sql`select token_count from conversation where id = ${c2}`;
    expect(two?.token_count).toBeNull();
  });

  test("a reply streams in the portal's protocol and is stored", async () => {
    await sql`update project set is_get_reply_enabled = true, get_reply_mode = 'summarize' where id = ${p1}`;
    const prompts: unknown[] = [];
    const lines: string[] = [];
    for await (const l of replyProtocol(deps(["Tell me | more über", ""], prompts), c1, "en"))
      lines.push(l);
    expect(lines).toEqual(['0:"Tell me "\n', '0:" more \\u00fcber"\n']);
    const [reply] =
      await sql`select content_text, type, conversation_id, reply from conversation_reply order by date_created desc limit 1`;
    expect(reply).toEqual({
      content_text: "Tell me  more über",
      type: "assistant_reply",
      conversation_id: c1,
      reply: null,
    });
    // Summarize mode sends the other conversations' summaries, not their transcripts.
    expect(JSON.stringify(prompts[0])).toContain("<name>Resident 1</name>");
  });

  test("replies off streams the portal's error line", async () => {
    await sql`update project set is_get_reply_enabled = false where id = ${p1}`;
    const lines: string[] = [];
    for await (const l of replyProtocol(deps([]), c1, "en")) lines.push(l);
    expect(lines).toEqual(['3:"Something went wrong."\n']);
  });
});
