// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** jsdom has no MediaRecorder and no Audio playback. The hook module reads
 * MediaRecorder at import time, so both fakes have to exist before the import
 * below runs. */
const { getUserMedia, recorderFailure } = vi.hoisted(() => {
	// lets a test simulate an unsupported-mimeType constructor throw (Safari)
	// or a start() that throws after the ref was already assigned
	const recorderFailure = { failNextConstruct: false, failNextStart: false };

	class FakeMediaRecorder {
		static isTypeSupported = () => true;
		state: "inactive" | "recording" | "paused" = "inactive";
		ondataavailable: ((event: { data: Blob }) => void) | null = null;
		onstop: (() => void) | null = null;
		constructor(
			public stream: MediaStream,
			public options?: MediaRecorderOptions,
		) {
			if (recorderFailure.failNextConstruct) {
				recorderFailure.failNextConstruct = false;
				throw new Error("mimeType not supported");
			}
		}
		start() {
			if (recorderFailure.failNextStart) {
				recorderFailure.failNextStart = false;
				throw new Error("start failed");
			}
			this.state = "recording";
		}
		stop() {
			// browsers throw InvalidStateError when stopping an inactive recorder
			if (this.state === "inactive") {
				throw new DOMException("recorder is inactive", "InvalidStateError");
			}
			this.state = "inactive";
			// browsers fire onstop asynchronously, after the caller has swapped
			// in the next recorder
			queueMicrotask(() => this.onstop?.());
		}
	}

	class FakeAudio {
		muted = false;
		currentTime = 0;
		load() {}
		pause() {}
		play() {
			return Promise.resolve();
		}
	}

	const getUserMedia = vi.fn();

	vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
	vi.stubGlobal("Audio", FakeAudio);
	Object.defineProperty(globalThis.navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia },
	});

	return { getUserMedia, recorderFailure };
});

import useChunkedAudioRecorder from "./useChunkedAudioRecorder";

const track = { stop: vi.fn() };
const fakeStream = { getTracks: () => [track] } as unknown as MediaStream;

const makeStream = () => {
	const streamTrack = { stop: vi.fn() };
	return {
		stream: { getTracks: () => [streamTrack] } as unknown as MediaStream,
		track: streamTrack,
	};
};

beforeEach(() => {
	getUserMedia.mockReset();
	recorderFailure.failNextConstruct = false;
	recorderFailure.failNextStart = false;
});

afterEach(() => {
	vi.clearAllTimers();
});

it("ignores a second startRecording while the mic prompt is pending", async () => {
	let grantAccess: (stream: MediaStream) => void = () => {};
	getUserMedia.mockImplementation(
		() =>
			new Promise<MediaStream>((resolve) => {
				grantAccess = resolve;
			}),
	);

	const { result } = renderHook(() =>
		useChunkedAudioRecorder({ onChunk: vi.fn() }),
	);

	act(() => {
		result.current.startRecording();
		result.current.startRecording();
	});

	expect(getUserMedia).toHaveBeenCalledTimes(1);
	await waitFor(() => expect(result.current.isStarting).toBe(true));

	await act(async () => {
		grantAccess(fakeStream);
	});

	await waitFor(() => expect(result.current.isRecording).toBe(true));
	expect(result.current.isStarting).toBe(false);
	expect(getUserMedia).toHaveBeenCalledTimes(1);

	act(() => {
		result.current.stopRecording();
	});
});

it("bails when stopRecording lands while the mic prompt is pending", async () => {
	let grantAccess: (stream: MediaStream) => void = () => {};
	getUserMedia.mockImplementation(
		() =>
			new Promise<MediaStream>((resolve) => {
				grantAccess = resolve;
			}),
	);
	track.stop.mockClear();

	const { result } = renderHook(() =>
		useChunkedAudioRecorder({ onChunk: vi.fn() }),
	);

	act(() => {
		result.current.startRecording();
	});
	await waitFor(() => expect(result.current.isStarting).toBe(true));

	act(() => {
		result.current.stopRecording();
	});

	await act(async () => {
		grantAccess(fakeStream);
	});

	await waitFor(() => expect(result.current.isStarting).toBe(false));
	expect(result.current.isRecording).toBe(false);
	// the stream acquired after cancellation is released, not held open
	expect(track.stop).toHaveBeenCalled();
});

