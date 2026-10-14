// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { ParticipantConversationAudio } from "./ParticipantConversationAudio";

// Characterization tests: they pin down what the audio screen does today so
// it can be split into hooks and components without changing behaviour.

const navigate = vi.fn();
const finish = vi.fn();
const ping = vi.fn();
const pingLeft = vi.fn();
const capture = vi.fn();
const captureException = vi.fn();
const toastError = vi.fn();
const uploadChunk = vi.fn();

const wakeLock = {
	disableAutoReacquire: vi.fn(),
	enableAutoReacquire: vi.fn(),
	isSupported: true,
	obtainWakeLock: vi.fn(),
	releaseWakeLock: vi.fn(),
};

type RecorderOptions = {
	onChunk: (chunk: Blob) => void;
	onRecordingInterrupted?: () => void;
};

// The recorder the screen sees. The tests drive it: start/stop through the
// screen's buttons, time and chunks through `recorder`.
const recorder = {
	hadInterruption: false,
	options: null as RecorderOptions | null,
	setRecordingTime: (_seconds: number) => {},
	/** What stopRecording returns: settles once the last chunk is handed over. */
	stopped: Promise.resolve() as Promise<unknown>,
};

vi.mock("./hooks/useChunkedAudioRecorder", async () => {
	const { useState } = await import("react");
	return {
		default: (options: RecorderOptions) => {
			recorder.options = options;
			const [isRecording, setIsRecording] = useState(false);
			const [recordingTime, setRecordingTime] = useState(0);
			recorder.setRecordingTime = setRecordingTime;
			return {
				errored: false,
				getAudioLevel: () => 0.5,
				getChunkHistory: () => [{ size: 10 }, { size: 4096 }],
				hadInterruption: recorder.hadInterruption,
				isRecording,
				isStarting: false,
				peekAudioLevel: () => 0.5,
				permissionError: null,
				recordingTime,
				startRecording: async (from = 0) => {
					setRecordingTime(from);
					setIsRecording(true);
					return true;
				},
				stopRecording: () => {
					setIsRecording(false);
					setRecordingTime(0);
					return recorder.stopped;
				},
			};
		},
	};
});

vi.mock("posthog-js", () => ({
	default: {
		capture: (...args: unknown[]) => capture(...args),
		captureException: (...args: unknown[]) => captureException(...args),
	},
}));

vi.mock("@/lib/api", () => ({
	finishConversation: (...args: unknown[]) => finish(...args),
	pingConversation: (...args: unknown[]) => ping(...args),
	pingConversationLeft: (...args: unknown[]) => pingLeft(...args),
}));

vi.mock("@/lib/deviceTelemetry", () => ({
	readBatteryTelemetry: async () => undefined,
	readNetworkTelemetry: () => undefined,
}));

vi.mock("@/lib/visitorId", () => ({ getVisitorId: () => "visitor1" }));

vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => navigate,
}));

vi.mock("@/hooks/useElementOnScreen", () => ({
	useElementOnScreen: () => [{ current: null }, true],
}));

vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => online }));
vi.mock("@/hooks/useWakeLock", () => ({ useWakeLock: () => wakeLock }));
vi.mock("@/hooks/useVideoWakeLockFallback", () => ({
	useVideoWakeLockFallback: () => {},
}));

vi.mock("@/components/common/Toaster", () => ({
	toast: { error: (...args: unknown[]) => toastError(...args) },
}));

vi.mock("@/components/project/ProjectQRCode", () => ({
	useProjectSharingLink: () => null,
}));

vi.mock("./hooks/useS3ConnectivityCheck", () => ({
	useS3ConnectivityCheck: () => ({ retry: () => {}, s3Status: "passed" }),
}));

vi.mock("./hooks/usePingConnectionHealth", () => ({
	usePingConnectionHealth: () => ({
		connectionHealthy: true,
		reportPing: () => {},
	}),
}));

