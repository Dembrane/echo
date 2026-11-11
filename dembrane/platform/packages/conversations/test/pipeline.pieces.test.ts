import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { newId } from "@dembrane/core";
import { FakeTranscriber } from "@dembrane/transcription";
import { createChunk } from "../src/chunks";
import { admin, freshDatabase, type Harness, seed, startWorker, until } from "./pipeline-harness";

const run = admin && Bun.which("ffmpeg") && Bun.which("ffprobe") ? describe : describe.skip;
const CAP = 15;

async function seconds(path: string) {
  const p = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { stdout: "pipe", stderr: "ignore" },
  );
  await p.exited;
  return Number((await new Response(p.stdout).text()).trim());
}

run("an upload is cut by duration, at pauses, before it reaches the speech model", () => {
  setDefaultTimeout(120_000);
  let h: Harness;
  const transcriber = new FakeTranscriber();

  beforeAll(async () => {
    h = await startWorker(await freshDatabase("conv_pipeline_pieces"), {
      transcriber,
      requestLimits: { maxSeconds: CAP },
    });
  });
  afterAll(async () => {
    await h?.stop();
  });

  test("no request carries more than the cap, and the cuts fall in the pauses", async () => {
    const cid = newId();
    await seed(h.sql, cid);
    // 50 s of tone with two seconds of silence ending every tenth second: a file far under the
    // size limit but over the duration cap, which only a measured duration can catch.
    const file = join(h.bucket.root, "long.mp3");
    const p = Bun.spawn(
      [
        "ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=50",
        "-af",
        "volume=0:enable='gte(mod(t,10),8)'",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        "-y",
        file,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await p.exited).toBe(0);
    const chunkId = newId();
    const key = `conversation/${cid}/chunks/${chunkId}-long.mp3`;
    await h.deps.audio.put(key, Bun.file(file));
    await createChunk(
      { ...h.deps, jobs: h.queue },
      {
        conversationId: cid,
        timestamp: new Date("2026-01-01T10:00:00Z"),
        source: "DASHBOARD_UPLOAD",
        fileUrl: h.deps.audioUrls.fileUrl(key),
      },
      { chunkId },
    );
    const rows = await until(async () => {
      const r = await h.sql<{ path: string; timestamp: string; transcript: string | null }[]>`
        select path, timestamp, transcript from conversation_chunk
        where conversation_id = ${cid} order by timestamp`;
      return r.length > 1 && r.every((c) => c.transcript) ? r : null;
    });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // Every piece the model was asked to read is within the cap.
    expect(transcriber.calls.length).toBe(rows.length);
    const tmp = join(h.bucket.root, "calls");
    for (const [i, c] of transcriber.calls.entries()) {
      await Bun.write(`${tmp}-${i}.mp3`, c.audio);
      expect(await seconds(`${tmp}-${i}.mp3`)).toBeLessThanOrEqual(CAP + 0.1);
    }
    // Pieces start where the planner found a pause: 8 to 10 s into each ten.
    const t0 = new Date(rows[0]?.timestamp as string).getTime();
    for (const r of rows.slice(1)) {
      const at = (new Date(r.timestamp).getTime() - t0) / 1000;
      expect(at % 10).toBeGreaterThanOrEqual(8);
      expect(at % 10).toBeLessThanOrEqual(10.01);
    }
  });
});
