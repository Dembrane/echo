import { AudioError } from "./errors";
import { durationOf, type ProbeResult } from "./ffmpeg";
import type { Media, MediaSource } from "./media";

/** Bytes a second of speech takes at the lowest bitrate anyone records at (6 kbit/s). */
export const MIN_SPEECH_BYTES_PER_SECOND = 750;

export type Measured =
  | { readonly seconds: number; readonly how: "declared" | "decoded" }
  | { readonly unreadable: true; readonly reason: string };

const streamsOf = (p: ProbeResult) => p.streams ?? [];
const hasAudio = (p: ProbeResult) => streamsOf(p).some((s) => s.codec_type === "audio");

/** Whether a declared length is believable enough to charge when the decode fails. */
function plausible(p: ProbeResult, declared: number, bytes: number) {
  if (!Number.isFinite(declared) || declared <= 0) return false;
  if (!hasAudio(p)) return false;
  // More seconds than the bytes can hold.
  if (bytes / declared < MIN_SPEECH_BYTES_PER_SECOND) return false;
  // Far fewer seconds than the bytes hold at the file's own bitrate.
  const streams = streamsOf(p);
  if (!streams.length || streams.some((s) => s.codec_type === "video")) return true;
  const rates = streams.map((s) => Number(s.bit_rate));
  if (!rates.every((r) => Number.isFinite(r) && r > 0)) return true;
  const sum = rates.reduce((a, b) => a + b, 0);
  return (bytes * 8) / declared <= 1.5 * sum + 64_000;
}

const terminal = (err: unknown): err is AudioError => err instanceof AudioError && err.terminal;

/**
 * A file's length in seconds, always decoded: a header can understate it. The declared length is
 * a fallback only when the decode fails and the probe reads a plausible one. Transient failures throw.
 */
export async function measureSeconds(
  media: Media,
  source: MediaSource,
  bytes: number,
  signal?: AbortSignal,
): Promise<Measured> {
  let failed: AudioError;
  try {
    return { seconds: (await media.decodedSeconds(source, { signal })).seconds, how: "decoded" };
  } catch (err) {
    if (!terminal(err)) throw err;
    failed = err;
  }
  let probe: ProbeResult;
  try {
    if (signal?.aborted) throw new AudioError("transient", "measuring aborted");
    probe = await media.probe(source, { signal });
  } catch (err) {
    if (!terminal(err)) throw err;
    return { unreadable: true, reason: failed.message };
  }
  const declared = durationOf(probe);
  if (declared !== null && plausible(probe, declared, bytes))
    return { seconds: declared, how: "declared" };
  return { unreadable: true, reason: failed.message };
}
