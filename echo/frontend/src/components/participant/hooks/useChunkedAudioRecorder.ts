import { useCallback, useEffect, useRef, useState } from "react";

interface UseAudioRecorderOptions {
	onChunk: (chunk: Blob) => void;
	deviceId?: string;
	mimeType?: string;
	timeslice?: number;
	debug?: boolean;
}

interface UseAudioRecorderResult {
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
}

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

	const [permissionError, setPermissionError] = useState<string | null>(null);

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
			onChunk(new Blob(chunkBufferRef.current, { type: mimeType }));

			startRecordingChunk();

			// flush the buffer
			chunkBufferRef.current = [];
		};

		// allow for some room to restart so all is just one chunk as per mediarec
		recorder.start(timeslice * 2);
	}, [isRecording]);

	const startRecording = async (initialTime = 0) => {
		try {
			log("Requesting access to the microphone...");
			const audioConstraint = deviceId
				? { deviceId: { exact: deviceId } }
				: true;
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: audioConstraint,
			});

			if (!navigator.mediaDevices?.enumerateDevices) {
				console.log("enumerateDevices() not supported.");
			} else {
				// List cameras and microphones.
				navigator.mediaDevices
					.enumerateDevices()
					.then((devices) => {
						devices.forEach((device) => {
							console.log(
								`${device.kind}: ${device.label} id = ${device.deviceId}`,
							);
						});
					})
					.catch((err) => {
						console.error(`${err.name}: ${err.message}`);
					});
			}

			streamRef.current = stream;
			log("Access to microphone granted.", { stream });

			log("Creating MediaRecorder instance");

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

	return {
		errored: false,
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
