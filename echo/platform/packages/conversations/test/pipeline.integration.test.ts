import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { newId } from "@echo/core";
import { createChunk } from "../src/chunks";
import { finishConversation } from "../src/pipeline/defs";
import { pieceId } from "../src/pipeline/steps";
import { admin, freshDatabase, type Harness, seed, startWorker, tone, until } from "./pipeline-harness";

// Upload to transcript to merged audio to summary, through the real workflows on DBOS,
// the filesystem bucket served over HTTP and real ffmpeg. Needs Postgres and ffmpeg.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

run("conversation pipeline", () => {
  setDefaultTimeout(120_000);
  let h: Harness;

  beforeAll(async () => {
    const url = await freshDatabase("conv_pipeline_test");
    // A 60 KB split threshold, so a few seconds of mp3 is cut into pieces.
    h = await startWorker(url, { maxChunkBytes: 60_000 });
  });
  afterAll(async () => {
    await h?.stop();
  });

  async function upload(conversationId: string, file: Blob, name: string) {
    const chunkId = newId();
    const key = `conversation/${conversationId}/chunks/${chunkId}-${name}`;
    await h.deps.audio.put(key, file);
    return createChunk(
      { ...h.deps, jobs: h.queue },
      { conversationId, timestamp: new Date(), source: "PORTAL_AUDIO", fileUrl: h.deps.audioUrls.fileUrl(key) },
      { chunkId },
    );
  }

  const conversation = async (id: string) =>
    (await h.sql`select * from conversation where id = ${id}`)[0] as Record<string, unknown>;
  const chunks = (id: string) =>
    h.sql`select * from conversation_chunk where conversation_id = ${id} order by timestamp, id`;

  test("a webm chunk is converted, transcribed, then merged and summarised after finish", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const file = await tone(join(h.bucket.root, "in.webm"), 3);
    const chunk = await upload(cid, file, "rec.webm");

    // Converted to mp3 on the same key with the new extension, then transcribed.
    const [done] = await until(async () => {
      const rows = await chunks(cid);
      return rows[0]?.transcript ? rows : null;
    });
    expect(done?.id).toBe(chunk.id);
    expect(done?.path).toBe(h.deps.audioUrls.fileUrl(`conversation/${cid}/chunks/${chunk.id}-rec.mp3`));
    expect(String(done?.transcript)).toStartWith("transcript of ");
    expect(done?.diarization).toMatchObject({ schema: "Dembrane-26-07-gemini" });
    expect((await conversation(cid)).recording_started_at).not.toBeNull();

    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    const final = await until(async () => {
      const c = await conversation(cid);
      return c.summary && c.merged_audio_path && c.token_count !== null ? c : null;
    });
    expect(final.is_finished).toBe(true);
    expect(final.is_all_chunks_transcribed).toBe(true);
    expect(final.summary).toBe("A short summary.");
    expect(Number(final.duration)).toBeGreaterThan(2);
    expect(String(final.merged_audio_path)).toContain(`audio-conversations/merged-${cid}-`);
    const statuses = await h.sql`select event from processing_status where conversation_id = ${cid}`;
    expect(statuses.map((s) => s.event)).toEqual(
      expect.arrayContaining([
        "task_process_conversation_chunk.split_audio_chunk.completed",
        "task_transcribe_chunk.completed",
        "task_merge_conversation_chunks.completed",
        "task_summarize_conversation.completed",
      ]),
    );
  });

  test("a file above the split size becomes pieces with derived ids, and the original goes", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const file = await tone(join(h.bucket.root, "long.mp3"), 12, ["-c:a", "libmp3lame", "-b:a", "128k"]);
    expect(file.size).toBeGreaterThan(120_000);
    const chunk = await upload(cid, file, "long.mp3");
    const rows = await until(async () => {
      const r = await chunks(cid);
      return r.length > 1 && r.every((c) => c.transcript) ? r : null;
    });
    const n = rows.length;
    expect(n).toBe(Math.ceil(file.size / 60_000));
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: n }, (_, i) => pieceId(chunk.id, i)));
    expect(rows.some((r) => r.id === chunk.id)).toBe(false);
    expect(String(rows[1]?.path)).toContain(`chunks/${cid}/${pieceId(chunk.id, 1)}_1-of-${n}.mp3`);
    // Pieces are timestamped where they start in the recording.
    expect(new Date(String(rows[1]?.timestamp)).getTime()).toBeGreaterThan(
      new Date(String(rows[0]?.timestamp)).getTime(),
    );
  });

  test("audio too small to play is marked, and the conversation still finalizes", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await upload(cid, new Blob([new Uint8Array(200)]), "tiny.webm");
    const [row] = await until(async () => {
      const r = await chunks(cid);
      return r[0]?.error ? r : null;
    });
    expect(row?.error).toBe("Audio not playable");
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    const c = await until(async () => {
      const x = await conversation(cid);
      return x.is_all_chunks_transcribed ? x : null;
    });
    expect(c.is_finished).toBe(true);
  });

  test("a transcription that keeps failing saves its error and does not block finalize", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    h.transcriber.failNext(new Error("vertex 503"), new Error("vertex 503"), new Error("vertex 503"));
    await upload(cid, await tone(join(h.bucket.root, "f.webm"), 2), "f.webm");
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    const c = await until(async () => {
      const x = await conversation(cid);
      return x.is_all_chunks_transcribed ? x : null;
    });
    expect(c.is_finished).toBe(true);
    const [row] = await chunks(cid);
    expect(row?.transcript).toBeNull();
    expect(String(row?.error)).toContain("vertex 503");
  });

  test("finishing before the last chunk is transcribed finalizes once the chunk lands", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    // Finish first: nothing uploaded yet is pending, so the finish hands over to finalize
    // only when the chunk run does.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = h.transcriber.transcribe.bind(h.transcriber);
    h.transcriber.transcribe = async (i) => {
      await gate;
      return original(i);
    };
    await upload(cid, await tone(join(h.bucket.root, "g.webm"), 2), "g.webm");
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    await until(async () => (await conversation(cid)).is_finished);
    await Bun.sleep(500);
    expect((await conversation(cid)).is_all_chunks_transcribed).not.toBe(true);
    release();
    const c = await until(async () => {
      const x = await conversation(cid);
      return x.is_all_chunks_transcribed && x.summary ? x : null;
    });
    expect(c.summary).toBe("A short summary.");
    h.transcriber.transcribe = original;
  });

  test("finishing twice finalizes once", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript, source)
      values (${newId()}, ${cid}, now(), 'typed words', 'PORTAL_TEXT')`;
    await Promise.all([
      h.queue.enqueue(finishConversation, { conversationId: cid }),
      h.queue.enqueue(finishConversation, { conversationId: cid }),
    ]);
    await until(async () => (await conversation(cid)).summary);
    await Bun.sleep(1000);
    const summaries = await h.sql`
      select count(*)::int as n from processing_status
      where conversation_id = ${cid} and event = 'task_summarize_conversation.completed'`;
    expect(summaries[0]?.n).toBe(1);
  });
});
