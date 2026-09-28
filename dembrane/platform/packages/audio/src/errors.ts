/**
 * The failure kinds of audio work, as audio_utils.py raised them. They cross the HTTP
 * hop to the media service by `kind`, so the worker can tell bad bytes (terminal: mark
 * the chunk and stop) from an ffmpeg that was killed or a network blip (retry).
 */
export type AudioErrorKind =
  | "ffmpeg"
  | "invalid_audio"
  | "too_large"
  | "too_small"
  | "conversion"
  | "no_mergeable_chunks"
  | "value"
  | "transient";

export class AudioError extends Error {
  constructor(
    readonly kind: AudioErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AudioError";
  }
  /** audio_utils.UNPLAYABLE_AUDIO_ERRORS: only errors that prove the bytes are bad. */
  get unplayable(): boolean {
    return this.kind === "invalid_audio" || this.kind === "too_large" || this.kind === "too_small";
  }
  /** _TERMINAL_CHUNK_ERRORS: the bytes will not change on retry. */
  get terminal(): boolean {
    return (
      this.unplayable ||
      this.kind === "ffmpeg" ||
      this.kind === "value" ||
      this.kind === "conversion"
    );
  }
}

// ffprobe diagnostics that name the bytes as the problem.
const INVALID_INPUT_MARKERS = [
  "Invalid data found when processing input",
  "Failed to find two consecutive MPEG audio frames",
  "moov atom not found",
  "EBML header parsing failed",
  "Invalid argument",
  "End of file",
  "Header missing",
];

/** A killed process (a signal) or an unrecognised message is retryable. */
export function classifyFfprobeFailure(signal: string | null, stderr: string): AudioError {
  const message = `ffprobe error: ${stderr || "Unknown error"}`;
  if (signal) return new AudioError("transient", `${message} (killed, signal ${signal})`);
  if (INVALID_INPUT_MARKERS.some((m) => stderr.includes(m)))
    return new AudioError("invalid_audio", message);
  return new AudioError("ffmpeg", message);
}

/** NoMergeableChunksError's text: every input failed to probe, so a retry cannot merge. */
export function noMergeableChunks(names: readonly string[], errors: readonly string[]): AudioError {
  const detail = names.map((n, i) => `${n}: ${(errors[i] ?? "").slice(0, 200)}`).join("; ");
  return new AudioError(
    "no_mergeable_chunks",
    `No processed data streams (${names.length} chunk(s) failed): ${detail}`,
  );
}