vi.mock("./ParticipantRecordingWaveform", () => ({
	ParticipantRecordingWaveform: ({ paused }: { paused?: boolean }) => (
		<div data-testid="meter" data-paused={String(!!paused)} />
	),
}));
vi.mock("../../settings/ParticipantSettingsModal", () => ({
	ParticipantSettingsModal: () => null,
}));
vi.mock("./PermissionErrorModal", () => ({
	PermissionErrorModal: () => null,
}));

vi.mock("../../verify/hooks", () => ({
	useConversationArtefacts: () => ({ data: [] }),
}));

// What the conversation and project queries return. Tests change these and
// rerender to simulate a refetch.
let conversationQuery: {
	data?: { id: string };
	error?: { message: string; response?: { status: number } };
	isError: boolean;
	isFetching: boolean;
	isLoading: boolean;
};
let project: Record<string, unknown>;
let chunks: { id: string }[];
// The outbox the screen sees: a chunk counts as queued until the promise
// `uploadChunk` returned for it settles.
let queued = 0;
let queueWaiters: (() => void)[] = [];
let online = true;

vi.mock("@/portal/components/conversation/queries", () => ({
	useConversationChunksQuery: () => ({ data: chunks }),
	useConversationQuery: () => conversationQuery,
}));
vi.mock("@/portal/hooks/useParticipantProjectById", () => ({
	useParticipantProjectById: () => ({ data: project, isLoading: false }),
}));
vi.mock("./outbox/OutboxProvider", async () => {
	const { useReducer } = await import("react");
	return {
		useOutbox: () => {
			const [, rerender] = useReducer((n: number) => n + 1, 0);
			return {
				enqueueChunk: async (chunk: Blob, meta: object) => {
					queued += 1;
					rerender();
					try {
						await uploadChunk({ chunk, ...meta });
					} catch {}
					queued -= 1;
					rerender();
					if (queued === 0) for (const done of queueWaiters.splice(0)) done();
				},
				queuedCount: () => queued,
				settled: async () => {
					if (queued > 0)
						await new Promise<void>((done) => queueWaiters.push(done));
				},
			};
		},
	};
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		};
	}
});

beforeEach(() => {
	conversationQuery = {
		data: { id: "c1" },
		isError: false,
		isFetching: false,
		isLoading: false,
	};
	project = { id: "p1" };
	chunks = [];
	queued = 0;
	queueWaiters = [];
	online = true;
	recorder.hadInterruption = false;
	recorder.stopped = Promise.resolve();
	finish.mockResolvedValue({});
	ping.mockResolvedValue(true);
	uploadChunk.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
});

const tree = (path = "/p1/conversation/c1") => (
	<I18nProvider i18n={i18n}>
		<MantineProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route
						path="/:projectId/conversation/:conversationId/*"
						element={<ParticipantConversationAudio />}
					/>
				</Routes>
			</MemoryRouter>
		</MantineProvider>
	</I18nProvider>
);

const renderAudio = (path?: string) => render(tree(path));

const startRecording = async () => {
	fireEvent.click(screen.getByTestId("portal-audio-record-button"));
	await screen.findByTestId("portal-audio-stop-button");
};

