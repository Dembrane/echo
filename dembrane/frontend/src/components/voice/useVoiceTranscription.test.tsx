// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { transcribeStateless } from "@/lib/api";
import { useVoiceTranscription } from "./useVoiceTranscription";

vi.mock("@/lib/api", () => ({
	transcribeStateless: vi.fn(),
}));

const transcribeMock = vi.mocked(transcribeStateless);

/** jsdom has neither MediaRecorder nor a microphone. This is the smallest fake
 * that behaves like the real one for the parts the hook depends on: one blob,
 * handed over at stop. */
class FakeMediaRecorder {
	static instances: FakeMediaRecorder[] = [];
	static supported = true;
	static isTypeSupported = () => FakeMediaRecorder.supported;

	state: "inactive" | "recording" = "inactive";
	mimeType = "audio/webm";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	/** Bytes the fake will produce at stop. */
	payload = new Uint8Array(4096);

	constructor(
		public stream: MediaStream,
		public options?: MediaRecorderOptions,
	) {
		FakeMediaRecorder.instances.push(this);
	}

	start(timeslice?: number) {
		if (timeslice !== undefined) {
			throw new Error("this recorder is meant to produce one whole file");
		}
		this.state = "recording";
	}

	stop() {
		this.state = "inactive";
		this.ondataavailable?.({
			data: new Blob([this.payload], { type: this.mimeType }),
		});
		this.onstop?.();
	}
}

const track = { stop: vi.fn() };
const fakeStream = {
	getTracks: () => [track],
} as unknown as MediaStream;

let getUserMedia: ReturnType<typeof vi.fn>;

const axiosErrorWithStatus = (status: number) => {
	const headers = new AxiosHeaders();
	return new AxiosError("failed", "ERR", { headers }, undefined, {
		config: { headers },
		data: {},
		headers: {},
		status,
		statusText: "",
	});
};

const renderVoice = (onTranscript = vi.fn()) => {
	const view = renderHook(() =>
		useVoiceTranscription({
			hotwords: "dembrane, Eindhoven",
			language: "nl",
			onTranscript,
			projectId: "project-1",
		}),
	);
	return { onTranscript, ...view };
};

const startRecording = async (result: { current: { start: () => void } }) => {
	await act(async () => {
		result.current.start();
	});
};

beforeEach(() => {
	FakeMediaRecorder.instances = [];
	FakeMediaRecorder.supported = true;
	transcribeMock.mockReset();
	getUserMedia = vi.fn().mockResolvedValue(fakeStream);
	vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
	Object.defineProperty(globalThis.navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia },
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("swaps the composer into recording once the microphone is open", async () => {
	const { result } = renderVoice();
	expect(result.current.status).toBe("idle");
	await startRecording(result);
	expect(result.current.status).toBe("recording");
	expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
});

it("sends the whole recording as one file and hands back the transcript", async () => {
	transcribeMock.mockResolvedValue({
		note: "",
		transcript: "  this is what I said  ",
	});
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const { onTranscript, result } = renderVoice();
	await startRecording(result);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2000);
	});
	await act(async () => {
		result.current.stop();
	});

	await waitFor(() => {
		expect(onTranscript).toHaveBeenCalledWith("  this is what I said  ");
	});
	const call = transcribeMock.mock.calls[0][0];
	expect(call.projectId).toBe("project-1");
	expect(call.language).toBe("nl");
	expect(call.hotwords).toBe("dembrane, Eindhoven");
	expect(call.file.size).toBe(4096);
	expect(call.filename).toBe("voice-note.webm");
	expect(result.current.status).toBe("idle");
});

it("never sends anything when the host cancels", async () => {
	const { onTranscript, result } = renderVoice();
	await startRecording(result);
	await act(async () => {
		result.current.cancel();
	});
	expect(transcribeMock).not.toHaveBeenCalled();
	expect(onTranscript).not.toHaveBeenCalled();
	expect(result.current.status).toBe("idle");
});

it("treats a denied microphone as its own answer and stays idle", async () => {
	getUserMedia.mockRejectedValue(new DOMException("no", "NotAllowedError"));
	const { result } = renderVoice();
	await startRecording(result);
	expect(result.current.errorKind).toBe("permission");
	expect(result.current.status).toBe("idle");
	expect(transcribeMock).not.toHaveBeenCalled();
});

it("says so rather than uploading when the browser cannot record at all", async () => {
	vi.stubGlobal("MediaRecorder", undefined);
	const { result } = renderVoice();
	await startRecording(result);
	expect(result.current.errorKind).toBe("unsupported");
});

it("refuses a mis-tap instead of letting the pipeline reject it", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const { result } = renderVoice();
	await startRecording(result);
	await act(async () => {
		result.current.stop();
	});
	expect(result.current.errorKind).toBe("too_short");
	expect(transcribeMock).not.toHaveBeenCalled();
});

it("stops itself at the duration ceiling and still transcribes what it caught", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	transcribeMock.mockResolvedValue({ note: "", transcript: "a long thought" });
	const onDurationLimit = vi.fn();
	const onTranscript = vi.fn();
	const { result } = renderHook(() =>
		useVoiceTranscription({
			onDurationLimit,
			onTranscript,
			projectId: "project-1",
		}),
	);
	await startRecording(result);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 400);
	});
	expect(onDurationLimit).toHaveBeenCalledTimes(1);
	await waitFor(() => {
		expect(onTranscript).toHaveBeenCalledWith("a long thought");
	});
});

it("names the size ceiling when the server refuses the upload", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	transcribeMock.mockRejectedValue(axiosErrorWithStatus(413));
	const { result } = renderVoice();
	await startRecording(result);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2000);
	});
	await act(async () => {
		result.current.stop();
	});
	await waitFor(() => {
		expect(result.current.errorKind).toBe("too_large");
	});
	expect(result.current.status).toBe("idle");
});

it("does not paste the pipeline's word for silence into the composer", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	transcribeMock.mockResolvedValue({
		note: "",
		transcript: "[Nothing to transcribe]",
	});
	const { onTranscript, result } = renderVoice();
	await startRecording(result);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2000);
	});
	await act(async () => {
		result.current.stop();
	});
	await waitFor(() => {
		expect(result.current.errorKind).toBe("empty");
	});
	expect(onTranscript).not.toHaveBeenCalled();
});

it("hands the microphone back when the recording ends", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	transcribeMock.mockResolvedValue({ note: "", transcript: "done" });
	track.stop.mockClear();
	const { result } = renderVoice();
	await startRecording(result);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2000);
	});
	await act(async () => {
		result.current.stop();
	});
	expect(track.stop).toHaveBeenCalled();
});
