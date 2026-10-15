import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId } from "@dembrane/core";
import { TranscriptParseError } from "@dembrane/transcription";
import { bffStore } from "../src/bff/storage";
import { createChunk } from "../src/chunks";
import {
  admin,
  freshDatabase,
  type Harness,
  PROJECT,
  seed,
  startWorker,
  until,
} from "./pipeline-harness";

// A typed contribution to an anonymised project is redacted by the chunk run, as audio is.
const run = admin ? describe : describe.skip;

const RAW =
  "Hello, my name is Jan Jansen, mail jan@example.nl, and I phoned the helpdesk on 06 12345678.";

run("typed chunks and anonymisation", () => {
  setDefaultTimeout(60_000);
  let h: Harness;

  beforeAll(async () => {
    h = await startWorker(await freshDatabase("conv_pipeline_typed"));
  });
  afterAll(async () => {
    await h?.stop();
  });

  async function type(cid: string) {
    const chunkId = newId();
    const row = await createChunk(
      { ...h.deps, jobs: h.queue },
      { conversationId: cid, timestamp: new Date(), source: "PORTAL_TEXT", transcript: RAW },
      { chunkId },
    );
    return { chunkId, row };
  }
  const chunk = async (id: string) =>
    (await h.sql`select * from conversation_chunk where id = ${id}`)[0] as Record<string, unknown>;

  test("an anonymised conversation stores the redacted text and never the raw one", async () => {
    const cid = newId();
    await seed(h.sql, cid, { anonymise: true });
    h.transcriber.redactCalls.length = 0;
    const { chunkId, row } = await type(cid);
    expect(row.transcript).toBeNull();
    expect(JSON.stringify(row)).not.toContain("jan@example.nl");
    const done = await until(async () => {
      const c = await chunk(chunkId);
      return c.transcript ? c : null;
    });
    const text = done.transcript as string;
    expect(text).toContain("<redacted_email>");
    expect(text).toContain("<redacted_phone>");
    expect(text).not.toContain("jan@example.nl");
    expect(text).not.toContain("12345678");
    // Neither the row nor the queue's tables keep the raw text once redaction is done.
    expect(done.pending_text).toBeNull();
    const kept =
      await h.sql`select (select coalesce(string_agg(inputs::text, ' '), '') from dbos.workflow_status)
      || (select coalesce(string_agg(output::text, ' '), '') from dbos.operation_outputs) as t`;
    expect(String(kept[0]?.t)).not.toContain("jan@example.nl");
    expect(h.transcriber.redactCalls).toHaveLength(1);
    expect(h.transcriber.redactCalls[0]?.anonymizeTranscripts).toBe(true);
  });

  test("no reader returns the text while it waits", async () => {
    const cid = newId();
    await seed(h.sql, cid, { anonymise: true });
    const chunkId = newId();
    await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, source, pending_text)
      values (${chunkId}, ${cid}, now(), 'PORTAL_TEXT', ${RAW})`;
    const store = bffStore(h.deps.db);
    const seen = JSON.stringify([
      ...(await store.allChunks(cid)),
      ...(await store.chunkPage(cid, {
        sort: "timestamp",
        limit: 10,
        offset: 0,
        fields: ["*", "pending_text"],
      })),
    ]);
    expect(seen).not.toContain("jan@example.nl");
  });

  test("a project that turned anonymising on after the conversation began still redacts", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await h.sql`update project set anonymize_transcripts = true where id = ${PROJECT}`;
    const { chunkId } = await type(cid);
    const done = await until(async () => {
      const c = await chunk(chunkId);
      return c.transcript ? c : null;
    });
    expect(done.transcript as string).not.toContain("jan@example.nl");
    await h.sql`update project set anonymize_transcripts = false where id = ${PROJECT}`;
  });

  test("a normal project keeps the text verbatim and calls no model", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    h.transcriber.redactCalls.length = 0;
    const { row } = await type(cid);
    expect(row.transcript).toBe(RAW);
    expect((await chunk(row.id as string)).transcript).toBe(RAW);
    expect(h.transcriber.redactCalls).toHaveLength(0);
  });

  test("a redaction that fails every attempt leaves no text and an error on the chunk", async () => {
    const cid = newId();
    await seed(h.sql, cid, { anonymise: true });
    h.transcriber.failNext(
      new Error("vertex 503"),
      new Error("vertex 503"),
      new Error("vertex 503"),
    );
    const { chunkId } = await type(cid);
    const done = await until(async () => {
      const c = await chunk(chunkId);
      return c.error ? c : null;
    });
    expect(done.transcript).toBeNull();
    expect(done.pending_text).toBeNull();
    expect(JSON.stringify(done)).not.toContain("jan@example.nl");
  });

  test("a recoverable failure is saved at once and the raw text is not stored", async () => {
    const cid = newId();
    await seed(h.sql, cid, { anonymise: true });
    h.transcriber.failNext(new TranscriptParseError("cut off", "length"));
    const { chunkId } = await type(cid);
    const done = await until(async () => {
      const c = await chunk(chunkId);
      return c.error ? c : null;
    });
    expect(done.transcript).toBeNull();
    expect(done.pending_text).toBeNull();
  });
});
