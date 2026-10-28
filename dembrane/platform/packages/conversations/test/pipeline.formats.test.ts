import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { newId } from "@dembrane/core";
import { FakeTranscriber, type FinalInput, type FinalTranscriber } from "@dembrane/transcription";
import { createChunk } from "../src/chunks";
import { finishConversation } from "../src/pipeline/defs";
import { admin, freshDatabase, type Harness, seed, startWorker, until } from "./pipeline-harness";

// Every format a host can upload or the portal records, through the real pipeline with real ffmpeg
// and a fake transcriber: no request carries more than the limits, the live text is in order, the
// merge handles mixed codecs and sample rates, and bad files fail alone.
const run = admin && Bun.which("ffmpeg") && Bun.which("ffprobe") ? describe : describe.skip;

const LIMITS = { maxSeconds: 12, maxBytes: 400_000 };

/** Bursts of tone with a 1.5 s pause every 4.5 s: speech-like for the pause finder. */
const SIGNAL = (seconds: number, freq = 330) =>
  `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000,volume=0:enable='gte(mod(t,4.5),3)'`;

interface Spec {
  readonly name: string;
  readonly ext: string;
  /** Output arguments after the input. */
  readonly out: readonly string[];
  /** A video track of the same length goes in front of the audio. */
  readonly video?: boolean;
}

const FORMATS: readonly Spec[] = [
  {
    name: "mp3 CBR 128k stereo",
    ext: "mp3",
    out: ["-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k"],
  },
  { name: "mp3 VBR mono", ext: "mp3", out: ["-ac", "1", "-c:a", "libmp3lame", "-q:a", "5"] },
  {
    name: "mp3 8 kbps 8 kHz",
    ext: "mp3",
    out: ["-ar", "8000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "8k"],
  },
  {
    name: "wav PCM16 48 kHz stereo",
    ext: "wav",
    out: ["-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le"],
  },
  {
    name: "wav PCM24 8 kHz mono",
    ext: "wav",
    out: ["-ar", "8000", "-ac", "1", "-c:a", "pcm_s24le"],
  },
  {
    name: "wav PCM16 16 kHz mono",
    ext: "wav",
    out: ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"],
  },
  { name: "m4a AAC 64k", ext: "m4a", out: ["-c:a", "aac", "-b:a", "64k"] },
  { name: "aac ADTS", ext: "aac", out: ["-c:a", "aac", "-b:a", "96k", "-f", "adts"] },
  {
    name: "mp4 with video, AAC",
    ext: "mp4",
    video: true,
    out: [
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
    ],
  },
  {
    name: "mp4 audio only (Safari portal chunk)",
    ext: "mp4",
    out: ["-c:a", "aac", "-b:a", "64k", "-f", "mp4"],
  },
  {
    name: "webm Opus 24k (Chrome portal chunk)",
    ext: "webm",
    out: ["-c:a", "libopus", "-b:a", "24k"],
  },
  { name: "ogg Opus", ext: "ogg", out: ["-c:a", "libopus", "-b:a", "32k"] },
  { name: "ogg Vorbis", ext: "ogg", out: ["-c:a", "libvorbis", "-q:a", "3"] },
  { name: "opus file", ext: "opus", out: ["-c:a", "libopus", "-b:a", "16k"] },
  { name: "flac", ext: "flac", out: ["-c:a", "flac"] },
  {
    name: "m4a AAC in a QuickTime container (Apple Voice Memo, renamed from .qta)",
    ext: "m4a",
    out: ["-c:a", "aac", "-b:a", "64k", "-f", "mov"],
  },
];

async function ffmpeg(args: string[]) {
  const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}

async function make(path: string, spec: Spec, seconds: number, freq = 330) {
  const input = ["-f", "lavfi", "-i", SIGNAL(seconds, freq)];
  const video = spec.video
    ? ["-f", "lavfi", "-i", `testsrc2=size=160x90:rate=10:duration=${seconds}`]
    : [];
  await ffmpeg([...video, ...input, ...spec.out, path]);
}

async function seconds(path: string) {
  const p = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { stdout: "pipe", stderr: "ignore" },
  );
  await p.exited;
  return Number((await new Response(p.stdout).text()).trim());
}

