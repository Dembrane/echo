import { AudioError, classifyFfprobeFailure } from "./errors";
import { type AudioFormat, isAudioFormat } from "./formats";

/**
 * The ffmpeg and ffprobe command lines of audio_utils.py, argument for argument, as
 * ffmpeg-python compiled them (input options, -i, output options sorted by name, the
 * output, then the global arguments and -y). Paths are local files; the media service
 * downloads inputs and uploads outputs around these calls.
 */

export interface ProbeResult {
  readonly format?: { readonly format_name?: string; readonly duration?: string } & Record<
    string,
    unknown
  >;
  readonly streams?: readonly Record<string, unknown>[];
}

interface Run {
  readonly code: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(cmd: readonly string[], timeoutMs?: number): Promise<Run> {
  const proc = Bun.spawn([...cmd], {
    stdout: "pipe",
    stderr: "pipe",
    ...(timeoutMs && { timeout: timeoutMs }),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, signal: proc.signalCode ?? null, stdout, stderr };
}

/** Python's str(float): whole numbers keep ".0". */
export function pyFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

const PROBE_ARGS = [
  "-hide_banner",
  "-loglevel",
  "warning",
  "-print_format",
  "json",
  "-show_format",
  "-show_streams",
];

/**
 * probe_from_bytes on a local file: auto-detect first, then with the format hint, and a
 * failure classified as bad bytes or retryable.
 */
export async function probeFile(path: string, hint: AudioFormat): Promise<ProbeResult> {
  if (!isAudioFormat(hint))
    throw new AudioError("value", `Unsupported or invalid input format '${hint}'.`);
  let r = await run(["ffprobe", ...PROBE_ARGS, path]);
  if (r.code !== 0) {
    r = await run([
      "ffprobe",
      ...PROBE_ARGS.slice(0, 5),
      "-show_format",
      "-show_streams",
      "-f",
      hint,
      path,
    ]);
    if (r.code !== 0) throw classifyFfprobeFailure(r.signal, r.stderr.trim());
  }
  if (!r.stdout) throw new AudioError("ffmpeg", "ffprobe returned empty output");
  return JSON.parse(r.stdout) as ProbeResult;
}

/** probe_from_file: the merged file's own probe, no format hint. */
export async function probePlain(path: string): Promise<ProbeResult> {
  const r = await run(["ffprobe", ...PROBE_ARGS, path]);
  if (r.code !== 0)
    throw new AudioError(
      "value",
      `ffprobe failed on ${path}: ${r.stderr.trim() || "Unknown error"}`,
    );
  if (!r.stdout) throw new AudioError("value", "ffprobe returned empty output");
  return JSON.parse(r.stdout) as ProbeResult;
}

/**
 * probe_from_url: ffprobe reads a remote file over range requests. The protocol
 * whitelist keeps a redirect or playlist from turning a URL probe into a local read.
 */
export async function probeUrl(url: string, timeoutMs = 120_000): Promise<ProbeResult> {
  if (!/^https?:\/\//.test(url))
    throw new AudioError("value", "probe_from_url only accepts http(s) URLs");
  const r = await run(
    [
      "ffprobe",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-protocol_whitelist",
      "http,https,tcp,tls,crypto",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      url,
    ],
    timeoutMs,
  );
  const stderr = r.stderr.trim().replace(/\?\S*/g, "?<redacted>");
  if (r.code !== 0)
    throw new AudioError("value", `ffprobe failed on url: ${stderr || "Unknown error"}`);
  if (!r.stdout) throw new AudioError("value", "ffprobe returned empty output");
  return JSON.parse(r.stdout) as ProbeResult;
}

export function durationOf(p: ProbeResult): number | null {
  const d = p.format?.duration;
  return d === undefined ? null : Number(d);
}

/** convert_and_save_to_s3's ffmpeg step: to ogg (vorbis) or mp3 (lame), tolerant of damaged input. */
export async function convertFile(
  input: string,
  inputFormat: AudioFormat,
  output: string,
  outputFormat: "mp3" | "ogg",
): Promise<void> {
  const tolerant = ["-hide_banner", "-loglevel", "warning", "-err_detect", "ignore_err"];
  let cmd: string[];
  if (outputFormat === "ogg") {
    cmd =
      inputFormat === "m4a" || inputFormat === "mp4"
        ? [
            "ffmpeg",
            "-f",
            inputFormat,
            "-i",
            input,
            "-acodec",
            "libvorbis",
            "-f",
            "ogg",
            "-max_error_rate",
            "0.5",
            "-q",
            "5",
            "-strict",
            "-2",
            output,
            ...tolerant,
            "-y",
          ]
        : [
            "ffmpeg",
            "-f",
            inputFormat,
            "-i",
            input,
            "-acodec",
            "libvorbis",
            "-f",
            "ogg",
            "-q",
            "5",
            output,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
          ];
  } else {
    cmd = [
      "ffmpeg",
      "-f",
      inputFormat,
      "-i",
      input,
      "-acodec",
      "libmp3lame",
      "-f",
      "mp3",
      "-q",
      "5",
      "-strict",
      "-2",
      output,
      ...tolerant,
      "-y",
    ];
  }
  const r = await run(cmd);
  if (r.code !== 0) {
    const msg = r.stderr.trim() || "Unknown FFmpeg error";
    if (r.signal) throw new AudioError("transient", `FFmpeg killed (${r.signal}): ${msg}`);
    if (msg.includes("No such file or directory"))
      throw new AudioError("ffmpeg", `Input file not found: ${input}`);
    if (msg.includes("Invalid data found when processing input"))
      throw new AudioError("invalid_audio", "Invalid or corrupted input file");
    if (msg.includes("Memory allocation error"))
      throw new AudioError("ffmpeg", "Memory allocation failed - file too large.");
    throw new AudioError("ffmpeg", `FFmpeg processing failed: ${msg}`);
  }
  const out = Bun.file(output);
  if (!(await out.exists())) throw new AudioError("conversion", "FFmpeg produced no output file");
  if (out.size === 0) throw new AudioError("conversion", "FFmpeg produced empty output");
  if (outputFormat === "ogg") {
    const head = new Uint8Array(await out.slice(0, 4).arrayBuffer());
    const ogg = String.fromCharCode(...head) === "OggS";
    if (!ogg && out.size < 100)
      throw new AudioError("conversion", `Invalid OGG output (only ${out.size} bytes)`);
  }
}

/** One piece of split_audio_chunk: seek and cut in the output format. */
export async function cutFile(
  source: string,
  output: string,
  format: AudioFormat,
  start: number,
  duration: number,
): Promise<void> {
  const r = await run([
    "ffmpeg",
    "-i",
    source,
    "-f",
    format,
    "-ss",
    pyFloat(start),
    "-t",
    pyFloat(duration),
    output,
    "-y",
  ]);
  if (r.code !== 0) {
    if (r.signal) throw new AudioError("transient", `ffmpeg splitting killed (${r.signal})`);
    throw new AudioError("ffmpeg", `ffmpeg splitting failed: ${r.stderr.trim()}`);
  }
}

/** The concat step of merge_multiple_audio_files_and_save_to_s3. */
export async function concatFiles(
  listFile: string,
  output: string,
  format: "mp3" | "ogg",
): Promise<void> {
  const codec =
    format === "ogg"
      ? ["-acodec", "libvorbis", "-f", "ogg"]
      : ["-acodec", "libmp3lame", "-f", "mp3"];
  const r = await run([
    "ffmpeg",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    ...codec,
    "-q",
    "5",
    output,
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
  ]);
  if (r.code !== 0) {
    if (r.signal) throw new AudioError("transient", `FFmpeg final processing killed (${r.signal})`);
    throw new AudioError(
      "ffmpeg",
      `FFmpeg final processing failed: ${r.stderr.trim() || "Unknown FFmpeg error"}`,
    );
  }
}
