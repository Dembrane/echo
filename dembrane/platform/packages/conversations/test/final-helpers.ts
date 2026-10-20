import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durationOf, probeFile } from "@dembrane/audio";
import { newId } from "@dembrane/core";
import type { FinalInput, FinalTranscriber, TranscribeInput } from "@dembrane/transcription";

// Shared by the final transcript tests: audio with pauses, a fake final provider, and the
// live reading Whisper's live path gives.

/** Bursts of tone with pauses: `bursts` of 3 s separated by 1.5 s of silence. */
export async function bursts(path: string, bursts: number) {
  const parts = Array.from({ length: bursts }, (_, i) => `[t${i}]`);
  const filter = [
    ...parts.map((_, i) => `sine=frequency=${300 + i * 50}:duration=3[t${i}]`),
    ...parts.slice(1).map((_, i) => `anullsrc=r=44100:cl=mono:d=1.5[s${i}]`),
    `${parts.map((p, i) => (i < parts.length - 1 ? `${p}[s${i}]` : p)).join("")}concat=n=${bursts * 2 - 1}:v=0:a=1[out]`,
  ].join(";");
  const p = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-c:a",
      "libmp3lame",
      "-y",
      path,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return Bun.file(path);
}

/** One sentence per second of the piece it is given; the text names the piece's length. */
export function fakeProvider(maxSeconds: number): FinalTranscriber & { calls: FinalInput[] } {
  const calls: FinalInput[] = [];
  return {
    calls,
    provider: "whisper",
    model: "whisper-fake",
    limits: { maxBytes: 20_000_000, maxSeconds },
    async transcribe(input) {
      calls.push(input);
      const n = Math.max(1, Math.floor(input.seconds / 3));
      return {
        sentences: Array.from({ length: n }, (_, i) => ({
          start: i * 3,
          end: i * 3 + 2.5,
          text: `Zin ${calls.length}.${i}`,
        })),
        usage: { seconds: input.seconds, inputTokens: null, outputTokens: null },
        model: "whisper-fake",
      };
    },
  };
}

/**
 * The live reading as Whisper's live path gives it: a sentence every three seconds of the piece,
 * timed from the piece's start, with the piece's real length.
 */
export async function timedLive(input: TranscribeInput) {
  const path = join(tmpdir(), `live-${newId()}.mp3`);
  writeFileSync(path, input.audio);
  const seconds = durationOf(await probeFile(path, "mp3")) ?? 0;
  const n = Math.max(1, Math.floor(seconds / 3));
  return {
    seconds,
    sentences: Array.from({ length: n }, (_, i) => ({
      start: i * 3,
      end: i * 3 + 2.5,
      text: `Live ${Math.round(seconds)}.${i}`,
    })),
  };
}
