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

vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
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
	ParticipantRecordingWaveform: () => null,
}));
vi.mock("./ParticipantSettingsModal", () => ({
	ParticipantSettingsModal: () => null,
}));
vi.mock("./PermissionErrorModal", () => ({
	PermissionErrorModal: () => null,
}));

vi.mock("./verify/hooks", () => ({
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

vi.mock("./hooks", () => ({
	useConversationChunksQuery: () => ({ data: chunks }),
	useConversationQuery: () => conversationQuery,
	useParticipantProjectById: () => ({ data: project, isLoading: false }),
	useUploadConversationChunk: () => ({
		isPending: false,
		mutateAsync: (...args: unknown[]) => uploadChunk(...args),
	}),
}));

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
	recorder.hadInterruption = false;
	finish.mockResolvedValue({});
	ping.mockResolvedValue(true);
	uploadChunk.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
});

const tree = () => (
	<I18nProvider i18n={i18n}>
		<MantineProvider>
			<MemoryRouter initialEntries={["/p1/conversation/c1"]}>
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

const renderAudio = () => render(tree());

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

	it("uploads each chunk the recorder hands over", async () => {
		renderAudio();
		await startRecording();

		const chunk = new Blob(["audio"]);
		act(() => recorder.options?.onChunk(chunk));

		expect(uploadChunk).toHaveBeenCalledWith(
			expect.objectContaining({
				chunk,
				conversationId: "c1",
				runFinishHook: false,
				source: "PORTAL_AUDIO",
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
			project_id: "p1",
		});
	});

	it("waits for chunk uploads still in flight before finishing", async () => {
		const upload = deferred();
		uploadChunk.mockReturnValue(upload.promise);
		renderAudio();
		await startRecording();
		act(() => recorder.options?.onChunk(new Blob(["audio"])));

		await stopAndFinish();
		await new Promise((r) => setTimeout(r, 200));
		expect(finish).not.toHaveBeenCalled();

		upload.resolve({});
		await waitFor(() => expect(finish).toHaveBeenCalledWith("c1"));
	});

	it("gives up waiting on uploads after 30 seconds and finishes anyway", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		uploadChunk.mockReturnValue(new Promise(() => {}));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		renderAudio();
		await startRecording();
		act(() => recorder.options?.onChunk(new Blob(["audio"])));

		await stopAndFinish();
		await act(() => vi.advanceTimersByTimeAsync(30_100));

		await waitFor(() => expect(finish).toHaveBeenCalledWith("c1"));
		expect(capture).toHaveBeenCalledWith(
			"portal_uploads_incomplete_on_finish",
			expect.objectContaining({ context: "finish", pending_uploads: 1 }),
		);
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

	it("reconnect waits for uploads, then reports the interruption", async () => {
		const upload = deferred();
		uploadChunk.mockReturnValue(upload.promise);
		renderAudio();
		await startRecording();
		act(() => recorder.options?.onChunk(new Blob(["audio"])));
		interrupt();

		fireEvent.click(
			await screen.findByTestId("portal-audio-interruption-reconnect-button"),
		);
		await new Promise((r) => setTimeout(r, 200));
		expect(captureException).not.toHaveBeenCalled();

		upload.resolve({});
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
