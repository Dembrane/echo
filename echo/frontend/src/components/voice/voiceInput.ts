/** Pure rules for voice input. No React, no browser APIs, no i18n.
 *
 * Everything here is deliberately free of the microphone so the parts that can
 * go wrong (the ceilings, the error mapping, what lands in the composer) are
 * testable without a real device.
 */

import axios from "axios";

/** Hard stop on how long one voice note may run.
 *
 * The endpoint transcribes synchronously, so the whole recording is one HTTP
 * request that stays open through a Gemini pass. Five minutes of speech is
 * roughly 750 words, which is far more than a chat message needs, and it keeps
 * that request well inside any reverse-proxy read timeout. The recorder stops
 * itself here rather than letting the host talk into a request that will die.
 */
export const VOICE_MAX_DURATION_MS = 5 * 60 * 1000;

/** Anything shorter than this is a mis-tap, not a voice note. The transcription
 * pipeline itself rejects very short audio with "audio duration is too short",
 * so catching it here turns an opaque 502 into a sentence the host can act on. */
export const VOICE_MIN_DURATION_MS = 700;

/** Client-side byte ceiling.
 *
 * The server refuses above 100 MB (STATELESS_UPLOAD_MAX_MB, a 413). This guard
 * sits far below that on purpose: at the pinned bitrate below, five minutes is
 * about 1.2 MB, so a blob anywhere near 20 MB means the browser ignored the
 * bitrate hint. Failing here is a clear message; failing at 100 MB is a failed
 * upload after the host already waited for it.
 */
export const VOICE_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Opus at 32 kbps mono is transparent enough for speech and makes the file
 * size predictable, which is what lets the ceiling above be a real check
 * rather than a guess. */
export const VOICE_AUDIO_BITS_PER_SECOND = 32_000;

/** Generous, because the response only arrives once transcription finishes.
 * Shorter than this and a long-but-legal recording would time out on the
 * client while the server was still doing the work it was asked to do. */
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;

/** How many level samples the waveform keeps. */
export const VOICE_WAVEFORM_BARS = 32;

/** How often the meter pushes a new sample into React state. Fast enough to
 * look live, slow enough not to re-render the composer every frame. */
export const VOICE_LEVEL_SAMPLE_MS = 80;

/** The transcription pipeline's own sentinel for silence. It is a valid 200,
 * so it has to be recognised rather than pasted into the composer. */
export const NOTHING_TO_TRANSCRIBE = "[Nothing to transcribe]";

export type VoiceErrorKind =
	| "permission"
	| "unsupported"
	| "device"
	| "too_short"
	| "too_large"
	| "empty"
	| "not_allowed"
	| "not_found"
	| "transcription_failed"
	| "network"
	| "unknown";

const PERMISSION_ERROR_NAMES = new Set([
	"NotAllowedError",
	"PermissionDeniedError",
	"SecurityError",
]);

const DEVICE_ERROR_NAMES = new Set([
	"NotFoundError",
	"DevicesNotFoundError",
	"NotReadableError",
	"TrackStartError",
	"OverconstrainedError",
	"AbortError",
]);

/** Why getUserMedia said no. A denial is a normal answer, not a fault, so it
 * gets its own kind and never falls through to "unknown". */
export const captureErrorKind = (error: unknown): VoiceErrorKind => {
	const name =
		typeof error === "object" && error !== null && "name" in error
			? String((error as { name: unknown }).name)
			: "";
	if (PERMISSION_ERROR_NAMES.has(name)) return "permission";
	if (DEVICE_ERROR_NAMES.has(name)) return "device";
	return "device";
};

/** Map a failed transcription request onto something the host can act on.
 *
 * The status codes are the endpoint's own: 413 is its size ceiling, 502 is a
 * TranscriptionError from the pipeline, 403 is write access it does not have,
 * and 404 is a project it is not a member of (the access ladder answers
 * "not found" rather than confirming the project exists).
 */
export const transcribeErrorKind = (error: unknown): VoiceErrorKind => {
	if (!axios.isAxiosError(error)) return "unknown";
	const status = error.response?.status;
	if (status === undefined) return "network";
	if (status === 413) return "too_large";
	if (status === 400) return "empty";
	if (status === 403) return "not_allowed";
	if (status === 404) return "not_found";
	if (status === 502 || status === 504) return "transcription_failed";
	if (status >= 500) return "transcription_failed";
	return "unknown";
};

/** m:ss. Recordings are capped at five minutes, so hours never arise. */
export const formatElapsed = (elapsedMs: number): string => {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

/** What the composer holds after a transcript arrives.
 *
 * The transcript is added to the draft rather than sent, so a mishearing is
 * something the host fixes before anyone reads it. Appending (rather than
 * replacing) means dictating after typing never destroys what was typed.
 */
export const mergeTranscriptIntoDraft = (
	draft: string,
	transcript: string,
): string => {
	const incoming = transcript.trim();
	if (!incoming) return draft;
	const existing = draft.trimEnd();
	if (!existing) return incoming;
	return `${existing} ${incoming}`;
};

/** True when a 200 came back with nothing usable in it. */
export const isEmptyTranscript = (transcript: string): boolean => {
	const trimmed = transcript.trim();
	return trimmed.length === 0 || trimmed === NOTHING_TO_TRANSCRIBE;
};

/** Bar heights in percent for the waveform, oldest first, padded to a fixed
 * count so the row never changes width as samples arrive.
 *
 * The square root spreads quiet speech across the visible range; raw RMS on a
 * normal speaking voice sits near the floor and reads as a dead meter.
 */
export const waveformHeights = (
	levels: number[],
	barCount = VOICE_WAVEFORM_BARS,
): number[] => {
	const recent = levels.slice(-barCount);
	const padding = Array<number>(Math.max(0, barCount - recent.length)).fill(0);
	return [...padding, ...recent].map((level) => {
		const scaled = Math.sqrt(Math.max(0, Math.min(1, level))) * 100;
		// A floor of 8% keeps the row legible as a meter during silence instead
		// of collapsing to an invisible line.
		return Math.max(8, Math.min(100, scaled));
	});
};
