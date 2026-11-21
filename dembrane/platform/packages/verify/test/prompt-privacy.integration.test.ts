import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { AudioUrls, ParticipantTokens } from "@dembrane/conversations";
import { createDb, migrate } from "@dembrane/db";
import { fakeModels } from "@dembrane/llm";
import { createLogger, withPayer } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import postgres from "postgres";
import { verifyRoutes } from "../src";
import { seedDefaultTopics } from "../src/defaults";

/**
 * ECHO-1052: the participant's email (and name) never reach the model in Verify, in
 * generation or revision, and never reach the logs, also when the model call fails. The
 * project context and key terms do reach it, as reference material. Everything the model
 * is sent is captured from the call itself, so a new field anywhere in the payload counts.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `verify_privacy_${process.pid}`;
const project = "f9100000-0000-4000-8000-000000000001";
const conversation = "c9200000-0000-4000-8000-000000000001";
const EMAIL = "ada.quietwater@example.org";
const NAME = "Ada Quietwater";
const SAID = "We need more benches along the Lindenpad.";
const FEEDBACK = "Add that the benches need shade.";

setDefaultTimeout(60_000);

run("verify prompt privacy", () => {
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const calls: unknown[] = [];
  const logs: string[] = [];
  const logger = createLogger(
    { service: "t", release: "r", env: "test", level: "debug" },
    new Writable({
      write: (chunk, _e, cb) => {
        logs.push(String(chunk));
        cb();
      },
    }),
  );
  let ok: ReturnType<typeof verifyRoutes>;
  let failing: ReturnType<typeof verifyRoutes>;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    await seedDefaultTopics(database.db);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into project (id, name, language, is_conversation_allowed, is_verify_enabled,
        context, default_conversation_transcript_prompt, template_key)
      values (${project}, 'Benches for Lindenwijk', 'en', true, true,
        'A neighbourhood session about public seating.', 'Lindenpad, Lindenwijk, Lindenpad', 'event')`;
    await sql`insert into conversation (id, project_id, participant_name, participant_email)
      values (${conversation}, ${project}, ${NAME}, ${EMAIL})`;
    await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp)
      values ('c9300000-0000-4000-8000-000000000001', ${conversation}, ${SAID}, '2026-11-10T10:00:00Z')`;
    const base = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: new FilesystemStorage(
        mkdtempSync(join(tmpdir(), "verify-privacy-")),
        "http://t",
        "/a",
      ),
      audioUrls: new AudioUrls("http://s3.test", "bucket"),
      tokens: new ParticipantTokens("s".repeat(48), false),
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger,
      now: () => new Date("2026-11-10T12:00:00Z"),
    };
    ok = verifyRoutes({
      ...base,
      models: fakeModels({
        text: "Draft for this table to correct.\n- Benches.\nIs this right?",
        calls: calls as never,
      }),
    });
    // A failure shaped like the model SDK's: it carries the request it sent.
    const fail = Object.assign(new Error("upstream said no"), {
      name: "AI_APICallError",
      statusCode: 500,
      requestBodyValues: { contents: [{ text: `${SAID} ${EMAIL} ${NAME}` }] },
    });
    failing = verifyRoutes({ ...base, models: fakeModels({ fail }) });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const send = (
    routes: ReturnType<typeof verifyRoutes>,
    path: string,
    method: string,
    body: unknown,
  ) =>
    routes.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("every built-in topic is generated without the email or name, with context and key terms", async () => {
    const keys = ["agreements", "disagreements", "actions", "gems", "truths", "heard", "moments"];
    for (const key of keys) {
      calls.length = 0;
      const res = await send(ok, "/api/verify/generate", "POST", {
        topic_list: [key],
        conversation_id: conversation,
      });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      const payload = JSON.stringify(calls);
      expect(payload).not.toContain(EMAIL);
      expect(payload).not.toContain("example.org");
      expect(payload).not.toContain(NAME);
      expect(payload).not.toContain("Participant email");
      expect(payload).not.toContain("Participant name");
      expect(payload).toContain(SAID);
      expect(payload).toContain("<reference_material>");
      expect(payload).toContain("A neighbourhood session about public seating.");
      expect(payload).toContain("<key_terms>\\nLindenpad, Lindenwijk\\n</key_terms>");
      expect(payload).toContain("Draft for this table to correct.");
    }
  });

  test("a revision sends neither the email nor the name", async () => {
    const [artifact] = await sql<{ id: string }[]>`
      select id from conversation_artifact where conversation_id = ${conversation} limit 1`;
    await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp)
      values ('c9300000-0000-4000-8000-000000000002', ${conversation}, ${FEEDBACK}, '2026-11-10T11:00:00Z')`;
    calls.length = 0;
    // In the API the payer middleware names the artifact's conversation; here the test does.
    const res = await withPayer({ ref: "conversation", id: conversation }, () =>
      send(ok, `/api/verify/artifact/${artifact?.id}`, "PUT", {
        useConversation: { conversationId: conversation, timestamp: "2026-11-10T10:30:00Z" },
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const payload = JSON.stringify(calls);
    expect(payload).not.toContain(EMAIL);
    expect(payload).not.toContain(NAME);
    expect(payload).toContain(FEEDBACK);
    expect(payload).toContain("<key_terms>\\nLindenpad, Lindenwijk\\n</key_terms>");
  });

  test("a failed model call logs neither the email, the name nor what was said", async () => {
    logs.length = 0;
    const res = await send(failing, "/api/verify/generate", "POST", {
      topic_list: ["agreements"],
      conversation_id: conversation,
    });
    expect(res.status).toBe(500);
    const written = logs.join("");
    expect(written).toContain("verify completion failed");
    expect(written).toContain("AI_APICallError");
    expect(written).not.toContain(EMAIL);
    expect(written).not.toContain(NAME);
    expect(written).not.toContain(SAID);
  });

  test("the logs of the whole run never held the email", () => {
    expect(logs.join("")).not.toContain(EMAIL);
  });
});
