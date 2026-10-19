import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mp3Seconds } from "../src/audio-length";

const run = Bun.which("ffmpeg") ? test : test.skip;

async function mp3(args: string[]) {
  const path = join(tmpdir(), `len-${crypto.randomUUID()}.mp3`);
  const p = Bun.spawn(
    [
      "ffmpeg",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=12.5",
      ...args,
      path,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  await p.exited;
  const out = new Uint8Array(await Bun.file(path).arrayBuffer());
  rmSync(path);
  return out;
}

run("the length of an mp3 comes from its header, CBR or VBR, mono or stereo", async () => {
  for (const args of [
    ["-b:a", "128k", "-ac", "2"],
    ["-q:a", "5", "-ac", "1"],
    ["-b:a", "16k", "-ar", "16000", "-ac", "1"],
    ["-b:a", "64k", "-ar", "22050", "-ac", "1"],
  ]) {
    const seconds = mp3Seconds(await mp3(args));
    expect(seconds).not.toBeNull();
    expect(seconds as number).toBeGreaterThan(12.3);
    expect(seconds as number).toBeLessThan(12.9);
  }
});

test("anything that is not an mp3 has no length to read", () => {
  expect(mp3Seconds(new Uint8Array(500))).toBeNull();
  expect(mp3Seconds(new TextEncoder().encode("RIFF....WAVEfmt "))).toBeNull();
});
