import { useCallback, useEffect, useRef, useState } from "react";
import audioAlertSound from "@/assets/audio-alert.mp3";

// Minimum chunk size in bytes - chunks smaller than this are considered suspicious
const MIN_CHUNK_SIZE_BYTES = 1024; // 1KB

type ChunkInfo = {
	size: number;
	timestamp: number;
};

type UseAudioRecorderOptions = {
	onChunk: (chunk: Blob) => void;
	onRecordingInterrupted?: () => void;
	deviceId?: string;
	mimeType?: string;
	timeslice?: number;
	debug?: boolean;
};

type UseAudioRecorderResult = {
	startRecording: (initialTime?: number) => void;
	stopRecording: () => void;
	pauseRecording: () => void;
	resumeRecording: () => void;
	isRecording: boolean;
	isPaused: boolean;
	recordingTime: number;
	errored:
		| boolean
		| {
				message: string;
		  };
	loading: boolean;
	permissionError: string | null;
	hadInterruption: boolean;
	getChunkHistory: () => ChunkInfo[];
	/** Current mic input level in [0, 1] (RMS). 0 when not actively recording
	 * or when the meter is unavailable. Read-only — never affects capture. */
	getAudioLevel: () => number;
};

const preferredMimeTypes = ["audio/webm", "audio/wav", "video/mp4"];

export const getSupportedMimeType = () => {
	for (const mimeType of preferredMimeTypes) {
		if (MediaRecorder.isTypeSupported(mimeType)) {
			return mimeType;
		}
	}
	return "audio/webm";
};

