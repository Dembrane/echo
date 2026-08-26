import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type TranscribePurpose, transcribeStateless } from "@/lib/api";
import { useVoiceRecorder, type VoiceRecorderResult } from "./useVoiceRecorder";
import {
	isEmptyTranscript,
	transcribeErrorKind,
	VOICE_MAX_UPLOAD_BYTES,
	VOICE_MIN_DURATION_MS,
	type VoiceErrorKind,
} from "./voiceInput";

/** Record a voice note, send it whole, hand back the transcript.
 *
 * The state machine any composer needs: idle, recording, transcribing, and the
 * error paths in between. It owns the ceilings and the error mapping so a
 * surface only has to render four things and say what to do with the text.
 */

export type VoiceTranscriptionStatus = "idle" | "recording" | "transcribing";

/** Who pays: a project, or a named unmetered purpose where no project exists. */
type VoiceBilling =
	| { projectId: string; purpose?: never }
	| { projectId?: never; purpose: TranscribePurpose };

type UseVoiceTranscriptionOptions = VoiceBilling & {
	/** ISO 639-1, from the host's interface language. */
	language?: string;
	/** Comma-separated proper nouns for the project, so names survive. */
	hotwords?: string;
	/** Called once per successful transcription. The transcript is text, not a
	 * sent message: what the surface does with it is the surface's decision. */
	onTranscript: (transcript: string) => void;
	/** Fired when the recorder stopped itself at the duration ceiling. */
	onDurationLimit?: () => void;
};

type UseVoiceTranscriptionResult = {
	status: VoiceTranscriptionStatus;
	elapsedMs: number;
	levels: number[];
	/** True while the browser prompt is open or the device is warming up. */
	isStarting: boolean;
	errorKind: VoiceErrorKind | null;
	dismissError: () => void;
	start: () => void;
	/** Stop recording and transcribe what was captured. */
	stop: () => void;
	/** Abandon the current recording or an in-flight transcription. Nothing is
	 * uploaded, and an upload already in flight is aborted. */
	cancel: () => void;
};

const extensionForMimeType = (mimeType: string): string => {
	if (mimeType.includes("mp4")) return "m4a";
	if (mimeType.includes("ogg")) return "ogg";
	if (mimeType.includes("wav")) return "wav";
	return "webm";
};

export const useVoiceTranscription = (
	options: UseVoiceTranscriptionOptions,
): UseVoiceTranscriptionResult => {
	const { hotwords, language, onDurationLimit, onTranscript } = options;
	const { projectId, purpose } = options;
	const billing = useMemo<VoiceBilling>(
		() =>
			projectId ? { projectId } : { purpose: purpose as TranscribePurpose },
		[projectId, purpose],
	);
	const [isTranscribing, setIsTranscribing] = useState(false);
	const [errorKind, setErrorKind] = useState<VoiceErrorKind | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const unmountedRef = useRef(false);

	const onTranscriptRef = useRef(onTranscript);
	const onDurationLimitRef = useRef(onDurationLimit);
	useEffect(() => {
		onTranscriptRef.current = onTranscript;
		onDurationLimitRef.current = onDurationLimit;
	}, [onDurationLimit, onTranscript]);

	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
			abortRef.current?.abort();
		};
	}, []);

	const handleComplete = useCallback(
		async ({ blob, durationMs, reachedLimit }: VoiceRecorderResult) => {
			if (reachedLimit) onDurationLimitRef.current?.();
			if (durationMs < VOICE_MIN_DURATION_MS) {
				setErrorKind("too_short");
				return;
			}
			if (blob.size === 0) {
				setErrorKind("empty");
				return;
			}
			if (blob.size > VOICE_MAX_UPLOAD_BYTES) {
				setErrorKind("too_large");
				return;
			}

			const controller = new AbortController();
			abortRef.current = controller;
			setIsTranscribing(true);
			try {
				const response = await transcribeStateless({
					file: blob,
					filename: `voice-note.${extensionForMimeType(blob.type)}`,
					hotwords,
					language,
					signal: controller.signal,
					...billing,
				});
				if (unmountedRef.current || controller.signal.aborted) return;
				if (isEmptyTranscript(response.transcript)) {
					setErrorKind("empty");
					return;
				}
				onTranscriptRef.current(response.transcript);
			} catch (error) {
				if (unmountedRef.current || controller.signal.aborted) return;
				setErrorKind(transcribeErrorKind(error));
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
				if (!unmountedRef.current) setIsTranscribing(false);
			}
		},
		[hotwords, language, billing],
	);

	const handleError = useCallback((kind: VoiceErrorKind) => {
		setErrorKind(kind);
	}, []);

	const recorder = useVoiceRecorder({
		onComplete: handleComplete,
		onError: handleError,
	});

	const start = useCallback(() => {
		setErrorKind(null);
		void recorder.start();
	}, [recorder]);

	const cancel = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsTranscribing(false);
		recorder.cancel();
	}, [recorder]);

	const status: VoiceTranscriptionStatus = isTranscribing
		? "transcribing"
		: recorder.isRecording
			? "recording"
			: "idle";

	return {
		cancel,
		dismissError: () => setErrorKind(null),
		elapsedMs: recorder.elapsedMs,
		errorKind,
		isStarting: recorder.isStarting,
		levels: recorder.levels,
		start,
		status,
		stop: recorder.stop,
	};
};