/** A final-pass provider that writes a sentence every 3 s of the piece it is given. */
function fakeFinal(): FinalTranscriber {
  return {
    provider: "whisper",
    model: "fake",
    limits: { maxBytes: 20_000_000, maxSeconds: 9 },
    async transcribe(input: FinalInput) {
      const n = Math.max(1, Math.floor(input.seconds / 3));
      return {
        sentences: Array.from({ length: n }, (_, i) => ({
          start: i * 3,
          end: i * 3 + 2.5,
          text: `Zin ${i}`,
        })),
        usage: { seconds: input.seconds, inputTokens: null, outputTokens: null },
        model: "fake",
      };
    },
  };
}

run("every format, several files, bad files", () => {
  setDefaultTimeout(240_000);
  let h: Harness;
  const transcriber = new FakeTranscriber();

  beforeAll(async () => {
    h = await startWorker(await freshDatabase("conv_pipeline_formats"), {
      transcriber,
      requestLimits: LIMITS,
      final: {
        providers: ["whisper"],
        transcribers: { whisper: fakeFinal() },
        redact: async (t) => t,
      },
    });
  });
  afterAll(async () => {
    await h?.stop();
  });

  async function upload(
    cid: string,
    file: Blob,
    name: string,
    n: number,
    source = "DASHBOARD_UPLOAD",
  ) {
    const chunkId = newId();
    const key = `conversation/${cid}/chunks/${chunkId}-${name}`;
    await h.deps.audio.put(key, file);
    await createChunk(
      { ...h.deps, jobs: h.queue },
      {
        conversationId: cid,
        timestamp: new Date(Date.parse("2026-01-01T10:00:00Z") + n * 60_000),
        source,
        fileUrl: h.deps.audioUrls.fileUrl(key),
      },
      { chunkId },
    );
    return chunkId;
  }
  const chunksOf = (cid: string) =>
    h.sql<
      {
        id: string;
        path: string | null;
        timestamp: string;
        transcript: string | null;
        error: string | null;
      }[]
    >`
      select id, path, timestamp, transcript, error from conversation_chunk where conversation_id = ${cid} order by timestamp`;
  const settled = (cid: string, n: number) =>
    until(async () => {
      const r = await chunksOf(cid);
      return r.length >= n && r.every((c) => c.transcript || c.error) ? r : null;
    });

  for (const spec of FORMATS) {
    test(`${spec.name}: no request over the limits, pieces in order`, async () => {
      const cid = newId();
      await seed(h.sql, cid);
      const file = join(h.bucket.root, `f-${newId()}.${spec.ext}`);
      await make(file, spec, 30);
      const before = transcriber.calls.length;
      await upload(cid, Bun.file(file), `rec.${spec.ext}`, 0);
      const rows = await settled(cid, 1);
      expect(rows.map((r) => r.error)).toEqual(rows.map(() => null));
      const calls = transcriber.calls.slice(before);
      expect(calls.length).toBe(rows.length);
      // The 30 s file is over the 12 s limit: it was cut, and every piece the model sees is within the limits.
      expect(rows.length).toBeGreaterThanOrEqual(3);
      for (const [i, c] of calls.entries()) {
        const f = join(h.bucket.root, `call-${newId()}-${i}.mp3`);
        await Bun.write(f, c.audio);
        expect(await seconds(f)).toBeLessThanOrEqual(LIMITS.maxSeconds + 0.1);
        expect(c.audio.byteLength).toBeLessThanOrEqual(LIMITS.maxBytes);
      }
      const times = rows.map((r) => Date.parse(r.timestamp));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });
  }

  test("a portal chunk of 30 seconds, in either portal format, is sent as it is", async () => {
    for (const spec of [FORMATS[10] as Spec, FORMATS[9] as Spec]) {
      const cid = newId();
      await seed(h.sql, cid);
      const file = join(h.bucket.root, `p-${newId()}.${spec.ext}`);
      await make(file, spec, 30);
      const before = transcriber.calls.length;
      await upload(cid, Bun.file(file), `rec.${spec.ext}`, 0, "PORTAL_AUDIO");
      const rows = await settled(cid, 1);
      expect(rows.length).toBe(1);
      expect(transcriber.calls.length - before).toBe(1);
    }
  });

  test("two to five files of mixed formats: text in order, one merge, sentence times line up across the files", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const picks = [FORMATS[0], FORMATS[4], FORMATS[10], FORMATS[6], FORMATS[13]] as Spec[];
    const lengths = [14, 11, 17, 9, 12];
    let total = 0;
    for (const [n, spec] of picks.entries()) {
      const file = join(h.bucket.root, `m${n}-${newId()}.${spec.ext}`);
      await make(file, spec, lengths[n] as number, 300 + n * 40);
      total += await seconds(file);
      await upload(cid, Bun.file(file), `rec${n}.${spec.ext}`, n);
    }
    const rows = await settled(cid, 5);
    expect(rows.map((r) => r.error)).toEqual(rows.map(() => null));
    expect(rows.map((r) => Date.parse(r.timestamp))).toEqual(
      [...rows.map((r) => Date.parse(r.timestamp))].sort((a, b) => a - b),
    );
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    const final = await until(async () => {
      const r = await h.sql<
        { audio_seconds: number; sentences: { start: number; end: number }[] }[]
      >`
        select audio_seconds, sentences from conversation_record_transcript where conversation_id = ${cid}`;
      return r[0] ?? null;
    });
    // The merged recording is the sum of the files, within a frame or two per file.
    expect(Math.abs(final.audio_seconds - total)).toBeLessThan(1.5);
    const starts = final.sentences.map((s) => s.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(Math.max(...starts)).toBeLessThan(final.audio_seconds);
    expect(Math.max(...final.sentences.map((s) => s.end))).toBeLessThanOrEqual(
      final.audio_seconds + 0.5,
    );
  });

  test("bad files fail alone and never block the rest of the conversation", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    const good = join(h.bucket.root, `g-${newId()}.mp3`);
    await make(good, FORMATS[0] as Spec, 10);
    const truncated = join(h.bucket.root, `t-${newId()}.mp3`);
    await make(truncated, FORMATS[0] as Spec, 20);
    const bytes = new Uint8Array(await Bun.file(truncated).arrayBuffer());
    const noAudio = join(h.bucket.root, `v-${newId()}.mp4`);
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=10:duration=5",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      noAudio,
    ]);
    const random = new Uint8Array(60_000).map((_, i) => (i * 2654435761) >>> 24);
    const bad: [string, Blob][] = [
      ["corrupt.mp3", new Blob([random])],
      ["empty.mp3", new Blob([])],
      ["noaudio.mp4", Bun.file(noAudio)],
      ["clip.mov", new Blob([random])],
      ["voice.amr", new Blob([random])],
    ];
    let n = 0;
    await upload(cid, Bun.file(good), "good.mp3", n++);
    for (const [name, blob] of bad) await upload(cid, blob, name, n++);
    // A truncated mp3 still holds speech: it is transcribed from what is there.
    await upload(cid, new Blob([bytes.slice(0, Math.floor(bytes.length * 0.4))]), "cut.mp3", n++);
    const rows = await settled(cid, n);
    const by = (s: string) => rows.find((r) => String(r.path).includes(s));
    expect(by("good.mp3")?.transcript).toBeTruthy();
    // A truncated mp3 keeps the duration its header claims, so it may be cut into pieces: the ones
    // that hold speech are transcribed, the empty tail fails alone.
    const cut = rows.filter((r) => /cut\.mp3|-of-/.test(String(r.path)));
    expect(cut.some((r) => r.transcript)).toBe(true);
    for (const name of ["corrupt.mp3", "empty.mp3", "noaudio.mp4", "clip.mov", "voice.amr"]) {
      const r = by(name);
      expect({ name, failed: Boolean(r?.error) }).toEqual({ name, failed: true });
    }
    // The conversation still finishes with the files that worked.
    await h.queue.enqueue(finishConversation, { conversationId: cid }, { singletonKey: cid });
    await until(async () => {
      const [c] = await h.sql`select is_all_chunks_transcribed from conversation where id = ${cid}`;
      return c?.is_all_chunks_transcribed ? c : null;
    });
  });
});
