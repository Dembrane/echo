// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
	MonitorConversation,
	ParticipantState,
} from "@/hooks/useConversationMonitor";
import {
	isProblemState,
	LiveMonitorSection,
	StatePill,
} from "./LiveMonitorSection";

const captureMock = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { capture: captureMock } }));

// Set per test; read lazily by the useConversationMonitor mock at render time.
let mockConversations: MonitorConversation[] = [];

// A complete MonitorSummary so the section renders its rows.
const fullSummary = {
	catch_up_eta_seconds: 0,
	finished: 0,
	live: 1,
	not_receiving: 0,
	offline: 0,
	pending_transcription: 0,
	total: 1,
	transcribing: 0,
	with_errors: 1,
};

vi.mock("@/hooks/useConversationMonitor", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/hooks/useConversationMonitor")>();
	return {
		...actual,
		useConversationMonitor: () => ({
			conversations: mockConversations,
			error: null,
			funnel: { summary: { total: 0 }, visitors: [] },
			isLoading: false,
			isStreaming: true,
			summary: fullSummary,
		}),
	};
});

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: "admin", tier: "free" },
	}),
}));

i18n.load("en-US", {});
i18n.activate("en-US");

// MantineProvider reads the OS color scheme on mount; jsdom has no
// matchMedia, so stub a minimal (always non-matching) implementation.
beforeAll(() => {
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
	// Mantine's FloatingIndicator (in the opened UpgradeModal) needs ResizeObserver.
	window.ResizeObserver =
		window.ResizeObserver ||
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
});

const renderPill = (state: ParticipantState) =>
	render(
		<MantineProvider>
			<StatePill state={state} />
		</MantineProvider>,
	);

describe("StatePill", () => {
	it("renders Recording for the recording state", () => {
		const { getByText } = renderPill("recording");
		expect(getByText("Recording")).toBeTruthy();
	});

	it("renders Offline for the offline state", () => {
		const { getByText } = renderPill("offline");
		expect(getByText("Offline")).toBeTruthy();
	});

	it("renders Away for the backgrounded state", () => {
		const { getByText } = renderPill("backgrounded");
		expect(getByText("Away")).toBeTruthy();
	});

	it("renders Left for the left state", () => {
		const { getByText } = renderPill("left");
		expect(getByText("Left")).toBeTruthy();
	});

	it("renders Idle for an unknown/idle state", () => {
		const { getByText } = renderPill("idle");
		expect(getByText("Idle")).toBeTruthy();
	});
});

const baseConversation = (
	over: Partial<MonitorConversation> = {},
): MonitorConversation =>
	({
		audio_level: 0.5,
		battery: null,
		chunk_count: 1,
		created_at: null,
		duration: null,
		error_message: null,
		has_error: false,
		id: "c1",
		is_finished: false,
		is_live: true,
		label: null,
		language: null,
		last_chunk_at: null,
		last_seen_at: null,
		latest_transcript: null,
		locked: false,
		mode: "voice",
		network: null,
		pending_transcription: 0,
		recording_health: "receiving",
		state: "recording",
		tags: [],
		transcribed_count: 1,
		transcription_status: "up_to_date",
		...over,
	}) as MonitorConversation;

describe("isProblemState", () => {
	it("is false for a healthy receiving conversation", () => {
		expect(isProblemState(baseConversation())).toBe(false);
	});
	it("is true when audio is stalled", () => {
		expect(
			isProblemState(baseConversation({ recording_health: "stalled" })),
		).toBe(true);
	});
	it("is true when the conversation has an error", () => {
		expect(isProblemState(baseConversation({ has_error: true }))).toBe(true);
	});
	it("is true when offline", () => {
		expect(isProblemState(baseConversation({ state: "offline" }))).toBe(true);
	});
	it("is true when transcription is failing", () => {
		expect(
			isProblemState(baseConversation({ transcription_status: "failing" })),
		).toBe(true);
	});
});

const renderSection = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={["/w/w1/projects/p1/monitor"]}>
						<Routes>
							<Route
								path="/w/:workspaceId/projects/:projectId/monitor"
								element={<LiveMonitorSection projectId="p1" standalone />}
							/>
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

describe("LiveMonitorSection click-through", () => {
	it("captures monitor_conversation_opened with from_problem_state when a row is clicked", () => {
		captureMock.mockClear();
		mockConversations = [
			baseConversation({
				has_error: true,
				id: "c1",
				recording_health: "stalled",
			}),
		];
		const { getByText } = renderSection();
		fireEvent.click(getByText("Anonymous participant"));
		expect(captureMock).toHaveBeenCalledWith(
			"monitor_conversation_opened",
			expect.objectContaining({
				conversation_id: "c1",
				from_problem_state: true,
				project_id: "p1",
			}),
		);
	});

	it("captures monitor_locked_row_clicked when a locked row is clicked", () => {
		captureMock.mockClear();
		mockConversations = [baseConversation({ id: "c1", locked: true })];
		const { getByLabelText } = renderSection();
		fireEvent.click(getByLabelText("Locked conversation, upgrade to view"));
		expect(captureMock).toHaveBeenCalledWith(
			"monitor_locked_row_clicked",
			expect.objectContaining({
				conversation_id: "c1",
				project_id: "p1",
			}),
		);
	});
});
