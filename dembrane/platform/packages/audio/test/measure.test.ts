import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AudioError,
  type AudioFormat,
  LocalMedia,
  type Media,
  type MediaSource,
  measureSeconds,
} from "../src";

setDefaultTimeout(120_000);

const has = Bun.which("ffmpeg") && Bun.which("ffprobe");

async function ffmpeg(args: string[], stdoutTo?: string) {
  const p = Bun.spawn(["ffmpeg", "-loglevel", "error", "-y", ...args], {
    stdout: stdoutTo ? Bun.file(stdoutTo) : "ignore",
    stderr: "pipe",
  });
  const code = await p.exited;
  if (code !== 0)
    throw new Error(`ffmpeg ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}

const sine = (s: number) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${s}`];
const video = (s: number) => ["-f", "lavfi", "-i", `testsrc=duration=${s}:size=160x120:rate=10`];

(has ? describe : describe.skip)("measureSeconds", () => {
  const dir = mkdtempSync(join(tmpdir(), "measure-"));
  const media = new LocalMedia();
  let server: ReturnType<typeof Bun.serve>;
  const at = (name: string) => join(dir, name);
  const src = (name: string, format: AudioFormat): MediaSource => ({
    url: `http://127.0.0.1:${server.port}/${name}`,
    format,
  });
  const measure = (name: string, format: AudioFormat, confirmAbove = 3600) =>
    measureSeconds(media, src(name, format), Bun.file(at(name)).size, { confirmAbove });

  // Every upload format people send, each 20 s long.
  const formats: [string, AudioFormat, string[]][] = [
    ["cbr.mp3", "mp3", [...sine(20), "-c:a", "libmp3lame", "-b:a", "64k"]],
    ["vbr.mp3", "mp3", [...sine(20), "-c:a", "libmp3lame", "-q:a", "4"]],
    ["aac.m4a", "m4a", [...sine(20), "-c:a", "aac", "-b:a", "96k"]],
    ["pcm.wav", "wav", [...sine(20), "-c:a", "pcm_s16le"]],
    ["opus.webm", "webm", [...sine(20), "-c:a", "libopus"]],
    ["opus.ogg", "ogg", [...sine(20), "-c:a", "libopus"]],
    ["voice.opus", "opus", [...sine(20), "-c:a", "libopus", "-f", "ogg"]],
    ["vorbis.ogg", "ogg", [...sine(20), "-c:a", "libvorbis"]],
    ["lossless.flac", "flac", [...sine(20), "-c:a", "flac"]],
    [
      "video.mp4",
      "mp4",
      [...video(20), ...sine(20), "-c:v", "libx264", "-c:a", "aac", "-shortest"],
    ],
    [
      "quicktime.mp4",
      "mp4",
      [...video(20), ...sine(20), "-c:v", "libx264", "-c:a", "aac", "-shortest", "-f", "mov"],
    ],
    ["memo.m4a", "m4a", [...sine(20), "-ac", "1", "-ar", "48000", "-c:a", "aac", "-b:a", "64k"]],
    ["alac.m4a", "m4a", [...sine(20), "-c:a", "alac"]],
  ];

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const name = new URL(req.url).pathname.slice(1);
        if (req.method === "PUT") {
          await Bun.write(at(name), await req.arrayBuffer());
          return new Response(null, { status: 200 });
        }
        const f = Bun.file(at(name));
        return (await f.exists()) ? new Response(f) : new Response("missing", { status: 404 });
      },
    });
    await Promise.all(formats.map(([name, , args]) => ffmpeg([...args, at(name)])));
    // As MediaRecorder writes it: streamed, so the header carries no Duration.
    await ffmpeg([...sine(20), "-c:a", "libopus", "-f", "webm", "pipe:1"], at("streamed.webm"));
    // A WAV whose RIFF and data sizes claim hours.
    await ffmpeg([...sine(20), "-c:a", "pcm_s16le", at("long-header.wav")]);
    const wav = readFileSync(at("long-header.wav"));
    wav.writeUInt32LE(0x7ffffff0, 4);
    wav.writeUInt32LE(0x7ffffff0, wav.indexOf("data") + 4);
    writeFileSync(at("long-header.wav"), wav);
    // A WebM whose Duration element claims ten hours.
    const webm = readFileSync(at("opus.webm"));
    const d = webm.indexOf(Buffer.from([0x44, 0x89, 0x88]));
    webm.writeDoubleBE(36_000_000, d + 3);
    writeFileSync(at("ten-hours.webm"), webm);
    // A 10 s MP3 whose Xing header covers the whole file, then 30 s more frames.
    await ffmpeg([...sine(10), "-c:a", "libmp3lame", "-b:a", "64k", at("head.mp3")]);
    await ffmpeg([
      ...sine(30),
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-write_xing",
      "0",
      "-id3v2_version",
      "0",
      at("tail.mp3"),
    ]);
    const joined = Buffer.concat([readFileSync(at("head.mp3")), readFileSync(at("tail.mp3"))]);
    let x = joined.indexOf("Xing");
    if (x < 0) x = joined.indexOf("Info");
    joined.writeUInt32BE(joined.length, x + 8 + (joined.readUInt32BE(x + 4) & 1 ? 4 : 0));
    writeFileSync(at("concat.mp3"), joined);
    await ffmpeg([...sine(70), "-c:a", "libmp3lame", "-b:a", "64k", at("seventy.mp3")]);
    // A 60 s WebM whose Duration element claims 10 s.
    await ffmpeg([...sine(60), "-c:a", "libopus", at("sixty.webm")]);
    const short = readFileSync(at("sixty.webm"));
    short.writeDoubleBE(10_000, short.indexOf(Buffer.from([0x44, 0x89, 0x88])) + 3);
    writeFileSync(at("short-header.webm"), short);
    // A 60 s VBR MP3 whose Xing frame count is a quarter of the real one.
    await ffmpeg([...sine(60), "-c:a", "libmp3lame", "-q:a", "4", at("vbr-sixty.mp3")]);
    const vbr = readFileSync(at("vbr-sixty.mp3"));
    const v = vbr.indexOf("Xing");
    vbr.writeUInt32BE(Math.floor(vbr.readUInt32BE(v + 8) / 4), v + 8);
    writeFileSync(at("short-xing.mp3"), vbr);
    writeFileSync(at("random.mp3"), crypto.getRandomValues(new Uint8Array(50_000)));
    await ffmpeg([...video(5), "-c:v", "libx264", at("silent-video.mp4")]);
  });

  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("measures every upload format by decoding it", async () => {
    for (const [name, format] of formats) {
      const m = await measure(name, format);
      expect({ name, how: "how" in m ? m.how : m }).toEqual({ name, how: "decoded" });
      expect("seconds" in m && Math.abs(m.seconds - 20) < 0.5).toBe(true);
    }
  });

  test("missing declared length is decoded", async () => {
    const m = await measure("streamed.webm", "webm");
    expect("how" in m && m.how).toBe("decoded");
    expect("seconds" in m ? m.seconds : -1).toBeCloseTo(20, 0);
  });

  test("wrong declared length is decoded", async () => {
    // ffmpeg caps a WAV's declared data size at the file size, so this one reads true either way.
    const wav = await measure("long-header.wav", "wav", 3600);
    expect("seconds" in wav ? wav.seconds : -1).toBeCloseTo(20, 0);
    const webm = await measure("ten-hours.webm", "webm", 3600);
    expect(webm).toMatchObject({ how: "decoded" });
    expect("seconds" in webm ? webm.seconds : -1).toBeCloseTo(20, 0);
    const declared = await media.probe(src("concat.mp3", "mp3"));
    expect(Number(declared.format?.duration)).toBeCloseTo(10, 0);
    const mp3 = await measure("concat.mp3", "mp3");
    expect(mp3).toMatchObject({ how: "decoded" });
    expect("seconds" in mp3 ? mp3.seconds : -1).toBeCloseTo(40, 0);
  });

  test("a header declaring too short a length is not trusted", async () => {
    const webmProbe = await media.probe(src("short-header.webm", "webm"));
    expect(Number(webmProbe.format?.duration)).toBeCloseTo(10, 0);
    const webm = await measure("short-header.webm", "webm");
    expect(webm).toMatchObject({ how: "decoded" });
    expect("seconds" in webm ? webm.seconds : -1).toBeCloseTo(60, 0);
    const mp3Probe = await media.probe(src("short-xing.mp3", "mp3"));
    expect(Number(mp3Probe.format?.duration)).toBeLessThan(20);
    const mp3 = await measure("short-xing.mp3", "mp3");
    expect(mp3).toMatchObject({ how: "decoded" });
    expect("seconds" in mp3 ? mp3.seconds : -1).toBeCloseTo(60, 0);
  });

  test("a long true length is not shortened", async () => {
    const m = await measure("seventy.mp3", "mp3", 60);
    expect(m).toMatchObject({ how: "decoded" });
    expect("seconds" in m ? m.seconds : -1).toBeCloseTo(70, 0);
  });

  test("only broken files are unreadable", async () => {
    expect(await measure("random.mp3", "mp3")).toMatchObject({ unreadable: true });
    expect(await measure("silent-video.mp4", "mp4")).toMatchObject({ unreadable: true });
  });

  test("a transient failure is rethrown", async () => {
    const flaky = {
      probe: async () => ({ format: { duration: "1" }, streams: [{ codec_type: "audio" }] }),
      decodedSeconds: async () => {
        throw new AudioError("transient", "media away");
      },
    } as unknown as Media;
    const err = await measureSeconds(flaky, src("cbr.mp3", "mp3"), 1000, {
      confirmAbove: 3600,
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AudioError);
    expect((err as AudioError).kind).toBe("transient");
  });

  test("a file the probe reads but the decode cannot keeps its declared length", async () => {
    const stub = {
      probe: async () => ({
        format: { duration: "7200" },
        streams: [{ codec_type: "audio" }],
      }),
      decodedSeconds: async () => {
        throw new AudioError("value", "decode failed");
      },
    } as unknown as Media;
    expect(
      await measureSeconds(stub, src("cbr.mp3", "mp3"), 10_000_000, { confirmAbove: 3600 }),
    ).toEqual({ seconds: 7200, how: "declared" });
  });

  test("convert reports the output length", async () => {
    const out = await media.convert({
      source: src("opus.webm", "webm"),
      target: { url: `http://127.0.0.1:${server.port}/converted.mp3`, contentType: "audio/mpeg" },
      outputFormat: "mp3",
    });
    expect(out.bytes).toBeGreaterThan(1000);
    expect(Math.abs((out.seconds ?? -1) - 20)).toBeLessThan(0.5);
  });
});