const defaultMimeType = getSupportedMimeType();
const useChunkedAudioRecorder = ({
	onChunk,
	onRecordingInterrupted,
	deviceId,
	mimeType = defaultMimeType,
	timeslice = 30000, // 30 sec
	debug = false,
}: UseAudioRecorderOptions): UseAudioRecorderResult => {
	const [isRecording, setIsRecording] = useState(false);
	const [isPaused, setIsPaused] = useState(false);
	const [userPaused, setUserPaused] = useState(false);

	const isRecordingRef = useRef(isRecording);
	const isPausedRef = useRef(isPaused);
	const userPausedRef = useRef(userPaused);

	const [recordingTime, setRecordingTime] = useState(0);
	const streamRef = useRef<MediaStream | null>(null);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const intervalRef = useRef<NodeJS.Timeout | null>(null);
	const startRecordingIntervalRef = useRef<NodeJS.Timeout | null>(null);

	const audioContextRef = useRef<AudioContext | null>(null);
	const audioProcessorRef = useRef<AudioWorkletNode | null>(null);

	// Read-only VU meter: a passive AnalyserNode tap on the mic stream. It lives
	// on its own AudioContext and is never connected to output, so it cannot
	// disturb capture. Sampled by the host monitor (via the liveness beacon) to
	// prove audio is really flowing and to catch a silent/muted mic.
	const meterCtxRef = useRef<AudioContext | null>(null);
	const meterSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const meterBufferRef = useRef<Uint8Array | null>(null);
	const peakLevelRef = useRef(0);

	// We create and "unlock" the Audio element during user gesture (startRecording),
	// then reuse it for playback later when interruption is detected.
	const audioAlertRef = useRef<HTMLAudioElement | null>(null);

	const [permissionError, setPermissionError] = useState<string | null>(null);

	// Suspicious chunk tracking for iOS interruption detection
	const suspiciousChunkCountRef = useRef(0);
	const hadConsecutiveSuspiciousChunksRef = useRef(false);
	const chunkHistoryRef = useRef<ChunkInfo[]>([]);
	const hasCalledInterruptionCallbackRef = useRef(false);

	const log = (...args: any[]) => {
		if (debug) {
			console.log(...args);
		}
	};

	useEffect(() => {
		// for syncing
		isRecordingRef.current = isRecording;
		isPausedRef.current = isPaused;
		userPausedRef.current = userPaused;
	}, [isRecording, isPaused, userPaused]);

	// Sample the mic RMS frequently and accumulate the window max; the beacon
	// reads and resets it via getAudioLevel. Gated on recording state.
	useEffect(() => {
		const SAMPLE_MS = 100;
		const id = setInterval(() => {
			const analyser = analyserRef.current;
			const buffer = meterBufferRef.current;
			if (
				!analyser ||
				!buffer ||
				!isRecordingRef.current ||
				isPausedRef.current
			) {
				peakLevelRef.current = 0;
				return;
			}
			try {
				analyser.getByteTimeDomainData(buffer);
				let sumSquares = 0;
				for (let i = 0; i < buffer.length; i++) {
					const v = (buffer[i] - 128) / 128;
					sumSquares += v * v;
				}
				const instant = Math.sqrt(sumSquares / buffer.length);
				peakLevelRef.current = Math.max(instant, peakLevelRef.current);
			} catch {
				peakLevelRef.current = 0;
			}
		}, SAMPLE_MS);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		return () => {
			if (streamRef.current) {
				streamRef.current.getTracks().forEach((track) => {
					track.stop();
				});
			}
			if (audioContextRef.current) {
				audioContextRef.current.close();
				audioContextRef.current = null;
			}
			meterSourceRef.current?.disconnect();
			meterSourceRef.current = null;
			if (meterCtxRef.current && meterCtxRef.current.state !== "closed") {
				meterCtxRef.current.close();
			}
			meterCtxRef.current = null;
			analyserRef.current = null;
			meterBufferRef.current = null;
			// Clean up audio alert element
			if (audioAlertRef.current) {
				audioAlertRef.current.pause();
				audioAlertRef.current = null;
			}
		};
	}, []);

	const updateRecordingTime = useCallback(() => {
		setRecordingTime((prev) => prev + 1);
	}, []);

	const chunkBufferRef = useRef<Blob[]>([]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be looked at
	const startRecordingChunk = useCallback(() => {
		log("startRecordingChunk", {
			isRecording,
			mediaRecorderRefState: mediaRecorderRef.current?.state,
		});
		if (!streamRef.current) {
			log("startRecordingChunk: no stream found");
			return;
		}

		// Ensure that any previous MediaRecorder instance is stopped before creating a new one
		if (mediaRecorderRef.current) {
			log("startRecordingChunk: stopping previous MediaRecorder instance");
			mediaRecorderRef.current.stop();
			mediaRecorderRef.current = null;
		}

		log("startRecordingChunk: creating new MediaRecorder instance");
		const recorder = new MediaRecorder(streamRef.current, {
			mimeType: MediaRecorder.isTypeSupported(mimeType)
				? mimeType
				: "audio/webm",
		});
		mediaRecorderRef.current = recorder;

		recorder.ondataavailable = (event) => {
			log("ondataavailable", event.data.size, "bytes");
			if (event.data.size > 0) {
				chunkBufferRef.current.push(event.data);
			}
		};

		recorder.onstop = () => {
			log("MediaRecorder stopped");
			const chunkBlob = new Blob(chunkBufferRef.current, { type: mimeType });
			const chunkSize = chunkBlob.size;

			// Track chunk history for interruption reporting
			chunkHistoryRef.current.push({
				size: chunkSize,
				timestamp: Date.now(),
			});

			// Check if this is a suspicious chunk (< 1KB)
			if (chunkSize < MIN_CHUNK_SIZE_BYTES) {
				suspiciousChunkCountRef.current++;

				// If 2 consecutive suspicious chunks, recording has failed
				if (
					suspiciousChunkCountRef.current >= 2 &&
					!hasCalledInterruptionCallbackRef.current
				) {
					hadConsecutiveSuspiciousChunksRef.current = true;
					hasCalledInterruptionCallbackRef.current = true;

					// Play notification sound for interruption using pre-unlocked audio
					if (audioAlertRef.current) {
						audioAlertRef.current.muted = false;
						audioAlertRef.current.currentTime = 0;
						audioAlertRef.current.play().catch((error) => {
							console.error("Failed to play notification sound:", error);
						});
					}

					// Don't upload suspicious chunk, don't restart recording
					chunkBufferRef.current = [];
					onRecordingInterrupted?.();
					return;
				}

				// First suspicious chunk - don't upload it, but continue recording
				chunkBufferRef.current = [];
				startRecordingChunk();
				return;
			}

			// Good chunk - reset suspicious counter and upload
			suspiciousChunkCountRef.current = 0;
			onChunk(chunkBlob);

			// flush the buffer and restart
			chunkBufferRef.current = [];
			startRecordingChunk();
		};

		// allow for some room to restart so all is just one chunk as per mediarec
		recorder.start(timeslice * 2);
	}, [isRecording]);

	const startRecording = async (initialTime = 0) => {
		try {
			log("Requesting access to the microphone...");

			// We create the Audio element, load it, and play+pause silently to unlock it.
			// This allows programmatic playback later when interruption is detected.
			if (!audioAlertRef.current) {
				const audio = new Audio(audioAlertSound);
				audio.load();
				// Mute before playing to unlock silently on iOS
				audio.muted = true;
				audio
					.play()
					.then(() => {
						audio.pause();
						audio.currentTime = 0;
					})
					.catch(() => {
						// Ignore errors - audio will still work on desktop
					});
				audioAlertRef.current = audio;
			}

			const audioConstraint = deviceId
				? { deviceId: { exact: deviceId } }
				: true;
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: audioConstraint,
			});

			if (!navigator.mediaDevices?.enumerateDevices) {
				log("enumerateDevices() not supported.");
			} else if (debug) {
				// List cameras and microphones (debug only - device labels are
				// semi-identifying and must never log unconditionally in production).
				navigator.mediaDevices
					.enumerateDevices()
					.then((devices) => {
						devices.forEach((device) => {
							log(`${device.kind}: ${device.label} id = ${device.deviceId}`);
						});
					})
					.catch((err) => {
						console.error(`${err.name}: ${err.message}`);
					});
			}

			streamRef.current = stream;
			log("Access to microphone granted.", { stream });

			// Set up the passive VU meter on the captured stream (see refs above).
			// Created here, inside the user gesture, so the AudioContext starts
			// "running" (important on iOS). Best-effort: if Web Audio is missing
			// the recorder works unchanged and the monitor just shows no level.
			try {
				const AudioCtx =
					window.AudioContext ||
					(window as unknown as { webkitAudioContext?: typeof AudioContext })
						.webkitAudioContext;
				if (AudioCtx) {
					const meterCtx = new AudioCtx();
					const source = meterCtx.createMediaStreamSource(stream);
					const analyser = meterCtx.createAnalyser();
					analyser.fftSize = 256;
					source.connect(analyser);
					meterCtxRef.current = meterCtx;
					meterSourceRef.current = source;
					analyserRef.current = analyser;
					meterBufferRef.current = new Uint8Array(analyser.frequencyBinCount);
				}
			} catch (error) {
				log("VU meter setup failed (non-fatal)", error);
			}

			log("Creating MediaRecorder instance");

			// Reset suspicious chunk tracking for new recording session
			suspiciousChunkCountRef.current = 0;
			hadConsecutiveSuspiciousChunksRef.current = false;
			chunkHistoryRef.current = [];
			hasCalledInterruptionCallbackRef.current = false;

			setIsRecording(true);
			setIsPaused(false);
			setUserPaused(false);
			setRecordingTime(initialTime);
			startRecordingChunk();

			// allow to restart recording chunk
			startRecordingIntervalRef.current = setInterval(() => {
				log("Checking if MediaRecorder should be stopped");
				if (mediaRecorderRef.current?.state === "recording") {
					log("attempting to Stop recording chunk");
					mediaRecorderRef.current.stop();

					log("attempt to Restart recording chunk", {
						isRecording,
						mediaRecorderRefState: mediaRecorderRef.current?.state,
					});

					if (isRecording) {
						log("Restarting recording chunk");
						startRecordingChunk();
					}
				}
			}, timeslice);

			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}
			intervalRef.current = setInterval(updateRecordingTime, 1000);
		} catch (error) {
			console.error("Error accessing audio stream", error);
			setPermissionError("Error accessing audio stream");
			setIsRecording(false);
		}
	};

	const stopRecording = () => {
		if (
			mediaRecorderRef.current &&
			mediaRecorderRef.current.state === "recording"
		) {
			mediaRecorderRef.current.stop();
		}
		setIsRecording(false);
		setIsPaused(false);
		setUserPaused(false);
		if (intervalRef.current) {
			clearInterval(intervalRef.current);
		}
		setRecordingTime(0);
		if (startRecordingIntervalRef.current)
			clearInterval(startRecordingIntervalRef.current);
		// remove the worker
		audioProcessorRef.current?.disconnect();
		audioProcessorRef.current = null;
		// close the audio context
		audioContextRef.current?.close();
		audioContextRef.current = null;
		// tear down the VU meter tap
		meterSourceRef.current?.disconnect();
		meterSourceRef.current = null;
		if (meterCtxRef.current && meterCtxRef.current.state !== "closed") {
			meterCtxRef.current.close();
		}
		meterCtxRef.current = null;
		analyserRef.current = null;
		meterBufferRef.current = null;
		streamRef.current?.getTracks().forEach((track) => {
			track.stop();
		});
		streamRef.current = null;
	};

	const pauseRecording = () => {
		if (
			mediaRecorderRef.current &&
			mediaRecorderRef.current.state === "recording"
		) {
			mediaRecorderRef.current.pause();
			setIsPaused(true);
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}
		}
	};

	const userPauseRecording = () => {
		pauseRecording();
		setUserPaused(true);
	};

	const resumeRecording = () => {
		if (
			mediaRecorderRef.current &&
			mediaRecorderRef.current.state === "paused"
		) {
			mediaRecorderRef.current.resume();
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}
			intervalRef.current = setInterval(updateRecordingTime, 1000);
			setIsPaused(false);
			setUserPaused(false);
		}
	};

	const userResumeRecording = () => {
		resumeRecording();
		setUserPaused(false);
	};

	// Current mic input level in [0, 1], the RMS of the time-domain waveform.
	// Returns 0 when not actively recording or when the meter is unavailable.
	// Returns the loudest RMS since the last read, then resets, so each beacon
	// reflects the peak over its own window (not one instant that may be a gap).
	const getAudioLevel = useCallback((): number => {
		if (!isRecordingRef.current || isPausedRef.current) return 0;
		const peak = peakLevelRef.current;
		peakLevelRef.current = 0;
		return peak;
	}, []);

	return {
		errored: false,
		getAudioLevel,
		getChunkHistory: () => chunkHistoryRef.current,
		hadInterruption: hadConsecutiveSuspiciousChunksRef.current,
		isPaused,
		isRecording,
		loading: false,
		pauseRecording: userPauseRecording,
		permissionError,
		recordingTime,
		resumeRecording: userResumeRecording,
		startRecording,
		stopRecording,
	};
};

export default useChunkedAudioRecorder;
