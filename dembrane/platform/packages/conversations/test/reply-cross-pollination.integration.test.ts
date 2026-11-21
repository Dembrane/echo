import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@dembrane/db";
import { fakeModels } from "@dembrane/llm";
import { withPayer } from "@dembrane/observability";
import { FilesystemStorage } from "@dembrane/storage";
import postgres from "postgres";
import { AudioUrls } from "../src";
import { replyProtocol } from "../src/v1/reply";
import { admin, freshDatabase, quiet } from "./pipeline-harness";

/**
 * ECHO-1052, Explore's cross-pollination: on (every project, new or existing, until a
 * host turns it off), the model reads the project's other conversations too, as "another
 * group", never by name; off, it reads this conversation only. No participant's name or
 * email reaches the model either way. Captured from the model call itself.
 */
const run = admin ? describe : describe.skip;
const DB = `reply_cross_${process.pid}`;
const project = "f7100000-0000-4000-8000-000000000001";
const current = "c7100000-0000-4000-8000-000000000001";
const other = "c7100000-0000-4000-8000-000000000002";
const SAID_HERE = "The bus stop by the school floods every winter.";
const SAID_THERE = "Our table wants a footbridge over the canal.";

setDefaultTimeout(60_000);

run("Explore cross-pollination", () => {
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const calls: unknown[] = [];

  beforeAll(async () => {
    const url = await freshDatabase(DB);
    database = createDb({ url, poolMax: 2 });
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into project (id, name, language, is_conversation_allowed, is_get_reply_enabled,
        get_reply_mode, context, default_conversation_transcript_prompt)
      values (${project}, 'Getting around', 'en', true, true, 'summarize',
        'How people in the north of town get around.', 'Noorderkade')`;
    await sql`insert into conversation (id, project_id, participant_name, participant_email)
      values (${current}, ${project}, 'Willa Brightmoor', 'willa@example.org')`;
    await sql`insert into conversation (id, project_id, participant_name, participant_email, summary)
      values (${other}, ${project}, 'Osric Fenwhistle', 'osric@example.org', ${SAID_THERE})`;
    await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp)
      values ('c7200000-0000-4000-8000-000000000001', ${current}, ${SAID_HERE}, '2026-11-10T10:00:00Z')`;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.end();
  });

  async function reply(): Promise<string> {
    calls.length = 0;
    const d = {
      db: database.db,
      models: fakeModels({ text: "What would change if it did not flood?", calls: calls as never }),
      audio: new FilesystemStorage(mkdtempSync(join(tmpdir(), "reply-cross-")), "http://t"),
      audioUrls: new AudioUrls("http://t", "local"),
      logger: quiet,
      now: () => new Date("2026-11-10T12:00:00Z"),
    };
    const lines: string[] = [];
    await withPayer({ ref: "conversation", id: current }, async () => {
      for await (const l of replyProtocol(d, current, "en")) lines.push(l);
    });
    expect(lines.join("")).toContain("What would change");
    expect(calls).toHaveLength(1);
    return JSON.stringify(calls);
  }

  const noPeople = (payload: string) => {
    for (const s of [
      "Willa Brightmoor",
      "Osric Fenwhistle",
      "willa@example.org",
      "osric@example.org",
      "example.org",
    ])
      expect(payload).not.toContain(s);
  };

  test("on by default: other conversations come in as another group, without names", async () => {
    const [row] =
      await sql`select is_get_reply_cross_pollination_enabled as on from project where id = ${project}`;
    expect(row?.on).toBe(true);
    const payload = await reply();
    expect(payload).toContain(SAID_HERE);
    expect(payload).toContain(SAID_THERE);
    expect(payload).toContain("<name>another group</name>");
    expect(payload).toContain("<name>this conversation</name>");
    noPeople(payload);
  });

  test("off: only this conversation, plus context and key terms", async () => {
    await sql`update project set is_get_reply_cross_pollination_enabled = false where id = ${project}`;
    const payload = await reply();
    expect(payload).toContain(SAID_HERE);
    expect(payload).not.toContain(SAID_THERE);
    expect(payload).not.toContain("another group");
    expect(payload).toContain("How people in the north of town get around.");
    expect(payload).toContain("Key terms (for names and spelling only): Noorderkade");
    noPeople(payload);
    // The tests below ran with it on before the default turned: keep that.
    await sql`update project set is_get_reply_cross_pollination_enabled = true where id = ${project}`;
  });

  test("the default mode asks one question and drops the 1-3 sentences and we/our lines", async () => {
    const payload = await reply();
    expect(payload).toContain("Ask the group one open question, at most 25 words");
    expect(payload).not.toContain("1-3 sentences");
    expect(payload).not.toContain("we/our");
  });

  test("a custom prompt keeps the wrapper it had", async () => {
    await sql`update project set get_reply_mode = 'custom', get_reply_prompt = 'Our own prompt.' where id = ${project}`;
    const payload = await reply();
    expect(payload).toContain("Our own prompt.");
    expect(payload).toContain("1-3 sentences");
    expect(payload).toContain("Default Conversation Transcript Prompt: Noorderkade");
    noPeople(payload);
  });
});
