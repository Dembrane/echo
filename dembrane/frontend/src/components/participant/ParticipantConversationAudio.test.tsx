// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ParticipantConversationAudio } from "./ParticipantConversationAudio";

const state = vi.hoisted(() => ({
	chunks: [] as unknown[],
	isRecording: false,
	onRecordingInterrupted: undefined as (() => void) | undefined,
	stopRecording: vi.fn(),
	taking: false as boolean | undefined,
}));

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/lib/api", () => ({
	finishConversation: vi.fn(),
	pingConversation: vi.fn(async () => ({})),
	pingConversationLeft: vi.fn(),
}));
vi.mock("./hooks", () => ({
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
		data: { id: "p-1", is_taking_recordings: state.taking },
		isLoading: false,
	}),
	useUploadConversationChunk: () => ({ mutateAsync: vi.fn() }),
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
			recordingTime: 0,
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
vi.mock("./verify/hooks", () => ({
	useConversationArtefacts: () => ({ data: [] }),
}));
vi.mock("../project/ProjectQRCode", () => ({
	useProjectSharingLink: () => "",
}));
vi.mock("@/hooks/useWakeLock", () => ({
	useWakeLock: () => ({
		disableAutoReacquire: vi.fn(),
		isSupported: true,
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
