import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { AudioError, HttpMedia, LocalMedia, type Media, mediaAuth } from "@dembrane/audio";
import { createLogger } from "@dembrane/observability";
import { FilesystemStorage, localStorageHandler } from "@dembrane/storage";
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

// A caller that gives up (the measure deadline) must stop the job, not leave ffmpeg running.
test("a caller that gives up aborts the media job", async () => {
  let aborted = false;
  const hanging = {
    decodedSeconds: (_s: unknown, o?: { signal?: AbortSignal }) =>
      new Promise((_, reject) =>
        o?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new AudioError("transient", "aborted"));
        }),
      ),
  } as unknown as Media;
  const service = Bun.serve({ port: 0, fetch: mediaApp(hanging, logger).fetch });
  try {
    const media = new HttpMedia(`http://127.0.0.1:${service.port}`, { timeoutMs: 60_000 });
    const started = performance.now();
    const err = await media
      .decodedSeconds(
        { url: "http://x.test/a.mp4", format: "mp4" },
        { signal: AbortSignal.timeout(200) },
      )
      .catch((e) => e);
    expect((err as AudioError).kind).toBe("transient");
    expect(performance.now() - started).toBeLessThan(2_000);
    for (let i = 0; i < 40 && !aborted; i++) await Bun.sleep(50);
    expect(aborted).toBe(true);
  } finally {
    service.stop(true);
  }
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

  test("decoded-seconds returns the decoded length; random bytes are 422 value", async () => {
    const app = mediaApp(new LocalMedia(), logger);
    const call = (key: string) =>
      app.request("/decoded-seconds", {
        method: "POST",
        body: JSON.stringify({
          source: {
            url: storage.presignDownload(key, { expiresInSeconds: 60 }),
            format: "webm",
          },
        }),
      });
    const good = await call("in.webm");
    expect(good.status).toBe(200);
    const { seconds } = (await good.json()) as { seconds: number };
    expect(seconds).toBeCloseTo(2, 0);
    await storage.put("random.webm", crypto.getRandomValues(new Uint8Array(20_000)));
    const bad = await call("random.webm");
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { kind: string }).kind).toBe("value");
    const media = new HttpMedia(`http://127.0.0.1:${service.port}`, { timeoutMs: 60_000 });
    const over = await media.decodedSeconds({
      url: storage.presignDownload("in.webm", { expiresInSeconds: 60 }),
      format: "webm",
    });
    expect(over.seconds).toBeCloseTo(2, 0);
  });
});

// MEDIA_AUTH: Cloud Run callers present a metadata-server token; in-cluster callers send none.
describe("media auth", () => {
  let seen: (string | null)[] = [];
  let service: ReturnType<typeof Bun.serve>;
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    service = Bun.serve({
      port: 0,
      fetch: (req) => {
        seen.push(req.headers.get("authorization"));
        return Response.json({ format: { duration: "1" } });
      },
    });
    // Stands in for the metadata server, which only exists on Cloud Run.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://metadata.google.internal/")) {
        const audience = new URL(url).searchParams.get("audience");
        return new Response(`token-for-${audience}`);
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    service.stop(true);
  });

  const probe = (auth: "google_id_token" | "none") => {
    const url = `http://127.0.0.1:${service.port}`;
    return new HttpMedia(url, { timeoutMs: 5_000, ...mediaAuth(auth, url) }).probe({
      url: "http://x.test/a.webm",
      format: "webm",
    });
  };

  test("google_id_token sends the metadata server's token for the media URL", async () => {
    seen = [];
    await probe("google_id_token");
    expect(seen).toEqual([`Bearer token-for-http://127.0.0.1:${service.port}`]);
  });

  test("none sends no Authorization header and never asks the metadata server", async () => {
    seen = [];
    let metadataCalls = 0;
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("metadata.google.internal")) metadataCalls++;
      return stub(input, init);
    }) as typeof fetch;
    try {
      await probe("none");
    } finally {
      globalThis.fetch = stub;
    }
    expect(seen).toEqual([null]);
    expect(metadataCalls).toBe(0);
  });
});
