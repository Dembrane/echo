import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { AudioError, HttpMedia, LocalMedia, type Media } from "@echo/audio";
import { createLogger } from "@echo/observability";
import { FilesystemStorage, localStorageHandler } from "@echo/storage";
import { mediaApp } from "../src/app";

const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

test("bad input is 422 with its kind; a transient failure is 503", async () => {
  const failing = (kind: "invalid_audio" | "transient"): Media =>
    ({
      probe: async () => {
        throw new AudioError(kind, "nope");
      },
    }) as unknown as Media;
  const body = JSON.stringify({ source: { url: "http://x.test/a.webm", format: "webm" } });
  const bad = await mediaApp(failing("invalid_audio"), logger).request("/probe", {
    method: "POST",
    body,
  });
  expect(bad.status).toBe(422);
  expect(await bad.json()).toEqual({ kind: "invalid_audio", message: "nope" });
  const later = await mediaApp(failing("transient"), logger).request("/probe", {
    method: "POST",
    body,
  });
  expect(later.status).toBe(503);
  const invalid = await mediaApp(failing("transient"), logger).request("/probe", {
    method: "POST",
    body: "{}",
  });
  expect(invalid.status).toBe(400);
});

// The worker's HTTP client against the real service and real ffmpeg, over presigned URLs.
(Bun.which("ffmpeg") ? describe : describe.skip)("over HTTP", () => {
  const root = mkdtempSync(join(tmpdir(), "echo-media-"));
  let storage: FilesystemStorage;
  let bucket: ReturnType<typeof Bun.serve>;
  let service: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    bucket = Bun.serve({ port: 0, fetch: (req) => localStorageHandler(storage)(req) });
    storage = new FilesystemStorage(root, `http://127.0.0.1:${bucket.port}`);
    service = Bun.serve({ port: 0, fetch: mediaApp(new LocalMedia(), logger).fetch });
    const p = Bun.spawn(
      [
        "ffmpeg",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=2",
        "-c:a",
        "libopus",
        "-y",
        join(root, "in.webm"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await p.exited;
  });
  afterAll(() => {
    bucket.stop(true);
    service.stop(true);
  });

  test("convert, probe and a rejected file travel over the hop with their kinds", async () => {
    const media = new HttpMedia(`http://127.0.0.1:${service.port}`, { timeoutMs: 60_000 });
    const source = {
      url: storage.presignDownload("in.webm", { expiresInSeconds: 60 }),
      format: "webm" as const,
    };
    const out = await media.convert({
      source,
      target: {
        url: storage.presignUpload("out.mp3", { contentType: "audio/mpeg", expiresInSeconds: 60 }),
        contentType: "audio/mpeg",
      },
      outputFormat: "mp3",
    });
    expect(out.bytes).toBeGreaterThan(1000);
    const probe = await media.probe({
      url: storage.presignDownload("out.mp3", { expiresInSeconds: 60 }),
      format: "mp3",
    });
    expect(Number(probe.format?.duration)).toBeGreaterThan(1.5);
    await storage.put("junk.webm", "this is not audio at all, just text".repeat(50));
    const err = await media
      .probe({
        url: storage.presignDownload("junk.webm", { expiresInSeconds: 60 }),
        format: "webm",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AudioError);
    expect((err as AudioError).kind).toBe("invalid_audio");
    expect((err as AudioError).unplayable).toBe(true);
  });
});
