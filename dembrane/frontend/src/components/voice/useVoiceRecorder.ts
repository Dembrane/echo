import { useCallback, useEffect, useRef, useState } from "react";
import {
	captureErrorKind,
	VOICE_AUDIO_BITS_PER_SECOND,
	VOICE_LEVEL_SAMPLE_MS,
	VOICE_MAX_DURATION_MS,
	VOICE_WAVEFORM_BARS,
	type VoiceErrorKind,
} from "./voiceInput";

/** One recording, whole. Deliberately not the participant recorder.
 *
 * `useChunkedAudioRecorder` cuts a 30 second timeslice, uploads each piece and
 * carries iOS interruption detection for a session that runs for an hour. A
 * voice note in the composer is the opposite shape: one file, handed over when
 * the host stops, and nothing to recover if they walk away. So this hook keeps
 * the technique (an AnalyserNode tap for the level meter, the same RMS maths)
 * and none of the chunking.
 */

export type VoiceRecorderResult = {
	blob: Blob;
	durationMs: number;
	/** True when the recorder stopped itself at the duration ceiling. The audio
	 * is still good; the caller may want to say why it ended. */
	reachedLimit: boolean;
};

type UseVoiceRecorderOptions = {
	maxDurationMs?: number;
	onComplete: (result: VoiceRecorderResult) => void;
	onError: (kind: VoiceErrorKind) => void;
};

type UseVoiceRecorderResult = {
	isRecording: boolean;
	/** True between the mic request and the first sample: the browser prompt is
	 * open, or the device is warming up. */
	isStarting: boolean;
	elapsedMs: number;
	/** Recent input levels in [0, 1], oldest first. Drives the waveform. */
	levels: number[];
	start: () => Promise<void>;
	stop: () => void;
	/** Stop and throw the audio away. Nothing is uploaded and onComplete never
	 * fires. */
	cancel: () => void;
};

const PREFERRED_MIME_TYPES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/mp4",
	"audio/ogg;codecs=opus",
];

/** Picked at call time, never at module load.
 *
 * The participant recorder's `getSupportedMimeType` is the same idea but runs
 * at import (`const defaultMimeType = getSupportedMimeType()`), which throws
 * anywhere MediaRecorder is absent, including jsdom. Calling it lazily is what
 * lets this hook be imported by a test.
 */
export const pickRecorderMimeType = (): string | undefined => {
	if (typeof MediaRecorder === "undefined") return undefined;
	for (const mimeType of PREFERRED_MIME_TYPES) {
		if (MediaRecorder.isTypeSupported?.(mimeType)) return mimeType;
	}
	return undefined;
};

const canRecord = (): boolean =>
	typeof navigator !== "undefined" &&
	typeof navigator.mediaDevices?.getUserMedia === "function" &&
	typeof MediaRecorder !== "undefined";