const deferred = () => {
	let resolve: (value: unknown) => void = () => {};
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

describe("recording", () => {
	it("starts recording and holds a wake lock", async () => {
		renderAudio();
		await startRecording();

		expect(capture).toHaveBeenCalledWith("recording_started", {
			conversation_id: "c1",
			project_id: "p1",
		});
		expect(wakeLock.obtainWakeLock).toHaveBeenCalled();
		expect(wakeLock.enableAutoReacquire).toHaveBeenCalled();
	});

	it("hands each chunk the recorder produces to the outbox", async () => {
		renderAudio();
		await startRecording();

		const chunk = new Blob(["audio"]);
		act(() => recorder.options?.onChunk(chunk));

		expect(uploadChunk).toHaveBeenCalledWith(
			expect.objectContaining({
				chunk,
				conversationId: "c1",
				source: "PORTAL_AUDIO",
				timestamp: expect.any(Date),
			}),
		);
	});

	it("stopping pauses at the recorded time and asks to confirm", async () => {
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(75));

		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));

		expect(await screen.findByTestId("portal-audio-stop-modal")).toBeTruthy();
		expect(
			screen.getByTestId("portal-audio-recording-timer").textContent,
		).toContain("01:15");
		expect(wakeLock.releaseWakeLock).toHaveBeenCalled();
		expect(wakeLock.disableAutoReacquire).toHaveBeenCalled();
	});

	it("keeps the meter, still, behind the stop modal", async () => {
		renderAudio();
		await startRecording();
		expect(screen.getByTestId("meter").dataset.paused).toBe("false");

		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));

		await screen.findByTestId("portal-audio-stop-modal");
		expect(screen.getByTestId("meter").dataset.paused).toBe("true");
	});

	it("keeps Stop in the bar behind the stop modal", async () => {
		renderAudio();
		await startRecording();

		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));

		await screen.findByTestId("portal-audio-stop-modal");
		expect(screen.getByTestId("portal-audio-stop-button")).toBeTruthy();
	});

	it("resuming continues from the paused time", async () => {
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(75));
		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));

		fireEvent.click(
			await screen.findByTestId("portal-audio-stop-resume-button"),
		);

		await screen.findByTestId("portal-audio-stop-button");
		expect(
			screen.getByTestId("portal-audio-recording-timer").textContent,
		).toContain("01:15");
	});

	it("runs the timer live again once resumed, and can stop again", async () => {
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(75));
		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));
		fireEvent.click(
			await screen.findByTestId("portal-audio-stop-resume-button"),
		);

		act(() => recorder.setRecordingTime(80));
		await waitFor(() =>
			expect(
				screen.getByTestId("portal-audio-recording-timer").textContent,
			).toContain("01:20"),
		);

		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));
		expect(
			await screen.findByTestId("portal-audio-stop-finish-button"),
		).toBeTruthy();
	});
});

