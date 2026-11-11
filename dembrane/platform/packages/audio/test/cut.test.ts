import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutFile } from "../src";

async function ffmpeg(args: string[]) {
  const p = Bun.spawn(["ffmpeg", "-loglevel", "error", "-y", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await p.exited;
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

/** Zero crossings per second of 16 kHz mono 16 bit samples: 2 x the frequency of a tone. */
const crossings = (pcm: Uint8Array, from: number, to: number) => {
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  let n = 0;
  for (let i = Math.floor(from * 16000) + 1; i < Math.floor(to * 16000); i++)
    if ((s[i - 1] as number) < 0 !== (s[i] as number) < 0) n++;
  return n / (to - from);
};

test("a cut starts where it is asked to, deep into a long file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cut-"));
  try {
    // 60 s of 440 Hz then 60 s of 880 Hz: the seek lands on one side of the change or the other.
    const whole = join(dir, "whole.mp3");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=60:sample_rate=16000",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=60:sample_rate=16000",
      "-filter_complex",
      "[0][1]concat=n=2:v=0:a=1",
      "-b:a",
      "48k",
      whole,
    ]);
    const out = join(dir, "piece.mp3");
    await cutFile(whole, out, "mp3", 58, 4);
    const pcm = await ffmpeg(["-i", out, "-ar", "16000", "-ac", "1", "-f", "s16le", "-"]);
    expect(pcm.byteLength / 32000).toBeCloseTo(4, 1);
    // 58 to 60 s is the low tone, 60 to 62 s the high one, within one mp3 frame.
    expect(crossings(pcm, 0.2, 1.8)).toBeCloseTo(880, -2);
    expect(crossings(pcm, 2.2, 3.8)).toBeCloseTo(1760, -2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
