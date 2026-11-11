import { TRANSCRIBE_TIMEOUT_MS } from "@dembrane/llm";

/**
 * What one request to a speech model may carry, from limits that were measured or published,
 * never from a feeling about "long": the same numbers cut uploads for the live text and the
 * pieces of the final pass, for both providers.
 */
export type SpeechProvider = "whisper" | "gemini";

/** Scaleway's organisation quota for whisper-large-v3: audio seconds per minute, shared by every caller. */
export const SCALEWAY_QUOTA_SECONDS = 1800;
/** The largest audio file the speech-to-text endpoint accepts (a bigger one is refused outright). */
export const SCALEWAY_MAX_BYTES = 25 * 1024 * 1024;
/** Gemini takes 20 MB inline; the final pass has always stayed under 18. */
export const GEMINI_MAX_BYTES = 18 * 1024 * 1024;
/** A request never sends more than this share of a byte limit: containers add framing the estimate misses. */
export const BYTES_MARGIN = 0.8;
/** Our own request timeout, read from the code that enforces it. */
export const REQUEST_TIMEOUT_SECONDS = TRANSCRIBE_TIMEOUT_MS / 1000;
/**
 * Seconds a provider needs to answer per second of audio, measured and doubled for load.
 * Whisper on Scaleway: 379 requests of 30 to 60 s answered in 154 s with three in flight,
 * about 0.03 to 0.06. Gemini on Vertex: a minute-long final piece answers in 9 to 12 s.
 */
export const ANSWER_SECONDS_PER_AUDIO_SECOND: Record<SpeechProvider, number> = {
  whisper: 0.1,
  gemini: 0.4,
};
/** The most of the timeout a request is expected to use; the rest is slack for a slow minute. */
export const TIMEOUT_SHARE = 0.5;
/** The final pass cuts shorter: Gemini's clock drifts over longer pieces (2 s at 60 s, 7 to 12 s at 5 minutes). */
export const FINAL_PIECE_SECONDS = 60;

export interface RequestLimits {
  readonly maxSeconds: number;
  readonly maxBytes: number;
}

/** The limits of one provider, each the smallest of its measured causes. */
export function requestLimits(provider: SpeechProvider): RequestLimits {
  const byAnswerTime = Math.floor(
    (REQUEST_TIMEOUT_SECONDS * TIMEOUT_SHARE) / ANSWER_SECONDS_PER_AUDIO_SECOND[provider],
  );
  return provider === "whisper"
    ? {
        maxSeconds: Math.min(SCALEWAY_QUOTA_SECONDS, byAnswerTime),
        maxBytes: Math.floor(SCALEWAY_MAX_BYTES * BYTES_MARGIN),
      }
    : { maxSeconds: byAnswerTime, maxBytes: Math.floor(GEMINI_MAX_BYTES * BYTES_MARGIN) };
}

/**
 * The longest piece, in seconds, of a file of this size and duration: inside the seconds limit
 * and, at the file's own bitrate, inside the byte limit. `cap` is a shorter ceiling for the
 * final pass.
 */
export function pieceSeconds(
  limits: RequestLimits,
  bytes: number,
  duration: number,
  cap = Number.POSITIVE_INFINITY,
): number {
  const byBytes =
    bytes > 0 && duration > 0
      ? Math.floor((limits.maxBytes * duration) / bytes)
      : limits.maxSeconds;
  return Math.max(1, Math.min(limits.maxSeconds, cap, byBytes));
}
