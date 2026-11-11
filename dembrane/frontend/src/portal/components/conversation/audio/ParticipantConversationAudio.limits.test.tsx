// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ParticipantConversationAudio } from "./ParticipantConversationAudio";

// The closed-project gate, the free-tier wrap-up and the recorder's interruption
// callback. The rest of the screen is pinned down in
// ParticipantConversationAudio.test.tsx.

const state = vi.hoisted(() => ({
	chunks: [] as unknown[],
	isRecording: false,
	onRecordingInterrupted: undefined as (() => void) | undefined,
	onChunkAccepted: undefined as (() => void) | undefined,
	onRecordingStop: undefined as
		| ((r: string, accepted: boolean) => void)
		| undefined,
	project: {} as Record<string, unknown>,
	recordingTime: 0,
	stopRecording: vi.fn(),
	taking: false as boolean | undefined,
}));

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/lib/api", () => ({
	finishConversation: vi.fn(),
	pingConversation: vi.fn(async () => ({})),
	pingConversationLeft: vi.fn(),
}));
vi.mock("../../../hooks", () => ({
	useConversationChunksQuery: () => ({
		data: state.chunks,
		isLoading: false,
		isSuccess: true,
	}),
	useConversationQuery: () => ({
		data: { id: "c-1", source: "PORTAL_AUDIO" },
		isError: false,
		isLoading: false,
	}),
	useParticipantProjectById: () => ({
		data: { id: "p-1", is_taking_recordings: state.taking, ...state.project },
		isLoading: false,
	}),
	useUploadConversationChunk: (options: {
		onChunkAccepted?: () => void;
		onRecordingStop?: (r: string, accepted: boolean) => void;
	}) => {
		state.onChunkAccepted = options.onChunkAccepted;
		state.onRecordingStop = options.onRecordingStop;
		return { mutateAsync: vi.fn() };
	},
}));
vi.mock("./hooks/useChunkedAudioRecorder", () => ({
	default: (options: { onRecordingInterrupted?: () => void }) => {
		state.onRecordingInterrupted = options.onRecordingInterrupted;
		return {
			errored: false,
			getAudioLevel: () => 0,
			getChunkHistory: () => [],
			hadInterruption: false,
			isPaused: false,
			isRecording: state.isRecording,
			isStarting: false,
			permissionError: null,
			recordingTime: state.recordingTime,
			startRecording: vi.fn(),
			stopRecording: state.stopRecording,
		};
	},
}));
vi.mock("./hooks/usePingConnectionHealth", () => ({
	usePingConnectionHealth: () => ({
		connectionHealthy: true,
		reportPing: vi.fn(),
	}),
}));
vi.mock("./hooks/useRecordingLimit", () => ({ useRecordingLimit: vi.fn() }));
vi.mock("./hooks/useS3ConnectivityCheck", () => ({
	useS3ConnectivityCheck: () => ({ retry: vi.fn(), s3Status: "ok" }),
}));
vi.mock("../../verify/hooks", () => ({
	useConversationArtefacts: () => ({ data: [] }),
}));
vi.mock("@/components/project/ProjectQRCode", () => ({
	useProjectSharingLink: () => "",
}));
vi.mock("@/hooks/useWakeLock", () => ({
	useWakeLock: () => ({
		disableAutoReacquire: vi.fn(),
		enableAutoReacquire: vi.fn(),
		isSupported: true,
		obtainWakeLock: vi.fn(),
		releaseWakeLock: vi.fn(),
		requestWakeLock: vi.fn(),
	}),
}));
vi.mock("@/hooks/useVideoWakeLockFallback", () => ({
	useVideoWakeLockFallback: vi.fn(),
}));
vi.mock("./ParticipantRecordingWaveform", () => ({
	ParticipantRecordingWaveform: () => null,
}));
vi.mock("./StopRecordingConfirmationModal", () => ({
	StopRecordingConfirmationModal: ({
		showVerifyOnFinish,
	}: {
		showVerifyOnFinish: boolean;
	}) => (
		<div data-testid="stop-modal" data-verify={String(showVerifyOnFinish)} />
	),
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
		} as unknown as typeof ResizeObserver;
	}
	if (!globalThis.IntersectionObserver) {
		globalThis.IntersectionObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		} as unknown as typeof IntersectionObserver;
	}
});

afterEach(() => {
	cleanup();
	state.isRecording = false;
	state.project = {};
	state.recordingTime = 0;
	state.stopRecording.mockReset();
});