it("ignores startRecording while already recording", async () => {
	getUserMedia.mockResolvedValue(fakeStream);

	const { result } = renderHook(() =>
		useChunkedAudioRecorder({ onChunk: vi.fn() }),
	);

	await act(async () => {
		result.current.startRecording();
	});
	await waitFor(() => expect(result.current.isRecording).toBe(true));

	await act(async () => {
		result.current.startRecording();
	});

	expect(getUserMedia).toHaveBeenCalledTimes(1);

	act(() => {
		result.current.stopRecording();
	});
});

it("clears the latch when the mic is denied so a retry works", async () => {
	getUserMedia.mockRejectedValueOnce(new Error("denied"));
	getUserMedia.mockResolvedValueOnce(fakeStream);
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

	const { result } = renderHook(() =>
		useChunkedAudioRecorder({ onChunk: vi.fn() }),
	);

	await act(async () => {
		result.current.startRecording();
	});
	await waitFor(() => expect(result.current.permissionError).not.toBeNull());
	expect(result.current.isStarting).toBe(false);

	await act(async () => {
		result.current.startRecording();
	});
	await waitFor(() => expect(result.current.isRecording).toBe(true));
	expect(getUserMedia).toHaveBeenCalledTimes(2);

	act(() => {
		result.current.stopRecording();
	});
	consoleError.mockRestore();
});

it("recovers when MediaRecorder construction fails after the mic is granted", async () => {
	const first = makeStream();
	const second = makeStream();
	getUserMedia.mockResolvedValueOnce(first.stream);
	getUserMedia.mockResolvedValueOnce(second.stream);
	recorderFailure.failNextConstruct = true;
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

	const { result } = renderHook(() =>
		useChunkedAudioRecorder({ onChunk: vi.fn() }),
	);

	let started: boolean | undefined;
	await act(async () => {
		started = await result.current.startRecording();
	});

	expect(started).toBe(false);
	expect(result.current.isRecording).toBe(false);
	// the mic is released rather than left hot
	expect(first.track.stop).toHaveBeenCalled();

	await act(async () => {
		started = await result.current.startRecording();
	});

	expect(started).toBe(true);
	await waitFor(() => expect(result.current.isRecording).toBe(true));
	expect(getUserMedia).toHaveBeenCalledTimes(2);

	act(() => {
		result.current.stopRecording();
	});
	consoleError.mockRestore();
});

it("recovers when recorder.start() fails after the ref was assigned", async () => {
	const first = makeStream();
	const second = makeStream();
	getUserMedia.mockResolvedValueOnce(first.stream);
	getUserMedia.mockResolvedValueOnce(second.stream);
	recorderFailure.failNextStart = true;
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

	const { result } = renderHook(() =>
		useChunkedAudioRecorder({ onChunk: vi.fn() }),
	);

	let started: boolean | undefined;
	await act(async () => {
		started = await result.current.startRecording();
	});

	expect(started).toBe(false);
	expect(first.track.stop).toHaveBeenCalled();

	// the retry must not trip over the inactive recorder the failed attempt left
	await act(async () => {
		started = await result.current.startRecording();
	});

	expect(started).toBe(true);
	await waitFor(() => expect(result.current.isRecording).toBe(true));

	act(() => {
		result.current.stopRecording();
	});
	consoleError.mockRestore();
});

it("interrupts instead of throwing when a chunk restart fails", async () => {
	vi.useFakeTimers();
	const first = makeStream();
	getUserMedia.mockResolvedValue(first.stream);
	const onRecordingInterrupted = vi.fn();
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

	const { result } = renderHook(() =>
		useChunkedAudioRecorder({ onChunk: vi.fn(), onRecordingInterrupted }),
	);

	await act(async () => {
		await result.current.startRecording();
	});
	expect(result.current.isRecording).toBe(true);

	// the mic dies between chunks, so the next chunk's start() throws
	recorderFailure.failNextStart = true;

	// the chunk timer stops the active recorder; its onstop spins up the next
	// chunk, whose start() now throws inside the async stop handler
	await act(async () => {
		vi.advanceTimersByTime(30000);
		await Promise.resolve();
		await Promise.resolve();
	});

	// the failure surfaces as an interruption, not a stuck "still recording" state
	expect(onRecordingInterrupted).toHaveBeenCalled();
	expect(result.current.isRecording).toBe(false);
	// the dead mic is released
	expect(first.track.stop).toHaveBeenCalled();

	vi.useRealTimers();
	consoleError.mockRestore();
});
