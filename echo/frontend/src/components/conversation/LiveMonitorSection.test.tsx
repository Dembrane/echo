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
import { groupByStatus, LiveMonitorSection } from "./LiveMonitorSection";
import {
	isFinishedSession,
	isLiveRecording,
	isOnRecordingPage,
	monitorStatusGroup,
	settleStatusGroups,
	STATUS_GROUP_ORDER,
} from "./monitorGrouping";
import { isProblemState, StatePill, stateColor } from "./StatePill";

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

	it("renders On recording page for the waiting state", () => {
		const { getByText } = renderPill("waiting");
		expect(getByText("On recording page")).toBeTruthy();
	});

	it("renders Idle for an unknown/idle state", () => {
		const { getByText } = renderPill("idle");
		expect(getByText("Idle")).toBeTruthy();
	});

	it("puts left, backgrounded and away on yellow alongside paused", () => {
		expect(stateColor("paused")).toBe("yellow");
		expect(stateColor("left")).toBe("yellow");
		expect(stateColor("backgrounded")).toBe("yellow");
	});

	it("keeps waiting grey", () => {
		expect(stateColor("waiting")).toBe("gray");
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

	it("opens the drilldown from the keyboard, so tiles are not mouse-only", async () => {
		captureMock.mockClear();
		mockConversations = [baseConversation({ id: "c1", label: "Ada" })];
		const { getByLabelText } = renderSection();
		fireEvent.keyDown(getByLabelText("Open Ada"), { key: "Enter" });
		expect(await screen.findByText("Delete")).toBeTruthy();
		expect(captureMock).toHaveBeenCalledWith(
			"monitor_drilldown_opened",
			expect.objectContaining({ entity_type: "recording", project_id: "p1" }),
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

describe("monitor status grouping", () => {
	it("puts paused, away and waiting on the recording page", () => {
		for (const state of ["paused", "backgrounded", "waiting"] as const) {
			const conversation = baseConversation({ state, is_live: true });
			expect(monitorStatusGroup(conversation)).toBe("recording_page");
			expect(isOnRecordingPage(conversation)).toBe(true);
			expect(isLiveRecording(conversation)).toBe(false);
			expect(isFinishedSession(conversation)).toBe(false);
		}
	});

	it("groups left with finished, not with the recording page", () => {
		// Closing the tab is terminal. Saying someone is on the recording page
		// when they navigated away would be a lie to the host.
		const left = baseConversation({ state: "left", is_live: false });
		expect(monitorStatusGroup(left)).toBe("finished");
		expect(isFinishedSession(left)).toBe(true);
		expect(isOnRecordingPage(left)).toBe(false);
		expect(isLiveRecording(left)).toBe(false);
	});

	it("puts a cleanly finished session in the same group as left", () => {
		const finished = baseConversation({ is_finished: true, is_live: false });
		const left = baseConversation({ state: "left", is_live: false });
		expect(monitorStatusGroup(finished)).toBe(monitorStatusGroup(left));
		expect(isFinishedSession(finished)).toBe(true);
	});

	it("keeps an actively recording conversation in the live group", () => {
		const conversation = baseConversation({
			state: "recording",
			is_live: true,
		});
		expect(monitorStatusGroup(conversation)).toBe("live");
		expect(isLiveRecording(conversation)).toBe(true);
		expect(isOnRecordingPage(conversation)).toBe(false);
	});

	it("keeps offline out of every funnel column", () => {
		const offline = baseConversation({ state: "offline", is_live: false });
		expect(monitorStatusGroup(offline)).toBe("offline");
		expect(isOnRecordingPage(offline)).toBe(false);
		expect(isLiveRecording(offline)).toBe(false);
		expect(isFinishedSession(offline)).toBe(false);
	});

	it("orders status groups by the fixed order, never by count", () => {
		const groups = groupByStatus(
			[
				baseConversation({ id: "a", label: "Ada" }),
				baseConversation({ id: "b", label: "Bob" }),
				baseConversation({ id: "c", label: "Cy" }),
			],
			(conversation) => (conversation.id === "a" ? "recording_page" : "live"),
		);
		expect(groups.map((group) => group.key)).toEqual([
			"recording_page",
			"live",
		]);
		// The bigger bucket does not jump to the front.
		expect(groups[1].items).toHaveLength(2);
	});
});

describe("settleStatusGroups", () => {
	const recording = baseConversation({ id: "c1", state: "recording" });
	const paused = baseConversation({ id: "c1", state: "paused" });

	it("adopts a status immediately on first sighting", () => {
		const settled = settleStatusGroups(new Map(), [recording], 0);
		expect(settled.get("c1")?.group).toBe("live");
	});

	it("holds a tile in place until the new status has settled", () => {
		let settled = settleStatusGroups(new Map(), [recording], 0);
		settled = settleStatusGroups(settled, [paused], 1000);
		// Still rendered under live: the change has not held long enough yet.
		expect(settled.get("c1")?.group).toBe("live");
		expect(settled.get("c1")?.pending).toBe("recording_page");

		settled = settleStatusGroups(settled, [paused], 5000);
		expect(settled.get("c1")?.group).toBe("recording_page");
	});

	it("cancels a pending move when the status flaps back", () => {
		let settled = settleStatusGroups(new Map(), [recording], 0);
		settled = settleStatusGroups(settled, [paused], 1000);
		settled = settleStatusGroups(settled, [recording], 2000);
		expect(settled.get("c1")?.group).toBe("live");
		expect(settled.get("c1")?.pending).toBeNull();

		// And the settle clock restarts, so the flap buys no head start.
		settled = settleStatusGroups(settled, [paused], 3000);
		settled = settleStatusGroups(settled, [paused], 6000);
		expect(settled.get("c1")?.group).toBe("live");
	});

	it("forgets conversations that dropped out of the snapshot", () => {
		const settled = settleStatusGroups(
			settleStatusGroups(new Map(), [recording], 0),
			[],
			1000,
		);
		expect(settled.size).toBe(0);
	});
});

describe("LiveMonitorSection grid-only view", () => {
	it("has no view toggle and writes no view-mode preference", () => {
		localStorage.removeItem("echo_monitor_view_mode");
		mockConversations = [baseConversation({ id: "c1", label: "Ada" })];
		const { queryByText } = renderSection();
		expect(queryByText("Detailed")).toBeNull();
		expect(queryByText("Compressed")).toBeNull();
		expect(localStorage.getItem("echo_monitor_view_mode")).toBeNull();
	});

	it("renders the summary badges as informational, not filters", () => {
		mockConversations = [
			baseConversation({ id: "c1", label: "Ada", is_live: true }),
			baseConversation({
				id: "c2",
				label: "Bob",
				is_live: false,
				has_error: true,
			}),
		];
		const { getByText, queryByRole } = renderSection();
		// The badges are no longer buttons, and nothing gets filtered out.
		expect(queryByRole("button", { name: "1 live" })).toBeNull();
		expect(queryByRole("button", { name: "1 with errors" })).toBeNull();
		expect(getByText("Ada")).toBeTruthy();
		expect(getByText("Bob")).toBeTruthy();
	});
});

describe("LiveMonitorSection grouping dimension", () => {
	it("regroups by status and reports the change once", () => {
		captureMock.mockClear();
		mockConversations = [
			baseConversation({
				created_at: "2026-07-02T12:00:02Z",
				id: "c2",
				is_live: true,
				label: "Bob",
				state: "paused",
			}),
			baseConversation({
				created_at: "2026-07-02T12:00:01Z",
				id: "c1",
				is_live: true,
				label: "Ada",
				state: "recording",
			}),
		];
		const { getByText } = renderSection();
		fireEvent.click(getByText("By status"));

		expect(captureMock).toHaveBeenCalledWith("monitor_grouping_changed", {
			group_by: "status",
			project_id: "p1",
		});

		// Recording-page group first, live group second, whatever the counts.
		// Same left-to-right progression as the funnel above the grid.
		const ada = getByText("Ada");
		const bob = getByText("Bob");
		expect(
			bob.compareDocumentPosition(ada) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("orders grid groups the same way the funnel orders its columns", () => {
		// The funnel reads scanned -> setting up -> recording page -> live ->
		// finished. The grid has no visitor stages, but over the three statuses
		// they share it must not contradict the funnel.
		const shared = STATUS_GROUP_ORDER.filter((group) => group !== "offline");
		expect(shared).toEqual(["recording_page", "live", "finished"]);
	});
});
