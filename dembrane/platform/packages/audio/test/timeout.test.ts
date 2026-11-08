import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioError, convertFile, setFfmpegTimeout } from "../src";

// A stand-in ffmpeg that hangs the way a stuck demuxer does: it never exits on its own, and it
// starts a child of its own that would outlive a kill aimed at the parent alone.
let bin: string;
let dir: string;
let path: string | undefined;
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "ffmpeg-bin-"));
  writeFileSync(
    join(bin, "ffmpeg"),
    '#!/bin/sh\necho "$@" > "$FAKE_OUT/args"\nsleep 60 &\necho $! > "$FAKE_OUT/child"\nwait\n',
  );
  chmodSync(join(bin, "ffmpeg"), 0o755);
  path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
});
afterAll(() => {
  process.env.PATH = path;
  rmSync(bin, { recursive: true, force: true });
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ffmpeg-timeout-"));
  process.env.FAKE_OUT = dir;
});
afterEach(() => {
  setFfmpegTimeout(300_000);
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("an ffmpeg that hangs is killed with its children after the timeout, as a retryable error", async () => {
  setFfmpegTimeout(500);
  const started = performance.now();
  const err = await convertFile(join(dir, "in.webm"), "webm", join(dir, "out.mp3"), "mp3").catch(
    (e) => e,
  );
  expect(err).toBeInstanceOf(AudioError);
  expect((err as AudioError).kind).toBe("transient");
  expect((err as AudioError).terminal).toBe(false);
  expect((err as AudioError).message).toContain("timed out");
  expect(performance.now() - started).toBeLessThan(5_000);
  const child = Number(readFileSync(join(dir, "child"), "utf8"));
  await Bun.sleep(100);
  expect(alive(child)).toBe(false);
});

test("a caller that gives up kills the hung ffmpeg without waiting for the timeout", async () => {
  setFfmpegTimeout(60_000);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 300);
  const started = performance.now();
  const err = await convertFile(
    join(dir, "in.webm"),
    "webm",
    join(dir, "out.mp3"),
    "mp3",
    ctl.signal,
  ).catch((e) => e);
  expect(err).toBeInstanceOf(AudioError);
  expect((err as AudioError).kind).toBe("transient");
  expect(performance.now() - started).toBeLessThan(5_000);
  await Bun.sleep(100);
  expect(alive(Number(readFileSync(join(dir, "child"), "utf8")))).toBe(false);
});

test("ffmpeg is started without stdin, forced to the webm demuxer for a browser chunk", async () => {
  setFfmpegTimeout(300);
  await convertFile(join(dir, "in.webm"), "webm", join(dir, "out.mp3"), "mp3").catch(() => {});
  const args = readFileSync(join(dir, "args"), "utf8").trim().split(" ");
  expect(args[0]).toBe("-nostdin");
  expect(args).toContain("-y");
  expect(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2)).toEqual(["-f", "webm"]);
});