describe("finishing", () => {
	const stopAndFinish = async () => {
		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));
		fireEvent.click(
			await screen.findByTestId("portal-audio-stop-finish-button"),
		);
	};

	it("finishes the conversation, then navigates to the finish page", async () => {
		renderAudio();
		await startRecording();
		await stopAndFinish();

		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith("/p1/conversation/c1/finish"),
		);
		expect(finish).toHaveBeenCalledWith("c1");
		expect(capture).toHaveBeenCalledWith("conversation_finished", {
			conversation_id: "c1",
			finish_wait_ms: expect.any(Number),
			pending_uploads_at_start: 0,
			project_id: "p1",
		});
	});

	it("waits for the final chunk, handed over as Finish stops the recorder", async () => {
		const handover = deferred();
		recorder.stopped = handover.promise;
		const upload = deferred();
		uploadChunk.mockReturnValue(upload.promise);
		renderAudio();
		await startRecording();

		// Finish lands before the recorder's onstop has handed the chunk over.
		await stopAndFinish();
		await act(async () => {
			recorder.options?.onChunk(new Blob(["audio"]));
			handover.resolve(undefined);
		});
		expect(finish).not.toHaveBeenCalled();

		await act(async () => upload.resolve({}));
		await waitFor(() => expect(finish).toHaveBeenCalledWith("c1"));
	});

	it("waits for the audio however long it takes, and says when it's slow", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		uploadChunk.mockReturnValue(new Promise(() => {}));
		renderAudio();
		await startRecording();
		act(() => recorder.options?.onChunk(new Blob(["audio"])));

		await stopAndFinish();
		await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));

		expect(finish).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
		expect(capture).toHaveBeenCalledWith(
			"portal_finish_slow",
			expect.objectContaining({ conversation_id: "c1", pending_uploads: 1 }),
		);
		expect(capture).not.toHaveBeenCalledWith(
			"portal_uploads_incomplete_on_finish",
			expect.anything(),
		);
	});

	it("says it's waiting for a connection when finishing offline", async () => {
		online = false;
		uploadChunk.mockReturnValue(new Promise(() => {}));
		renderAudio();
		await startRecording();
		act(() => recorder.options?.onChunk(new Blob(["audio"])));

		await stopAndFinish();

		expect(
			await screen.findByText(
				"Waiting for a connection. Your audio is saved on this device.",
			),
		).toBeTruthy();
		expect(navigate).not.toHaveBeenCalled();
	});

	it("calls off a finish still waiting on the audio when you resume", async () => {
		const upload = deferred();
		uploadChunk.mockReturnValue(upload.promise);
		renderAudio();
		await startRecording();
		act(() => recorder.options?.onChunk(new Blob(["audio"])));
		await stopAndFinish();

		fireEvent.click(
			await screen.findByTestId("portal-audio-stop-resume-button"),
		);
		await screen.findByTestId("portal-audio-stop-button");
		expect(capture).toHaveBeenCalledWith(
			"portal_finish_cancelled",
			expect.objectContaining({ conversation_id: "c1", pending_uploads: 1 }),
		);

		await act(async () => upload.resolve({}));
		expect(finish).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("shows the modal's Finish as loading until the conversation is finished", async () => {
		let resolveFinish: () => void = () => {};
		finish.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveFinish = resolve;
			}),
		);
		renderAudio();
		await startRecording();
		await stopAndFinish();

		const finishButton = screen.getByTestId("portal-audio-stop-finish-button");
		await waitFor(() =>
			expect(finishButton.hasAttribute("data-loading")).toBe(true),
		);
		expect(navigate).not.toHaveBeenCalled();

		resolveFinish();
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith("/p1/conversation/c1/finish"),
		);
	});

	it("shows how many queued chunks have gone, and still lets you Finish", async () => {
		const first = deferred();
		const second = deferred();
		uploadChunk
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		renderAudio();
		await startRecording();
		act(() => {
			recorder.options?.onChunk(new Blob(["audio"]));
			recorder.options?.onChunk(new Blob(["audio"]));
		});
		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));
		const finishButton = await screen.findByTestId(
			"portal-audio-stop-finish-button",
		);

		const progress = screen.getByTestId("portal-audio-upload-progress");
		expect(progress.textContent).toContain("0 of 2");
		expect(finishButton.hasAttribute("disabled")).toBe(false);

		await act(async () => first.resolve({}));
		expect(progress.textContent).toContain("1 of 2");

		await act(async () => second.resolve({}));
		expect(screen.queryByTestId("portal-audio-upload-progress")).toBeNull();
	});

	it("stays on the page and shows an error when finish fails", async () => {
		finish.mockRejectedValue(new Error("boom"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		renderAudio();
		await startRecording();
		await stopAndFinish();

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(navigate).not.toHaveBeenCalled();
	});

	it("shows the modal's Finish as loading after skipping verification", async () => {
		project = {
			id: "p1",
			is_verify_enabled: true,
			is_verify_on_finish_enabled: true,
		};
		let resolveFinish: () => void = () => {};
		finish.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveFinish = resolve;
			}),
		);
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(75));
		await stopAndFinish();
		fireEvent.click(
			await screen.findByTestId("portal-audio-verify-skip-button"),
		);

		// Past the modal's close transition: a closing modal keeps its content
		// mounted for ~200ms, spinner and all.
		await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
		expect(
			screen
				.getByTestId("portal-audio-stop-finish-button")
				.hasAttribute("data-loading"),
		).toBe(true);
		expect(navigate).not.toHaveBeenCalled();

		resolveFinish();
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith("/p1/conversation/c1/finish"),
		);
	});

	it("finishes from the bar's Finish without recording first", async () => {
		chunks = [{ id: "chunk1" }];
		renderAudio();

		fireEvent.click(screen.getByTestId("portal-audio-finish-button"));
		expect(screen.getByTestId("portal-audio-recording-timer")).toBeTruthy();
		expect(screen.queryByTestId("portal-audio-record-button")).toBeNull();

		fireEvent.click(
			await screen.findByTestId("portal-audio-stop-finish-button"),
		);
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith("/p1/conversation/c1/finish"),
		);
	});

	it("shows Finish only once the conversation has chunks", async () => {
		const { rerender } = renderAudio();
		expect(screen.queryByTestId("portal-audio-finish-button")).toBeNull();

		chunks = [{ id: "chunk1" }];
		rerender(tree());
		expect(screen.getByTestId("portal-audio-finish-button")).toBeTruthy();
	});
});