const page = () => (
	<I18nProvider i18n={i18n}>
		<MantineProvider>
			<MemoryRouter initialEntries={["/p-1/conversation/c-1"]}>
				<Routes>
					<Route
						path="/:projectId/conversation/:conversationId"
						element={<ParticipantConversationAudio />}
					/>
				</Routes>
			</MemoryRouter>
		</MantineProvider>
	</I18nProvider>
);

const renderPage = () => render(page());

it("shows the not-taking page for an empty conversation on a closed project", () => {
	state.taking = false;
	state.chunks = [];
	renderPage();
	expect(screen.getByTestId("portal-not-taking-recordings")).toBeTruthy();
	expect(screen.queryByTestId("portal-audio-record-button")).toBeNull();
});

it("keeps the recorder once the conversation has audio", () => {
	state.taking = false;
	state.chunks = [{ id: "ch-1" }];
	renderPage();
	expect(screen.queryByTestId("portal-not-taking-recordings")).toBeNull();
	expect(screen.getByTestId("portal-audio-record-button")).toBeTruthy();
});

it("shows the recorder on a project taking recordings", () => {
	state.taking = true;
	state.chunks = [];
	renderPage();
	expect(screen.queryByTestId("portal-not-taking-recordings")).toBeNull();
	expect(screen.getByTestId("portal-audio-record-button")).toBeTruthy();
});

// A 402 on the first chunk stops the recorder (time back to 0, no chunk), then a
// focus refetch closes the project: the page must stay, not swap to not-taking.
it("keeps the page after a recording here stopped with no chunk on a now-closed project", () => {
	state.taking = true;
	state.chunks = [];
	state.isRecording = true;
	const { rerender } = renderPage();
	state.isRecording = false;
	state.taking = false;
	rerender(page());
	expect(screen.queryByTestId("portal-not-taking-recordings")).toBeNull();
});

// A mic that drops between chunks ends in the recorder's interruption callback.
// The screen must stop recording and tell the participant, not keep saying it
// is recording.
it("stops recording and shows the interruption notice when the recorder reports one", async () => {
	state.taking = true;
	state.chunks = [{ id: "ch-1" }];
	state.isRecording = true;
	renderPage();
	expect(screen.queryByText("Recording interrupted")).toBeNull();

	act(() => state.onRecordingInterrupted?.());

	expect(state.stopRecording).toHaveBeenCalledTimes(1);
	expect(await screen.findByText("Recording interrupted")).toBeTruthy();
});

// The AI budget ran out mid-recording: the same wrap-up as the monthly audio limit.
it("opens the account wrap-up when a chunk comes back with recording_stop ai_budget", async () => {
	state.taking = true;
	state.chunks = [{ id: "ch-1" }];
	state.isRecording = true;
	renderPage();

	act(() => state.onRecordingStop?.("ai_budget", true));

	expect(state.stopRecording).toHaveBeenCalledTimes(1);
	expect(
		await screen.findByText(
			"Recording has stopped for now. Everything you recorded is saved.",
		),
	).toBeTruthy();
});

// Nothing recorded here was kept: "everything you recorded is saved" would be false.
it.each([
	["a finished conversation reopened at zero", [{ id: "ch-1" }]],
	["an empty conversation finished before recording started", []],
])(
	"shows not-taking when the AI budget refuses and nothing was kept (%s)",
	async (_case, chunks) => {
		state.taking = true;
		state.chunks = chunks;
		state.isRecording = true;
		state.recordingTime = 30;
		renderPage();

		act(() => state.onRecordingStop?.("ai_budget", false));

		expect(state.stopRecording).toHaveBeenCalledTimes(1);
		expect(
			await screen.findByTestId("portal-not-taking-recordings"),
		).toBeTruthy();
		expect(screen.queryByText(/Everything you recorded is saved/)).toBeNull();
	},
);

it("keeps the wrap-up when a chunk was kept here before the refusal", async () => {
	state.taking = true;
	state.chunks = [{ id: "ch-1" }];
	state.isRecording = true;
	renderPage();

	act(() => state.onChunkAccepted?.());
	act(() => state.onRecordingStop?.("ai_budget", false));

	expect(
		await screen.findByText(
			"Recording has stopped for now. Everything you recorded is saved.",
		),
	).toBeTruthy();
	expect(screen.queryByTestId("portal-not-taking-recordings")).toBeNull();
});

it.each([
	[true, "true"],
	[false, "false"],
])(
	"offers verify on finish only while AI is available (is_ai_available %s)",
	(available, offered) => {
		state.taking = true;
		state.recordingTime = 120;
		state.project = {
			is_ai_available: available,
			is_verify_enabled: true,
			is_verify_on_finish_enabled: true,
		};
		renderPage();
		expect(screen.getByTestId("stop-modal").dataset.verify).toBe(offered);
	},
);
