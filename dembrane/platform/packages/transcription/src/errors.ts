/** Anything that stops a chunk from being transcribed. */
export class TranscriptionError extends Error {
  override name = "TranscriptionError";
}

/** The model returned transcript JSON that could not be parsed or repaired. */
export class TranscriptParseError extends TranscriptionError {
  override name = "TranscriptParseError";
  constructor(
    message: string,
    readonly finishReason: string | null = null,
  ) {
    super(message);
  }
  /** The output limit cut the response; the same prompt truncates the same way. */
  get isTruncated(): boolean {
    return ["length", "max_tokens"].includes(String(this.finishReason ?? "").toLowerCase());
  }
}

/** Errors that mean the chunk has no usable audio: marked failed, never retried. */
const RECOVERABLE = [
  "no spoken audio",
  "language_detection cannot be performed",
  "audio duration is too short",
  "file size",
  "empty file",
];

/**
 * Vertex rejected the request body itself, which for us means the audio is bad. The
 * status text is checked too: a 400 is also how a bad schema or a missing group shows up.
 */
export function isVertexInvalidArgument(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: number; responseBody?: string; url?: string; message?: string };
  const text = `${e.message ?? ""} ${e.responseBody ?? ""}`.toLowerCase();
  return (
    e.statusCode === 400 &&
    String(e.url ?? "").includes("aiplatform") &&
    text.includes("invalid_argument")
  );
}

/** _is_recoverable_error: the chunk is done (with an error) and must not be retried. */
export function isRecoverableTranscriptionError(err: unknown): boolean {
  if (isVertexInvalidArgument(err)) return true;
  if (err instanceof TranscriptParseError && err.isTruncated) return true;
  const text = String((err as Error)?.message ?? err).toLowerCase();
  return RECOVERABLE.some((p) => text.includes(p));
}

/** A short label for why transcription failed, for logs and metrics. */
export function transcriptionFailureReason(err: unknown): string {
  if (isVertexInvalidArgument(err)) return "bad_request";
  if (err instanceof TranscriptParseError && err.isTruncated) return "truncated_output";
  const text = String((err as Error)?.message ?? err).toLowerCase();
  return RECOVERABLE.find((p) => text.includes(p)) ?? "other";
}