describe("conversation removed mid-recording", () => {
	it.each([404, 403, 410])(
		"stops recording and says the conversation ended on %i",
		async (status) => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const { rerender } = renderAudio();
			await startRecording();

			conversationQuery = {
				error: { message: "gone", response: { status } },
				isError: true,
				isFetching: false,
				isLoading: false,
			};
			rerender(tree());

			expect(await screen.findByText("Conversation ended")).toBeTruthy();
			expect(capture).toHaveBeenCalledWith(
				"portal_conversation_deleted_during_recording",
				{ conversation_id: "c1", project_id: "p1" },
			);
		},
	);

	it("treats other errors as a failed load, not a deletion", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { rerender } = renderAudio();
		await startRecording();

		conversationQuery = {
			error: { message: "flaky", response: { status: 500 } },
			isError: true,
			isFetching: false,
			isLoading: false,
		};
		rerender(tree());

		expect(await screen.findByText("Something went wrong")).toBeTruthy();
		expect(capture).not.toHaveBeenCalledWith(
			"portal_conversation_deleted_during_recording",
			expect.anything(),
		);
	});
});

describe("interruption", () => {
	const interrupt = () => {
		recorder.hadInterruption = true;
		act(() => recorder.options?.onRecordingInterrupted?.());
	};

	it("stops recording and shows the reconnect modal", async () => {
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(42));

		interrupt();

		expect(
			await screen.findByTestId("portal-audio-interruption-modal"),
		).toBeTruthy();
		expect(capture).toHaveBeenCalledWith("portal_recording_interrupted", {
			conversation_id: "c1",
			project_id: "p1",
			recording_time_seconds: 42,
			suspicious_chunk_count: 1,
			total_chunks: 2,
		});
		expect(wakeLock.releaseWakeLock).toHaveBeenCalled();
		expect(
			screen.getByTestId("portal-audio-recording-timer").textContent,
		).toContain("00:42");
	});

	it("reconnects without waiting on uploads, and reports the interruption", async () => {
		// Queued audio stays on the device and sends after the reload.
		uploadChunk.mockReturnValue(new Promise(() => {}));
		renderAudio();
		await startRecording();
		act(() => recorder.options?.onChunk(new Blob(["audio"])));
		interrupt();

		const reconnect = await screen.findByTestId(
			"portal-audio-interruption-reconnect-button",
		);
		expect(reconnect.hasAttribute("disabled")).toBe(false);
		fireEvent.click(reconnect);
		await waitFor(() => expect(captureException).toHaveBeenCalled());
		expect(capture).toHaveBeenCalledWith(
			"portal_recording_error",
			expect.objectContaining({
				issue_type: "audio_interruption",
				total_chunks: 2,
			}),
		);
	});
});

