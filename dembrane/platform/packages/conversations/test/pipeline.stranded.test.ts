import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { newId } from "@dembrane/core";
import { FakeTranscriber } from "@dembrane/transcription";
import { createChunk } from "../src/chunks";
import { finishConversation, processChunk } from "../src/pipeline/defs";
import { CHUNK_GAVE_UP, releaseStrandedChunks, strandedChunkRuns } from "../src/pipeline/steps";
import {
  admin,
  freshDatabase,
  type Harness,
  seed,
  startWorker,
  tone,
  until,
} from "./pipeline-harness";

// Prod 2026-10-12: a chunk run cancelled at its deadline or set aside left its chunk pending,
// so the finished recording never finalized, and the run id deduped any re-enqueue.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

run("a chunk run that ends without a result", () => {
  setDefaultTimeout(120_000);
  let h: Harness;
  // Transcription calls that never return.
  let hang = 0;

  beforeAll(async () => {
    const url = await freshDatabase("conv_pipeline_stranded");
    const transcriber = new FakeTranscriber();
    const plain = transcriber.transcribe.bind(transcriber);
    transcriber.transcribe = async (input) => {
      if (hang > 0) {
        hang--;
        transcriber.calls.push(input);
        await new Promise(() => {});
      }
      return plain(input);
    };
    h = await startWorker(url, { transcriber, maxChunkBytes: 60_000 });
  });
  afterAll(async () => {
    await h?.stop();
  });

  async function upload(cid: string, seconds: number, codec?: string[]) {
    const chunkId = newId();
    const name = codec ? "rec.mp3" : "rec.webm";
    const key = `conversation/${cid}/chunks/${chunkId}-${name}`;
    await h.deps.audio.put(
      key,
      await tone(join(h.bucket.root, `${chunkId}-${name}`), seconds, codec),
    );
    await createChunk(
      { ...h.deps, jobs: h.queue },
      {
        conversationId: cid,
        timestamp: new Date(),
        source: "PORTAL_AUDIO",
        fileUrl: h.deps.audioUrls.fileUrl(key),
      },
      { chunkId },
    );
    return chunkId;
  }

  const status = async (id: string) =>
    (await h.sql`select status from dbos.workflow_status where workflow_uuid = ${id}`)[0]?.status as
      | string
      | undefined;
  const conversation = async (cid: string) =>
    (await h.sql`select * from conversation where id = ${cid}`)[0] as Record<string, unknown>;
  const pending = async (cid: string) =>
    (
      await h.sql`select id from conversation_chunk
        where conversation_id = ${cid} and transcript is null and error is null`
    ).map((r) => r.id as string);

  /** A finished recording with one transcribed chunk and one whose run hangs. */
  async function stuckRecording() {
    const cid = newId();
    await seed(h.sql, cid);
    const first = await upload(cid, 2);
    await until(async () => (await pending(cid)).length === 0);
    const calls = h.transcriber.calls.length;
    hang = 1;
    const stuck = await upload(cid, 2);
    await until(async () => h.transcriber.calls.length > calls);
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    await until(async () => (await conversation(cid)).is_finished === true);
    return { cid, first, stuck };
  }

  /** Lets DBOS's own timeout sweep cancel the run, as it did in prod. */
  async function expire(workflowId: string) {
    await h.sql`update dbos.workflow_status set workflow_deadline_epoch_ms = 1
      where workflow_uuid = ${workflowId}`;
    await until(async () => (await status(workflowId)) === "CANCELLED");
  }

  const finalized = (cid: string) =>
    until(async () => {
      const c = await conversation(cid);
      return c.is_all_chunks_transcribed && c.summary && c.merged_audio_path && c.duration !== null
        ? c
        : null;
    });

  test("a run cancelled at its deadline runs again and the recording finalizes whole", async () => {
    const { cid, stuck } = await stuckRecording();
    const id = `conversations.chunk:${stuck}`;
    await expire(id);

    // The prod state: one chunk pending for good, and a re-enqueue is a no-op.
    await Bun.sleep(1500);
    expect(await pending(cid)).toEqual([stuck]);
    expect((await conversation(cid)).is_all_chunks_transcribed).not.toBe(true);
    await h.queue.enqueue(
      processChunk,
      { chunkId: stuck, usePiiRedaction: false },
      { workflowId: id },
    );
    expect(await status(id)).toBe("CANCELLED");

    const calls = h.transcriber.calls.length;
    await releaseStrandedChunks(h.deps, h.queue);
    const c = await finalized(cid);
    expect(await status(`${id}:again`)).toBe("SUCCESS");
    const [chunk] =
      await h.sql`select transcript, error from conversation_chunk where id = ${stuck}`;
    expect(String(chunk?.transcript)).toStartWith("transcript of ");
    expect(chunk?.error).toBeNull();
    // Resumed at the hung transcription, not from scratch.
    expect(h.transcriber.calls.length).toBe(calls + 1);
    expect(Number(c.duration)).toBeGreaterThan(3);
  });

  test("a run set aside after losing its worker gives up its chunk and the rest finalizes", async () => {
    const { cid, stuck } = await stuckRecording();
    const id = `conversations.chunk:${stuck}`;
    // What recovery's setAside does.
    await h.sql`update dbos.workflow_status set status = 'CANCELLED', queue_name = null
      where workflow_uuid = ${id}`;
    await h.sql`insert into dbos_workflow_lost_worker (workflow_id, queue_name, lost, set_aside_at)
      values (${id}, 'conversations.chunk', 11, now())`;

    await releaseStrandedChunks(h.deps, h.queue);
    const c = await finalized(cid);
    expect(await status(`${id}:again`)).toBeUndefined();
    const [chunk] =
      await h.sql`select transcript, error from conversation_chunk where id = ${stuck}`;
    expect(chunk?.transcript).toBeNull();
    expect(chunk?.error).toBe(CHUNK_GAVE_UP);
    expect(c.summary).toBe("A short summary.");
    expect((await strandedChunkRuns(h.deps.db, new Date())).map((r) => r.id)).not.toContain(id);
  });

  test("a run that ends without a result twice gives up its chunk", async () => {
    const { cid, stuck } = await stuckRecording();
    const id = `conversations.chunk:${stuck}`;
    await expire(id);
    const calls = h.transcriber.calls.length;
    hang = 1;
    await releaseStrandedChunks(h.deps, h.queue);
    await until(async () => h.transcriber.calls.length > calls);
    await expire(`${id}:again`);

    await releaseStrandedChunks(h.deps, h.queue);
    const c = await finalized(cid);
    const [chunk] = await h.sql`select error from conversation_chunk where id = ${stuck}`;
    expect(chunk?.error).toBe(CHUNK_GAVE_UP);
    expect(c.summary).toBe("A short summary.");
    expect((await strandedChunkRuns(h.deps.db, new Date())).map((r) => r.id)).not.toContain(id);
  });

  test("a split chunk's run cancelled between its pieces transcribes the rest", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const calls = h.transcriber.calls.length;
    // Hangs on the second piece.
    const original = h.transcriber.transcribe;
    let n = 0;
    h.transcriber.transcribe = async (input) => {
      if (++n === 2) hang = 1;
      return original(input);
    };
    const parent = await upload(cid, 12, ["-c:a", "libmp3lame", "-b:a", "128k"]);
    await until(async () => h.transcriber.calls.length >= calls + 2);
    h.transcriber.transcribe = original;
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    await until(async () => (await conversation(cid)).is_finished === true);
    const id = `conversations.chunk:${parent}`;
    await expire(id);
    const left = await pending(cid);
    expect(left.length).toBeGreaterThan(0);
    expect(left).not.toContain(parent);

    await releaseStrandedChunks(h.deps, h.queue);
    await finalized(cid);
    expect(await pending(cid)).toEqual([]);
    expect(await status(`${id}:again`)).toBe("SUCCESS");
  });

  test("a run that is still going, or that finished, is left alone", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const done = await upload(cid, 2);
    await until(async () => (await status(`conversations.chunk:${done}`)) === "SUCCESS");
    await releaseStrandedChunks(h.deps, h.queue);
    expect(await status(`conversations.chunk:${done}:again`)).toBeUndefined();
  });
});
