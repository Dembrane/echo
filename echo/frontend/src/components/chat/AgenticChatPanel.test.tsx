// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { AgenticRunEvent, AgenticRunStatus } from "@/lib/api";

/**
 * A harness for run state, which is the thing this file exists for.
 *
 * The live-vs-settled logic in AgenticChatPanel has been wrong twice (#938,
 * #945) and both times it shipped, because nothing rendered the panel with a
 * run in flight. Both bugs had the same shape: a tool group from a finished
 * turn started speaking in the present tense again. So these tests drive the
 * real panel from real run events and assert what a reader would see.
 */

const RUN_ID = "run-1";

// vi.mock factories are hoisted above every top-level binding, so the state
// they close over has to be hoisted with them.
const { runState, stopAgenticRunMock } = vi.hoisted(() => ({
	runState: { events: [], status: "running" } as {
		events: AgenticRunEvent[];
		status: AgenticRunStatus;
	},
	stopAgenticRunMock: vi.fn(async () => ({
		run_id: "run-1",
		status: "stopping" as const,
		turn_seq: 1,
	})),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		appendAgenticRunMessage: vi.fn(),
		createAgentInsight: vi.fn(),
		createAgenticRun: vi.fn(),
		dismissAgentInsight: vi.fn(),
		getAgentInsights: vi.fn(async () => []),
		getAgenticRun: vi.fn(async () => ({
			id: RUN_ID,
			status: runState.status,
		})),
		getAgenticRunEvents: vi.fn(async (_runId: string, afterSeq: number) => ({
			done: false,
			events: runState.events.filter((event) => event.seq > afterSeq),
			next_seq: runState.events.at(-1)?.seq ?? 0,
			run_id: RUN_ID,
			status: runState.status,
		})),
		getDismissedAgentInsightIds: vi.fn(async () => []),
		getLatestAgenticRunForChat: vi.fn(async () => ({
			id: RUN_ID,
			status: runState.status,
		})),
		stopAgenticRun: stopAgenticRunMock,
		// Never resolves: an in-flight run is one whose stream is still open, and
		// resolving would let the panel re-read the status and settle.
		streamAgenticRun: vi.fn(() => new Promise(() => {})),
	};
});

vi.mock("@/components/chat/hooks", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/components/chat/hooks")>();
	return {
		...actual,
		useChat: () => ({ data: undefined }),
		useChatHistory: () => ({ data: [] }),
		useProjectChatContext: () => ({ data: { conversations: [] } }),
		useUpdateChatMutation: () => ({ mutate: vi.fn() }),
	};
});

vi.mock("@/components/conversation/hooks", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/components/conversation/hooks")>();
	return {
		...actual,
		useClearChatContextMutation: () => ({ isPending: false, mutate: vi.fn() }),
		useConversationsByProjectId: () => ({ data: [] }),
	};
});

vi.mock("@/hooks/useLanguage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks/useLanguage")>();
	return {
		...actual,
		useLanguage: () => ({ iso639_1: "en", language: "en-US" }),
	};
});

vi.mock("@/hooks/useWorkspace", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks/useWorkspace")>();
	return {
		...actual,
		useWorkspace: () => ({
			workspace: { id: "workspace-1" },
			workspaceId: "workspace-1",
		}),
	};
});

vi.mock("@/hooks/useWorkspaceUsage", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/hooks/useWorkspaceUsage")>();
	return { ...actual, useWorkspaceUsage: () => ({ freeTier: null }) };
});

// Children that carry their own data layer and nothing to do with run state.
vi.mock("./ChatAccordion", () => ({ ChatAccordionItemMenu: () => null }));
vi.mock("./ChatTemplatesMenuConnected", () => ({
	ChatTemplatesMenuConnected: () => null,
}));
vi.mock("@/components/conversation/ProjectConversationsPanel", () => ({
	ProjectConversationsPanel: () => null,
}));
vi.mock("./ChatHistoryMessage", () => ({
	ChatHistoryMessage: ({
		message,
	}: {
		message: { content: string; id: string; role: string };
	}) => (
		<div data-testid={`chat-message-${message.role}`}>{message.content}</div>
	),
}));

import { AgenticChatPanel } from "./AgenticChatPanel";

const at = (seq: number) =>
	new Date(Date.UTC(2026, 7, 1, 10, seq)).toISOString();

const messageEvent = (
	seq: number,
	role: "assistant" | "user",
	content: string,
): AgenticRunEvent => ({
	event_type: role === "user" ? "user.message" : "assistant.message",
	id: seq,
	payload: { content },
	project_agentic_run_id: RUN_ID,
	seq,
	timestamp: at(seq),
});

const toolEvent = (
	seq: number,
	phase: "end" | "start",
	callId: string,
	toolName = "listProjectConversations",
): AgenticRunEvent => ({
	event_type: phase === "start" ? "on_tool_start" : "on_tool_end",
	id: seq,
	payload: { name: toolName, run_id: callId },
	project_agentic_run_id: RUN_ID,
	seq,
	timestamp: at(seq),
});

/** A finished turn: the host asked, three steps ran and closed, the assistant
 * answered. Nothing here is still working. */
const FINISHED_TURN: AgenticRunEvent[] = [
	messageEvent(1, "user", "what came up in the interviews?"),
	toolEvent(2, "start", "call-a"),
	toolEvent(3, "end", "call-a"),
	toolEvent(4, "start", "call-b", "getProjectSettings"),
	toolEvent(5, "end", "call-b", "getProjectSettings"),
	toolEvent(6, "start", "call-c", "grepDocs"),
	toolEvent(7, "end", "call-c", "grepDocs"),
	messageEvent(8, "assistant", "three themes came up."),
];

