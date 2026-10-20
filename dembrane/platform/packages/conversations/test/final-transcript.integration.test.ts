import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { newId } from "@dembrane/core";
import { FakeTranscriber } from "@dembrane/transcription";
import { createChunk } from "../src/chunks";
import { finishConversation } from "../src/pipeline/defs";
import { v1Store } from "../src/v1/storage";
import { bursts, fakeProvider, timedLive } from "./final-helpers";
import { admin, freshDatabase, type Harness, seed, startWorker, until } from "./pipeline-harness";

// The final pass through the real workflows: two chunks of speech-like bursts with pauses
// are merged, cut at a pause, transcribed by a fake provider and stored beside the chunks.
const run = admin && Bun.which("ffmpeg") ? describe : describe.skip;

run("final transcript", () => {
  setDefaultTimeout(120_000);
  let h: Harness;
  const whisper = fakeProvider(9);
  const gemini = fakeProvider(600);
  const redacted: string[] = [];

  beforeAll(async () => {
    const url = await freshDatabase("conv_final_test");
    h = await startWorker(url, {
      transcriber: new FakeTranscriber(undefined, timedLive),
      final: {
        profile: "test-profile",
        recordings: "redo",
        uploads: "first-pass",
        timedPieceSeconds: 9,
        providers: ["whisper", "gemini"],
        transcribers: { whisper, gemini },
        edit: {
          providers: ["whisper"],
          run: async (sentences) => ({
            sentences: sentences.map((x) => ({ ...x, text: `${x.text}!` })),
            stats: {
              sentences: sentences.length,
              edited: sentences.length,
              changedWords: 0,
              rejected: 0,
              failedBatches: 0,
              inputTokens: 1,
              outputTokens: 1,
            },
          }),
        },
        redact: async (text) => {
          redacted.push(text);
          return text.replaceAll("Zin", "<redacted>");
        },
      },
    });
  });
  afterAll(async () => {
    await h?.stop();
  });

  async function upload(conversationId: string, file: Blob, n: number, source = "PORTAL_AUDIO") {
    const chunkId = newId();
    const key = `conversation/${conversationId}/chunks/${chunkId}-rec${n}.mp3`;
    await h.deps.audio.put(key, file);
    await createChunk(
      { ...h.deps, jobs: h.queue },
      {
        conversationId,
        timestamp: new Date(Date.now() + n * 1000),
        source,
        fileUrl: h.deps.audioUrls.fileUrl(key),
      },
      { chunkId },
    );
  }
  const finals = (id: string) =>
    h.sql`select * from conversation_final_transcript where conversation_id = ${id} order by provider`;
  const record = (id: string) =>
    h.sql`select * from conversation_record_transcript where conversation_id = ${id}`;

  async function finished(
    id: string,
    chunks: number,
    anonymise = false,
    source = "PORTAL_AUDIO",
    burstsPerFile = 3,
  ) {
    await seed(h.sql, id, { anonymise, source });
    for (let n = 0; n < chunks; n++)
      await upload(
        id,
        await bursts(join(h.bucket.root, `b${n}-${burstsPerFile}.mp3`), burstsPerFile),
        n,
        source,
      );
    await until(async () => {
      const rows =
        await h.sql`select transcript from conversation_chunk where conversation_id = ${id}`;
      // An upload can be cut into more pieces than files were uploaded.
      return rows.length >= chunks && rows.every((r) => r.transcript) ? rows : null;
    });
    await h.queue.enqueue(finishConversation, { conversationId: id }, { singletonKey: id });
  }

  test("two providers run on one conversation; the first is the record, cut at a pause", async () => {
    const cid = newId();
    await finished(cid, 2);
    const rows = await until(async () => {
      const r = await finals(cid);
      return r.length === 2 ? r : null;
    });
    expect(rows.map((r) => [r.provider, r.is_record])).toEqual([
      ["gemini", false],
      ["whisper", true],
    ]);
    const w = rows.find((r) => r.provider === "whisper") as Record<string, unknown>;
    // ~19 s of audio at 9 s per piece: three pieces, each ending in a pause, none cut by the clock.
    const usage = w.usage as { pieces: number; hardCuts: number; seconds: number };
    expect(usage.pieces).toBeGreaterThanOrEqual(3);
    expect(usage.hardCuts).toBe(0);
    const sentences = w.sentences as { start: number; end: number; text: string }[];
    expect(sentences.length).toBeGreaterThan(3);
    for (const [i, s] of sentences.entries()) {
      expect(s.end).toBeGreaterThanOrEqual(s.start);
      if (i) expect(s.start).toBeGreaterThanOrEqual((sentences[i - 1] as { end: number }).end);
    }
    // The second piece's times are counted from the start of the merged file.
    expect(sentences.some((s) => s.start > 9)).toBe(true);

    // The text pass ran for Whisper only, inside sentences: times unchanged, ids are positions.
    expect(sentences.every((x) => x.text.endsWith("!"))).toBe(true);
    expect((w.usage as { textPass?: { edited: number } }).textPass?.edited).toBe(sentences.length);
    // Whisper's own words are kept beside the edits, with the same times.
    const raw = w.raw_sentences as { start: number; end: number; text: string }[];
    expect(raw.map((x) => [x.start, x.end])).toEqual(sentences.map((x) => [x.start, x.end]));
    expect(raw.every((x) => !x.text.endsWith("!"))).toBe(true);
    const g = rows.find((r) => r.provider === "gemini") as Record<string, unknown>;
    expect(String(g.text)).not.toContain("!");
    // Readers see the record; the live chunk text is still there.
    const [r] = await record(cid);
    expect(r?.provider).toBe("whisper");
    expect(String(r?.text)).toContain("Zin 1.0");
    // Summaries, token counts and the transcript route read the record as one piece.
    const [piece, ...rest] = await v1Store(h.deps.db).transcriptChunks(cid);
    expect(rest).toHaveLength(0);
    expect(piece?.transcript).toBe(String(r?.text));
    const live =
      await h.sql`select transcript from conversation_chunk where conversation_id = ${cid}`;
    expect(live.every((c) => String(c.transcript).startsWith("transcript of "))).toBe(true);
    const conv = (await h.sql`select * from conversation where id = ${cid}`)[0] as Record<
      string,
      unknown
    >;
    expect(conv.merged_audio_path).toContain(`merged-${cid}-`);
  });

  test("an upload's improved transcript is its first reading, with no second Whisper pass", async () => {
    const cid = newId();
    const before = whisper.calls.length;
    // Two uploads of about 22 s each: each is cut at pauses into pieces of at most 9 s.
    await finished(cid, 2, false, "DASHBOARD_UPLOAD", 5);
    const rows = await until(async () => {
      const r = await finals(cid);
      return r.some((x) => x.provider === "whisper") ? r : null;
    });
    const w = rows.find((r) => r.provider === "whisper") as Record<string, unknown>;
    expect(whisper.calls.length).toBe(before);
    expect(w.is_record).toBe(true);
    const usage = w.usage as {
      firstPass?: boolean;
      profile?: string;
      seconds: number;
      pieces: number;
    };
    expect(usage.firstPass).toBe(true);
    expect(usage.profile).toBe("test-profile");
    expect(usage.seconds).toBe(0);
    // Every live piece was at most the timed piece length.
    const pieces =
      await h.sql`select segments from conversation_chunk where conversation_id = ${cid}`;
    expect(pieces.length).toBe(usage.pieces);
    expect(pieces.length).toBeGreaterThan(2);
    for (const p of pieces)
      expect((p.segments as { seconds: number }).seconds).toBeLessThanOrEqual(9.2);
    // The sentences follow each other through both uploads, offset by the pieces before them.
    const sentences = w.sentences as { start: number; end: number; text: string }[];
    expect(sentences.length).toBeGreaterThan(pieces.length);
    for (const [i, x] of sentences.entries()) {
      expect(x.end).toBeGreaterThanOrEqual(x.start);
      if (i) expect(x.start).toBeGreaterThanOrEqual((sentences[i - 1] as { end: number }).end);
    }
    const total = pieces.reduce((t, p) => t + (p.segments as { seconds: number }).seconds, 0);
    expect((sentences.at(-1) as { end: number }).end).toBeLessThanOrEqual(total + 0.01);
    expect((sentences.at(-1) as { start: number }).start).toBeGreaterThan(total / 2);
    // The clean-up ran on them as on a redo.
    expect(sentences.every((x) => x.text.endsWith("!"))).toBe(true);
    const [conv] = await h.sql`select merged_audio_path from conversation where id = ${cid}`;
    expect(String(conv?.merged_audio_path)).toContain(`merged-${cid}-`);
  });

  test("a recording's improved transcript still hears the whole recording again", async () => {
    const cid = newId();
    const before = whisper.calls.length;
    await finished(cid, 2);
    const rows = await until(async () => {
      const r = await finals(cid);
      return r.some((x) => x.provider === "whisper") ? r : null;
    });
    expect(whisper.calls.length).toBeGreaterThan(before);
    const usage = rows.find((r) => r.provider === "whisper")?.usage as {
      firstPass?: boolean;
      profile?: string;
    };
    expect(usage.firstPass).toBeUndefined();
    expect(usage.profile).toBe("test-profile");
  });

  test("a NUL byte in a provider's text is dropped, not fatal", async () => {
    const cid = newId();
    const real = gemini.transcribe;
    gemini.transcribe = async (input) => {
      const out = await real(input);
      return { ...out, sentences: out.sentences.map((s) => ({ ...s, text: `${s.text}\u0000x` })) };
    };
    await finished(cid, 2);
    const rows = await until(async () => {
      const r = await finals(cid);
      return r.length === 2 ? r : null;
    });
    gemini.transcribe = real;
    expect(rows.every((r) => !String(r.text).includes("\u0000"))).toBe(true);
    expect(String(rows.find((r) => r.provider === "gemini")?.text)).toContain("x");
  });

  test("the summary is made again from the final text", async () => {
    const cid = newId();
    await finished(cid, 2);
    await until(async () => (await record(cid)).length === 1);
    await until(async () => {
      const [c] = await h.sql`select summary from conversation where id = ${cid}`;
      return c?.summary ? c : null;
    });
    const statuses =
      await h.sql`select event from processing_status where conversation_id = ${cid}`;
    expect(
      statuses.filter((s) => s.event === "task_summarize_conversation.completed").length,
    ).toBeGreaterThanOrEqual(1);
    expect(statuses.map((s) => s.event)).toContain("task_final_transcript.completed");
  });

  test("a conversation with one chunk gets the final pass too, for its timings", async () => {
    const cid = newId();
    await finished(cid, 1);
    const rows = await until(async () => {
      const r = await finals(cid);
      return r.length === 2 ? r : null;
    });
    const w = rows.find((r) => r.provider === "whisper") as Record<string, unknown>;
    expect((w.sentences as unknown[]).length).toBeGreaterThan(0);
    expect(await record(cid)).toHaveLength(1);
  });

  test("an anonymised conversation gets redacted text and no timings", async () => {
    const cid = newId();
    await finished(cid, 2, true);
    const rows = await until(async () => {
      const r = await finals(cid);
      return r.length === 2 ? r : null;
    });
    for (const r of rows) {
      expect(r.sentences).toBeNull();
      expect(String(r.text)).toContain("<redacted>");
      expect(String(r.text)).not.toContain("Zin");
    }
    expect(redacted.length).toBeGreaterThan(0);
  });

  test("a chunk list that changed after the hand-over is not stored", async () => {
    const cid = newId();
    await finished(cid, 2);
    await until(async () => (await finals(cid)).length === 2);
    // New audio arrives: the stored record no longer matches the chunks, so readers fall back.
    await h.sql`insert into conversation_chunk (id, conversation_id, timestamp, transcript)
      values (${newId()}, ${cid}, now(), 'late words')`;
    expect(await record(cid)).toHaveLength(0);
  });

  test("a provider that fails leaves the live text and the conversation finished", async () => {
    const cid = newId();
    whisper.transcribe = async () => {
      throw new Error("provider down");
    };
    gemini.transcribe = async () => {
      throw new Error("provider down");
    };
    await finished(cid, 2);
    await until(async () => {
      const [c] =
        await h.sql`select summary, is_all_chunks_transcribed from conversation where id = ${cid}`;
      return c?.summary && c.is_all_chunks_transcribed ? c : null;
    });
    await Bun.sleep(5000);
    expect(await finals(cid)).toHaveLength(0);
    // The dashboard stops saying a final transcript is on its way.
    const gaveUp =
      await h.sql`select 1 from processing_status where conversation_id = ${cid} and event = 'task_final_transcript.gave_up'`;
    expect(gaveUp).toHaveLength(1);
  });
});
