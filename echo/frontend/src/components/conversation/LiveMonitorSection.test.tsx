// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	MonitorConversation,
	ParticipantState,
} from "@/hooks/useConversationMonitor";
import { LiveMonitorSection } from "./LiveMonitorSection";
import { isProblemState, StatePill } from "./StatePill";

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

// The drilldown modal reads the project's tags; keep it offline in tests.
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({ data: undefined }),
}));

i18n.load("en-US", {});
i18n.activate("en-US");

// Unmount between tests; some cases intentionally leave a modal open.
afterEach(cleanup);

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
		recorded_seconds: null,
		recording_health: "receiving",
		state: "recording",
		tag_ids: [],
		tags: [],
		timeline: [],
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
	it("opens the edit modal when a row tile is clicked, without navigating", async () => {
		captureMock.mockClear();
		mockConversations = [baseConversation({ id: "c1", label: "Ada" })];
		const { getByText } = renderSection();
		fireEvent.click(getByText("Ada"));
		// Modal opens (Delete action visible); the tile does not navigate.
		expect(await screen.findByText("Delete")).toBeTruthy();
		expect(captureMock).toHaveBeenCalledWith(
			"monitor_drilldown_opened",
			expect.objectContaining({ entity_type: "recording", project_id: "p1" }),
		);
		expect(captureMock).not.toHaveBeenCalledWith(
			"monitor_conversation_opened",
			expect.anything(),
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

	it("opens the drilldown modal from the row pencil without navigating", async () => {
		captureMock.mockClear();
		mockConversations = [baseConversation({ id: "c1", label: "Ada" })];
		const { getByTestId } = renderSection();
		fireEvent.click(getByTestId("monitor-row-edit"));
		// Modal is open (its Delete action is visible) and the row didn't navigate.
		expect(await screen.findByText("Delete")).toBeTruthy();
		expect(captureMock).not.toHaveBeenCalledWith(
			"monitor_conversation_opened",
			expect.anything(),
		);
	});
});

describe("LiveMonitorSection row ordering", () => {
	it("orders rows within a group by created_at ascending", () => {
		mockConversations = [
			baseConversation({
				created_at: "2026-07-02T12:00:03Z",
				id: "b",
				label: "Bravo",
			}),
			baseConversation({
				created_at: "2026-07-02T12:00:01Z",
				id: "c",
				label: "Charlie",
			}),
			baseConversation({
				created_at: "2026-07-02T12:00:02Z",
				id: "a",
				label: "Alpha",
			}),
		];
		const { getByText } = renderSection();
		const charlie = getByText("Charlie");
		const alpha = getByText("Alpha");
		const bravo = getByText("Bravo");
		// Ascending created_at: Charlie (01) -> Alpha (02) -> Bravo (03).
		const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
		expect(charlie.compareDocumentPosition(alpha) & FOLLOWING).toBeTruthy();
		expect(alpha.compareDocumentPosition(bravo) & FOLLOWING).toBeTruthy();
	});
});