/** The finished turn, plus a second question the run is now working on. */
const FINISHED_TURN_THEN_NEW_QUESTION: AgenticRunEvent[] = [
	...FINISHED_TURN,
	messageEvent(9, "user", "and what did they say about parking?"),
];

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

	// jsdom has neither, and useStickToBottom needs both.
	window.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	} as unknown as typeof ResizeObserver;
	Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
});

beforeEach(() => {
	window.localStorage.clear();
	stopAgenticRunMock.mockClear();
	runState.events = [];
	runState.status = "running";
});

afterEach(() => {
	cleanup();
});

const renderPanel = () =>
	render(
		<MemoryRouter>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<QueryClientProvider
						client={
							new QueryClient({
								defaultOptions: { queries: { retry: false } },
							})
						}
					>
						<AgenticChatPanel chatId="chat-1" projectId="project-1" />
					</QueryClientProvider>
				</MantineProvider>
			</I18nProvider>
		</MemoryRouter>,
	);

const settledGroup = async () =>
	await screen.findByTestId("agentic-tool-group");

describe("AgenticChatPanel, tool groups and the live indicator", () => {
	it("leaves a finished turn's tool group settled while a later run is in flight", async () => {
		// The regression from #938 and #945, in one assertion: turn one is over,
		// turn two has started, and the old group must not go back to the present
		// tense just because something is running now.
		runState.events = FINISHED_TURN_THEN_NEW_QUESTION;
		runState.status = "running";
		renderPanel();

		const group = await settledGroup();
		expect(group.textContent).toContain("Worked through 3 steps");
		expect(group.textContent).not.toContain("Working");

		const dot = group.querySelector<HTMLElement>("[aria-hidden='true']");
		expect(dot?.className).not.toContain("animate-pulse");
		expect(dot?.getAttribute("style")).toContain("completed-dot");
	});

	it("keeps the group settled even when the group is the newest node", async () => {
		// #945 keyed on "the newest tool group", so a group that is also the last
		// node was the worst case. It is a finished turn either way.
		runState.events = FINISHED_TURN.slice(0, 8);
		runState.status = "running";
		renderPanel();

		const group = await settledGroup();
		expect(group.textContent).toContain("Worked through 3 steps");
	});

	it("still shows a group as running while one of its own steps is running", async () => {
		// The other direction: a group must not go quiet when a step really is in
		// progress. This is what #938 was originally protecting.
		runState.events = [
			messageEvent(1, "user", "what came up in the interviews?"),
			toolEvent(2, "start", "call-a"),
		];
		runState.status = "running";
		renderPanel();

		const group = await settledGroup();
		expect(group.textContent).toContain("Listing conversations");

		const dot = group.querySelector<HTMLElement>("[aria-hidden='true']");
		expect(dot?.className).toContain("animate-pulse");
		expect(dot?.getAttribute("style")).toContain("running-dot");
	});

	it("renders exactly one live indicator, in the timeline, after the newest message", async () => {
		runState.events = FINISHED_TURN_THEN_NEW_QUESTION;
		runState.status = "running";
		renderPanel();

		const indicator = await screen.findByTestId("agentic-run-indicator");
		// "completely remove the one below": one indicator, not two.
		expect(screen.getAllByTestId("agentic-run-indicator")).toHaveLength(1);
		expect(screen.getAllByTestId("chat-stop-button")).toHaveLength(1);

		// A timeline node, not a floating pill: same parent as the tool group, so
		// it sits in the scrolling thread rather than beside the composer.
		const group = await settledGroup();
		expect(indicator.parentElement).toBe(group.parentElement?.parentElement);

		// And last, after the newest user message.
		const messages = screen.getAllByTestId("chat-message-user");
		const newestUserMessage = messages[messages.length - 1];
		expect(
			newestUserMessage.compareDocumentPosition(indicator) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(indicator.parentElement?.lastElementChild).toBe(indicator);
	});

	it("says what the current step is, and stays present tense between steps", async () => {
		runState.events = [
			messageEvent(1, "user", "what came up in the interviews?"),
			toolEvent(2, "start", "call-a"),
		];
		runState.status = "running";
		const running = renderPanel();

		const indicator = await screen.findByTestId("agentic-run-indicator");
		expect(indicator.textContent).toContain("Listing conversations");
		running.unmount();

		// Step closed, model now writing: no tool is running, and the honest line
		// is the general one rather than a count of what is already done.
		runState.events = FINISHED_TURN_THEN_NEW_QUESTION;
		renderPanel();
		const betweenSteps = await screen.findByTestId("agentic-run-indicator");
		expect(betweenSteps.textContent).toContain("Working on your answer...");
	});

	it("carries the cancel button, and cancelling stops the run", async () => {
		runState.events = FINISHED_TURN_THEN_NEW_QUESTION;
		runState.status = "running";
		renderPanel();

		const indicator = await screen.findByTestId("agentic-run-indicator");
		const cancel = screen.getByTestId("chat-stop-button");
		expect(indicator.contains(cancel)).toBe(true);
		expect(cancel.textContent).toContain("Cancel");

		// The panel arms the control on pointer down and only then honours a
		// click, so a stray click cannot kill a run.
		fireEvent.pointerDown(cancel);
		fireEvent.click(cancel);
		await waitFor(() => {
			expect(stopAgenticRunMock).toHaveBeenCalledWith(RUN_ID);
		});
	});

	it("removes the indicator when the run reaches a terminal state", async () => {
		runState.events = FINISHED_TURN;
		runState.status = "completed";
		renderPanel();

		const group = await settledGroup();
		expect(group.textContent).toContain("Worked through 3 steps");
		expect(screen.queryByTestId("agentic-run-indicator")).toBeNull();
		expect(screen.queryByTestId("chat-stop-button")).toBeNull();
	});
});
