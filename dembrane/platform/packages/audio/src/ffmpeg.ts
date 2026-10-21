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

const aborted = (what: string) => new AudioError("transient", `${what} killed (aborted)`);

async function run(cmd: readonly string[], timeoutMs?: number, signal?: AbortSignal): Promise<Run> {
  if (signal?.aborted) throw aborted(cmd[0] ?? "ffmpeg");
  const proc = Bun.spawn([...cmd], {
    stdout: "pipe",
    stderr: "pipe",
    ...(timeoutMs && { timeout: timeoutMs }),
    // Kills the process when the caller gives up.
    ...(signal && { signal }),
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
 * ffmpeg names containers, not file extensions: an .opus file is an ogg stream, an .m4a file an
 * mp4 one. Forcing the extension as the format made every .opus upload fail ("Unknown input
 * format: opus") although the format is accepted.
 */
export const demuxerOf = (format: AudioFormat): string =>
  format === "opus" ? "ogg" : format === "m4a" ? "mp4" : format === "mpeg" ? "mpeg" : format;
/** The same for writing: the muxer ffmpeg knows by that name. */
export const muxerOf = (format: AudioFormat): string =>
  format === "opus" ? "ogg" : format === "m4a" ? "ipod" : format === "aac" ? "adts" : format;

/**
 * probe_from_bytes on a local file: auto-detect first, then with the format hint, and a
 * failure classified as bad bytes or retryable.
 */
export async function probeFile(
  path: string,
  hint: AudioFormat,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  if (!isAudioFormat(hint))
    throw new AudioError("value", `Unsupported or invalid input format '${hint}'.`);
  let r = await run(["ffprobe", ...PROBE_ARGS, path], undefined, signal);
  if (r.code !== 0) {
    if (signal?.aborted) throw aborted("ffprobe");
    r = await run(
      [
        "ffprobe",
        ...PROBE_ARGS.slice(0, 5),
        "-show_format",
        "-show_streams",
        "-f",
        demuxerOf(hint),
        path,
      ],
      undefined,
      signal,
    );
    if (signal?.aborted) throw aborted("ffprobe");
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

/**
 * The real length of a file's first audio stream: decodes it to nowhere and reads ffmpeg's last
 * progress time. Auto-detect first, then with the format hint, as probeFile does.
 */
export async function decodeSeconds(
  path: string,
  hint: AudioFormat,
  signal?: AbortSignal,
): Promise<number> {
  if (!isAudioFormat(hint))
    throw new AudioError("value", `Unsupported or invalid input format '${hint}'.`);
  const decode = (forced: string[]) =>
    run(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        // convertFile's tolerance: a damaged file the pipeline converts still measures.
        "-err_detect",
        "ignore_err",
        ...forced,
        "-i",
        path,
        "-vn",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
      undefined,
      signal,
    );
  let r = await decode([]);
  if (r.code !== 0 && !r.signal && !signal?.aborted) r = await decode(["-f", demuxerOf(hint)]);
  if (signal?.aborted) throw aborted("ffmpeg decode");
  if (r.signal) throw new AudioError("transient", `ffmpeg decode killed (${r.signal})`);
  if (r.code !== 0)
    throw new AudioError("value", `ffmpeg decode failed: ${r.stderr.trim() || "Unknown error"}`);
  const last = [...r.stdout.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1];
  if (last === undefined) throw new AudioError("value", "ffmpeg decode reported no audio time");
  return Number(last) / 1e6;
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
            demuxerOf(inputFormat),
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
            demuxerOf(inputFormat),
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
      demuxerOf(inputFormat),
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
  // The seek comes before the input so ffmpeg jumps to the piece instead of decoding everything
  // before it: a minute from the end of a three hour file took seconds, and a hundred such
  // pieces took minutes. The cut stays sample exact (the audio test compares both orders).
  const r = await run([
    "ffmpeg",
    "-ss",
    pyFloat(start),
    "-i",
    source,
    "-t",
    pyFloat(duration),
    "-f",
    muxerOf(format),
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

export interface Silence {
  readonly start: number;
  readonly end: number;
}

/** Seconds per level frame: short enough to see a breath between two words, long enough to be steady. */
export const LEVEL_FRAME_SECONDS = 0.05;

/** The loudness of a recording, one RMS value in dB for every 50 ms, from ffmpeg's astats. */
export async function levelFrames(path: string): Promise<number[]> {
  const r = await run([
    "ffmpeg",
    "-hide_banner",
    "-nostats",
    "-i",
    path,
    "-af",
    "aresample=16000,asetnsamples=n=800:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f",
    "null",
    "-",
  ]);
  if (r.code !== 0) {
    if (r.signal) throw new AudioError("transient", `ffmpeg level analysis killed (${r.signal})`);
    throw new AudioError("ffmpeg", `level analysis failed: ${r.stderr.trim().slice(-300)}`);
  }
  const out: number[] = [];
  for (const m of r.stdout.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)) {
    const v = m[1] as string;
    out.push(v === "-inf" ? -90 : Math.max(-90, Number(v)));
  }
  return out;
}

export interface PauseOptions {
  /** "fixed" is the old rule: a pause is anything under noiseDb. "adaptive" sets the line from the recording's own levels. */
  readonly method?: "fixed" | "adaptive";
  readonly noiseDb?: number;
  /** Where in the room's noise to speech range the line falls, 0 at the noise floor and 1 at the speech level. */
  readonly alpha?: number;
  readonly minSeconds?: number;
}

export interface Pauses {
  readonly silences: Silence[];
  /** The quietest moments, one per half second of recording at most, for a cut where no pause exists. */
  readonly quiet: { readonly t: number; readonly level: number }[];
  readonly floorDb: number;
  readonly speechDb: number;
  readonly thresholdDb: number;
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))] ?? -90;

/**
 * Pauses in a recording from its loudness frames. A fixed line fails in a noisy room, where
 * the pauses are no quieter than the line and speech sits on it. The adaptive line is set from
 * the recording itself: the room's noise is its quiet tenth (never lower than -70 dB, so
 * digital silence does not push the line to nothing), speech is its loud quarter, and the line
 * sits a fixed share of the way between them. Pauses are runs under the line, at least
 * `minSeconds` long.
 */
export function findPauses(levels: readonly number[], opts: PauseOptions = {}): Pauses {
  const sorted = [...levels].sort((a, b) => a - b);
  const floorDb = Math.max(percentile(sorted, 0.1), -70);
  const speechDb = percentile(sorted, 0.75);
  const thresholdDb =
    opts.method === "fixed"
      ? (opts.noiseDb ?? -35)
      : floorDb + (opts.alpha ?? 0.25) * Math.max(speechDb - floorDb, 6);
  const min = Math.ceil((opts.minSeconds ?? 0.3) / LEVEL_FRAME_SECONDS);
  const silences: Silence[] = [];
  let from = -1;
  levels.forEach((v, i) => {
    if (v < thresholdDb) {
      if (from < 0) from = i;
    } else if (from >= 0) {
      if (i - from >= min)
        silences.push({ start: from * LEVEL_FRAME_SECONDS, end: i * LEVEL_FRAME_SECONDS });
      from = -1;
    }
  });
  if (from >= 0 && levels.length - from >= min)
    silences.push({ start: from * LEVEL_FRAME_SECONDS, end: levels.length * LEVEL_FRAME_SECONDS });
  // Quietest 0.3 s windows, one per 0.5 s: where to cut when speech runs on without a pause.
  const w = Math.round(0.3 / LEVEL_FRAME_SECONDS);
  const quiet: { t: number; level: number }[] = [];
  for (let i = 0; i + w <= levels.length; i += Math.round(0.5 / LEVEL_FRAME_SECONDS)) {
    let sum = 0;
    for (let k = 0; k < w; k++) sum += levels[i + k] as number;
    quiet.push({ t: (i + w / 2) * LEVEL_FRAME_SECONDS, level: sum / w });
  }
  return { silences, quiet, floorDb, speechDb, thresholdDb };
}

/**
 * Pauses in a file: where ffmpeg hears nothing louder than the recording's own noise line for
 * a short while. A recording is cut at these, never in the middle of a word. A pause that runs
 * to the end of the file ends at the duration.
 */
export async function detectSilences(path: string, opts: PauseOptions = {}): Promise<Silence[]> {
  return (await analysePauses(path, opts)).silences;
}

export async function analysePauses(path: string, opts: PauseOptions = {}): Promise<Pauses> {
  return findPauses(await levelFrames(path), opts);
}

/** The `silence_start` and `silence_end` lines of silencedetect, paired in order. */
export function parseSilences(log: string): Silence[] {
  const out: Silence[] = [];
  let open: number | null = null;
  for (const line of log.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (e && open !== null) {
      out.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  // Left open: the file ends in silence; the caller closes it with the duration.
  if (open !== null) out.push({ start: open, end: Number.POSITIVE_INFINITY });
  return out;
}