export const useVoiceRecorder = ({
	maxDurationMs = VOICE_MAX_DURATION_MS,
	onComplete,
	onError,
}: UseVoiceRecorderOptions): UseVoiceRecorderResult => {
	const [isRecording, setIsRecording] = useState(false);
	const [isStarting, setIsStarting] = useState(false);
	const [elapsedMs, setElapsedMs] = useState(0);
	const [levels, setLevels] = useState<number[]>([]);

	const streamRef = useRef<MediaStream | null>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const partsRef = useRef<Blob[]>([]);
	const startedAtRef = useRef(0);
	const cancelledRef = useRef(false);
	const reachedLimitRef = useRef(false);
	const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const meterCtxRef = useRef<AudioContext | null>(null);
	const meterSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const meterBufferRef = useRef<Uint8Array | null>(null);
	const meterFrameRef = useRef<number | null>(null);
	const lastSampleAtRef = useRef(0);

	// Callbacks are read through refs so restarting a recording never depends on
	// the caller memoising them.
	const onCompleteRef = useRef(onComplete);
	const onErrorRef = useRef(onError);
	useEffect(() => {
		onCompleteRef.current = onComplete;
		onErrorRef.current = onError;
	}, [onComplete, onError]);

	const teardown = useCallback(() => {
		if (tickRef.current !== null) {
			clearInterval(tickRef.current);
			tickRef.current = null;
		}
		if (meterFrameRef.current !== null) {
			cancelAnimationFrame(meterFrameRef.current);
			meterFrameRef.current = null;
		}
		meterSourceRef.current?.disconnect();
		meterSourceRef.current = null;
		analyserRef.current = null;
		meterBufferRef.current = null;
		if (meterCtxRef.current && meterCtxRef.current.state !== "closed") {
			void meterCtxRef.current.close();
		}
		meterCtxRef.current = null;
		for (const track of streamRef.current?.getTracks() ?? []) {
			track.stop();
		}
		streamRef.current = null;
		recorderRef.current = null;
	}, []);

	// The stream and the AudioContext outlive React on their own, so a panel
	// that unmounts mid-recording must hand the microphone back.
	useEffect(() => teardown, [teardown]);

	const stopRecorder = useCallback(() => {
		const recorder = recorderRef.current;
		if (recorder && recorder.state !== "inactive") {
			recorder.stop();
			return;
		}
		teardown();
		setIsRecording(false);
	}, [teardown]);

	const startMeter = useCallback((stream: MediaStream) => {
		// Best effort: without Web Audio the recording still works and the
		// waveform simply stays flat.
		try {
			const AudioCtx =
				window.AudioContext ??
				(window as unknown as { webkitAudioContext?: typeof AudioContext })
					.webkitAudioContext;
			if (!AudioCtx) return;
			const context = new AudioCtx();
			const source = context.createMediaStreamSource(stream);
			const analyser = context.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			meterCtxRef.current = context;
			meterSourceRef.current = source;
			analyserRef.current = analyser;
			meterBufferRef.current = new Uint8Array(analyser.frequencyBinCount);
		} catch {
			return;
		}

		const sample = () => {
			meterFrameRef.current = requestAnimationFrame(sample);
			const analyser = analyserRef.current;
			const buffer = meterBufferRef.current;
			if (!analyser || !buffer) return;
			const now = performance.now();
			if (now - lastSampleAtRef.current < VOICE_LEVEL_SAMPLE_MS) return;
			lastSampleAtRef.current = now;
			analyser.getByteTimeDomainData(buffer as Uint8Array<ArrayBuffer>);
			let sumSquares = 0;
			for (let index = 0; index < buffer.length; index++) {
				const centered = (buffer[index] - 128) / 128;
				sumSquares += centered * centered;
			}
			const rms = Math.sqrt(sumSquares / buffer.length);
			setLevels((current) =>
				[...current, rms].slice(-(VOICE_WAVEFORM_BARS * 2)),
			);
		};
		meterFrameRef.current = requestAnimationFrame(sample);
	}, []);

	const start = useCallback(async () => {
		if (recorderRef.current || isStarting) return;
		if (!canRecord()) {
			onErrorRef.current("unsupported");
			return;
		}

		setIsStarting(true);
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (error) {
			setIsStarting(false);
			onErrorRef.current(captureErrorKind(error));
			return;
		}

		cancelledRef.current = false;
		reachedLimitRef.current = false;
		partsRef.current = [];
		streamRef.current = stream;
		setLevels([]);
		setElapsedMs(0);

		const mimeType = pickRecorderMimeType();
		let recorder: MediaRecorder;
		try {
			recorder = new MediaRecorder(stream, {
				audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND,
				...(mimeType ? { mimeType } : {}),
			});
		} catch {
			setIsStarting(false);
			teardown();
			onErrorRef.current("unsupported");
			return;
		}
		recorderRef.current = recorder;

		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) partsRef.current.push(event.data);
		};

		recorder.onstop = () => {
			const durationMs = Date.now() - startedAtRef.current;
			const parts = partsRef.current;
			const reachedLimit = reachedLimitRef.current;
			const cancelled = cancelledRef.current;
			partsRef.current = [];
			teardown();
			setIsRecording(false);
			setElapsedMs(0);
			setLevels([]);
			if (cancelled) return;
			onCompleteRef.current({
				blob: new Blob(parts, { type: recorder.mimeType || "audio/webm" }),
				durationMs,
				reachedLimit,
			});
		};

		// No timeslice: one dataavailable at stop, so the whole note goes up as
		// a single file. This is the deliberate difference from the portal.
		recorder.start();
		startedAtRef.current = Date.now();
		setIsStarting(false);
		setIsRecording(true);
		startMeter(stream);

		tickRef.current = setInterval(() => {
			const elapsed = Date.now() - startedAtRef.current;
			setElapsedMs(elapsed);
			if (elapsed >= maxDurationMs) {
				reachedLimitRef.current = true;
				stopRecorder();
			}
		}, 200);
	}, [isStarting, maxDurationMs, startMeter, stopRecorder, teardown]);

	const stop = useCallback(() => {
		if (!recorderRef.current) return;
		stopRecorder();
	}, [stopRecorder]);

	const cancel = useCallback(() => {
		if (!recorderRef.current) return;
		cancelledRef.current = true;
		stopRecorder();
	}, [stopRecorder]);

	return { cancel, elapsedMs, isRecording, isStarting, levels, start, stop };
};
