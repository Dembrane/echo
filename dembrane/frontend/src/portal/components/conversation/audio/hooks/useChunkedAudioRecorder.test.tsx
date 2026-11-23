// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/** jsdom has no MediaRecorder and no Audio playback. The hook module reads
 * MediaRecorder at import time, so both fakes have to exist before the import
 * below runs. */
const { getUserMedia, recorderFailure, recorders } = vi.hoisted(() => {
	// lets a test simulate an unsupported-mimeType constructor throw (Safari)
	// or a start() that throws after the ref was already assigned
	const recorderFailure = { failNextConstruct: false, failNextStart: false };

	const recorders: FakeMediaRecorder[] = [];

	class FakeMediaRecorder {
		static isTypeSupported = () => true;
		state: "inactive" | "recording" | "paused" = "inactive";
		timeslice: number | undefined;
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
			recorders.push(this);
		}
		start(timeslice?: number) {
			if (recorderFailure.failNextStart) {
				recorderFailure.failNextStart = false;
				throw new Error("start failed");
			}
			this.timeslice = timeslice;
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

	return { getUserMedia, recorderFailure, recorders };
});

import useChunkedAudioRecorder, {
	type ChunkSink,
} from "./useChunkedAudioRecorder";

const track = { stop: vi.fn() };
const fakeStream = { getTracks: () => [track] } as unknown as MediaStream;

/** A sink that logs what the recorder writes to it, in order. */
const loggingSink = () => {
	const log: string[] = [];
	const sink: ChunkSink = {
		begin: () => {
			log.push("begin");
			return {
				append: (slice) => {
					log.push(`append ${slice.size}`);
				},
				discard: async () => {
					log.push("discard");
				},
				seal: async () => {
					log.push("seal");
				},
			};
		},
	};
	return { log, sink };
};

const { sink } = loggingSink();

const slice = (bytes: number) => ({ data: new Blob([new Uint8Array(bytes)]) });

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
	recorders.length = 0;
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

	const { result } = renderHook(() => useChunkedAudioRecorder({ sink }));

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

	const { result } = renderHook(() => useChunkedAudioRecorder({ sink }));

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

	const { result } = renderHook(() => useChunkedAudioRecorder({ sink }));

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

	const { result } = renderHook(() => useChunkedAudioRecorder({ sink }));

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

	const { result } = renderHook(() => useChunkedAudioRecorder({ sink }));

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

	const { result } = renderHook(() => useChunkedAudioRecorder({ sink }));

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

it("reports an interruption when a chunk restart fails", async () => {
	vi.useFakeTimers();
	getUserMedia.mockResolvedValue(fakeStream);
	const onRecordingInterrupted = vi.fn();
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

	const { result, rerender } = renderHook(() =>
		useChunkedAudioRecorder({ onRecordingInterrupted, sink }),
	);

	await act(async () => {
		await result.current.startRecording();
	});
	expect(result.current.isRecording).toBe(true);

	// the mic ends between chunks, so the next chunk's start() throws
	recorderFailure.failNextStart = true;

	// the chunk timer stops the recorder; its onstop starts the next chunk
	await act(async () => {
		vi.advanceTimersByTime(30000);
		await Promise.resolve();
	});
	rerender();

	expect(onRecordingInterrupted).toHaveBeenCalledTimes(1);
	expect(result.current.hadInterruption).toBe(true);

	// the screen reacts to the callback by stopping, so nothing claims to record
	act(() => {
		result.current.stopRecording();
	});
	expect(result.current.isRecording).toBe(false);
	vi.useRealTimers();
	consoleError.mockRestore();
});

it("writes each slice to the sink as it's recorded, and seals the chunk on stop", async () => {
	getUserMedia.mockResolvedValue(fakeStream);
	const { log, sink } = loggingSink();
	const { result } = renderHook(() => useChunkedAudioRecorder({ sink }));
	await act(async () => {
		await result.current.startRecording();
	});

	const recorder = recorders.at(-1);
	expect(recorder?.timeslice).toBe(1000);
	act(() => {
		recorder?.ondataavailable?.(slice(600));
		recorder?.ondataavailable?.(slice(700));
		recorder?.ondataavailable?.(slice(800));
	});
	// Already written, so a crash now loses none of it.
	expect(log).toEqual(["begin", "append 600", "append 700", "append 800"]);

	await act(() => result.current.stopRecording());

	expect(log).toEqual([
		"begin",
		"append 600",
		"append 700",
		"append 800",
		"seal",
	]);
});

it("seals each good chunk at the chunk mark, and discards one too small to hold audio", async () => {
	vi.useFakeTimers();
	getUserMedia.mockResolvedValue(fakeStream);
	const { log, sink } = loggingSink();
	const { result } = renderHook(() => useChunkedAudioRecorder({ sink }));
	await act(async () => {
		await result.current.startRecording();
	});

	act(() => recorders.at(-1)?.ondataavailable?.(slice(2048)));
	await act(async () => {
		vi.advanceTimersByTime(30000);
		await Promise.resolve();
	});
	act(() => recorders.at(-1)?.ondataavailable?.(slice(600)));
	await act(async () => {
		vi.advanceTimersByTime(30000);
		await Promise.resolve();
	});

	expect(log).toEqual([
		"begin",
		"append 2048",
		"seal",
		"begin",
		"append 600",
		"discard",
		"begin",
	]);
	act(() => {
		result.current.stopRecording();
	});
	vi.useRealTimers();
});

it("resolves stopRecording once the last chunk is handed over", async () => {
	getUserMedia.mockResolvedValue(fakeStream);
	const { log, sink } = loggingSink();
	const { result } = renderHook(() => useChunkedAudioRecorder({ sink }));
	await act(async () => {
		await result.current.startRecording();
	});
	act(() => recorders.at(-1)?.ondataavailable?.(slice(2048)));

	await act(async () => {
		const stopped = result.current.stopRecording();
		// A second stop, before onstop has run, waits on the same chunk.
		await Promise.all([
			stopped.then(() => log.push("stopped")),
			result.current.stopRecording(),
		]);
	});

	expect(log).toEqual(["begin", "append 2048", "seal", "stopped"]);
});