describe("refine (ECHO) button", () => {
	beforeEach(() => {
		project = { id: "p1", is_get_reply_enabled: true };
	});

	it("explains the wait before 60 seconds of recording", async () => {
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(20));

		fireEvent.click(screen.getByTestId("portal-audio-echo-button"));

		expect(
			await screen.findByTestId("portal-audio-echo-info-modal"),
		).toBeTruthy();
		expect(navigate).not.toHaveBeenCalled();
	});

	it("opens refine after 60 seconds", async () => {
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(61));

		fireEvent.click(screen.getByTestId("portal-audio-echo-button"));

		expect(navigate).toHaveBeenCalledWith("/p1/conversation/c1/refine");
	});

	it("stays behind the stop modal, as full as the paused time", async () => {
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(75));

		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));

		await screen.findByTestId("portal-audio-stop-modal");
		expect(screen.getByTestId("portal-audio-echo-button").dataset.variant).toBe(
			"filled",
		);
	});

	it("stays on the refine and verify screens, disabled", async () => {
		for (const screenPath of ["refine", "verify"]) {
			const { unmount } = renderAudio(`/p1/conversation/c1/${screenPath}`);
			await startRecording();

			act(() => recorder.setRecordingTime(61));
			const echo = screen.getByTestId("portal-audio-echo-button");
			expect((echo as HTMLButtonElement).disabled).toBe(true);
			unmount();
		}
	});

	it("is hidden when neither reply nor verify is on", async () => {
		project = { id: "p1" };
		renderAudio();
		await startRecording();

		expect(screen.queryByTestId("portal-audio-echo-button")).toBeNull();
	});
});

describe("host monitor beacon", () => {
	it("pings on arrival as waiting, then as recording", async () => {
		renderAudio();
		await waitFor(() =>
			expect(ping).toHaveBeenCalledWith(
				"c1",
				expect.objectContaining({
					mode: "voice",
					project_id: "p1",
					state: "waiting",
					visitor_id: "visitor1",
				}),
			),
		);

		await startRecording();
		await waitFor(() =>
			expect(ping).toHaveBeenLastCalledWith(
				"c1",
				expect.objectContaining({ audio_level: 0.5, state: "recording" }),
			),
		);
	});

	it("pings every 3 seconds", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		renderAudio();
		await waitFor(() => expect(ping).toHaveBeenCalledTimes(1));

		await act(() => vi.advanceTimersByTimeAsync(3_000));
		expect(ping).toHaveBeenCalledTimes(2);
	});

	it("reports the paused length while the stop modal is open", async () => {
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(75));
		fireEvent.click(screen.getByTestId("portal-audio-stop-button"));

		await waitFor(() =>
			expect(ping).toHaveBeenLastCalledWith(
				"c1",
				expect.objectContaining({ recorded_seconds: 75, state: "paused" }),
			),
		);
	});

	it("sends a left beacon and an abandon event when the tab closes mid-recording", async () => {
		renderAudio();
		await startRecording();
		act(() => recorder.setRecordingTime(30));

		window.dispatchEvent(new Event("pagehide"));

		expect(pingLeft).toHaveBeenCalledWith("c1", "p1");
		expect(capture).toHaveBeenCalledWith(
			"portal_abandoned",
			expect.objectContaining({
				conversation_id: "c1",
				participant_state: "recording",
				recording_time_seconds: 30,
			}),
		);
	});
});

describe("recording telemetry", () => {
	it("reports going offline and coming back", async () => {
		renderAudio();

		window.dispatchEvent(new Event("offline"));
		window.dispatchEvent(new Event("online"));

		expect(capture).toHaveBeenCalledWith(
			"portal_network_offline",
			expect.objectContaining({ conversation_id: "c1" }),
		);
		expect(capture).toHaveBeenCalledWith(
			"portal_network_online",
			expect.objectContaining({ conversation_id: "c1", offline_seconds: 0 }),
		);
	});

	it("reports backgrounding while recording, and returning", async () => {
		renderAudio();
		await startRecording();

		const setHidden = (hidden: boolean) => {
			Object.defineProperty(document, "hidden", {
				configurable: true,
				value: hidden,
			});
			act(() => {
				document.dispatchEvent(new Event("visibilitychange"));
			});
		};
		setHidden(true);
		setHidden(false);

		expect(capture).toHaveBeenCalledWith(
			"portal_recording_backgrounded",
			expect.objectContaining({ conversation_id: "c1" }),
		);
		expect(capture).toHaveBeenCalledWith(
			"portal_recording_foregrounded",
			expect.objectContaining({ conversation_id: "c1" }),
		);
	});
});
