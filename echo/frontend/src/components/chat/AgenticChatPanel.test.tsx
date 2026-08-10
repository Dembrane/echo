// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
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
const {
	createAgenticRunMock,
	runState,
	stopAgenticRunMock,
	streamOptionsRef,
	transcribeMock,
	usageState,
} = vi.hoisted(() => ({
	createAgenticRunMock: vi.fn(),
	runState: { events: [], status: "running" } as {
		events: AgenticRunEvent[];
		status: AgenticRunStatus;
	},
	stopAgenticRunMock: vi.fn(async () => ({
		run_id: "run-1",
		status: "stopping" as const,
		turn_seq: 1,
	})),
	// The live stream's callbacks, captured so tests can drive draft
	// snapshots and durable events into the panel by hand.
	streamOptionsRef: {
		current: null as null | {
			onEvent: (event: AgenticRunEvent) => void;
			onDraft?: (draft: { message_id: string; text: string }) => void;
		},
	},
	transcribeMock: vi.fn(async () => ({
		note: "",
		transcript: "what I said out loud",
	})),
	// Mutable so a test can put the workspace over its recording cap.
	usageState: { uploadsLocked: false },
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		appendAgenticRunMessage: vi.fn(),
		createAgentInsight: vi.fn(),
		createAgenticRun: createAgenticRunMock,
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
		transcribeStateless: transcribeMock,
		// Never resolves: an in-flight run is one whose stream is still open, and
		// resolving would let the panel re-read the status and settle.
		streamAgenticRun: vi.fn(
			(...args: Parameters<typeof actual.streamAgenticRun>) => {
				streamOptionsRef.current =
					args[1] as unknown as typeof streamOptionsRef.current;
				return new Promise(() => {});
			},
		),
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

vi.mock("@/components/project/hooks", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/components/project/hooks")>();
	return {
		...actual,
		// The composer reads one field off the project for transcription hints.
		useProjectById: () => ({
			data: { default_conversation_transcript_prompt: "dembrane, Eindhoven" },
		}),
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
	return {
		...actual,
		useWorkspaceUsage: () => ({
			freeTier: null,
			usageGates: {
				over_cap_active: usageState.uploadsLocked,
				upgrade_cta_tier: "changemaker",
				uploads_locked: usageState.uploadsLocked,
			},
		}),
	};
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

import { AgenticChatPanel, enrichAgenticContent } from "./AgenticChatPanel";

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
	streamOptionsRef.current = null;
	createAgenticRunMock.mockClear();
	transcribeMock.mockClear();
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

describe("AgenticChatPanel, live draft streaming", () => {
	it("renders a growing draft bubble and swaps it for the durable message", async () => {
		runState.status = "running";
		runState.events = [messageEvent(1, "user", "hello")];

		renderPanel();

		await waitFor(() => expect(streamOptionsRef.current).not.toBeNull());

		// First snapshot appears as an assistant bubble.
		act(() => {
			streamOptionsRef.current?.onDraft?.({
				message_id: "m-1",
				text: "Working through",
			});
		});
		expect(await screen.findByText(/Working through/)).toBeTruthy();

		// A later snapshot replaces the bubble's text, it does not append one.
		act(() => {
			streamOptionsRef.current?.onDraft?.({
				message_id: "m-1",
				text: "Working through the transcripts now.",
			});
		});
		expect(
			await screen.findByText(/Working through the transcripts now\./),
		).toBeTruthy();
		expect(screen.queryAllByText(/Working through/)).toHaveLength(1);

		// The durable copy replaces the draft: same text, exactly one bubble.
		act(() => {
			streamOptionsRef.current?.onEvent({
				event_type: "assistant.message",
				id: 2,
				payload: {
					content: "Working through the transcripts now.",
					message_id: "m-1",
				},
				project_agentic_run_id: RUN_ID,
				seq: 2,
				timestamp: at(2),
			});
		});
		await waitFor(() =>
			expect(
				screen.queryAllByText(/Working through the transcripts now\./),
			).toHaveLength(1),
		);
	});
});

/** jsdom has no microphone. The smallest recorder that behaves like the real
 * one where the composer depends on it: one blob, produced at stop. */
class FakeMediaRecorder {
	static isTypeSupported = () => true;
	state: "inactive" | "recording" = "inactive";
	mimeType = "audio/webm";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		this.ondataavailable?.({
			data: new Blob([new Uint8Array(2048)], { type: this.mimeType }),
		});
		this.onstop?.();
	}
}

describe("AgenticChatPanel, voice input", () => {
	let clock = 0;

	beforeEach(() => {
		clock = 0;
		usageState.uploadsLocked = false;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(globalThis.navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => ({
					getTracks: () => [{ stop: vi.fn() }],
				})),
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const startRecording = async () => {
		const mic = await screen.findByTestId("chat-voice-record-button");
		await act(async () => {
			fireEvent.click(mic);
		});
	};

	it("closes the text input while the microphone is open", async () => {
		runState.status = "completed";
		renderPanel();

		expect(await screen.findByTestId("chat-input-textarea")).toBeTruthy();
		await startRecording();

		// Closed, not merely disabled: the textarea is gone and the bar is in its
		// place, so there is one way in at a time.
		await waitFor(() => {
			expect(screen.queryByTestId("chat-input-textarea")).toBeNull();
		});
		expect(screen.getByTestId("chat-voice-recording-bar")).toBeTruthy();
		expect(screen.getByTestId("chat-voice-stop-button")).toBeTruthy();
		expect(screen.queryByTestId("chat-send-button")).toBeNull();
	});

	it("puts the transcript in the composer rather than sending it", async () => {
		runState.status = "completed";
		renderPanel();
		await startRecording();

		clock = 4000;
		await act(async () => {
			fireEvent.click(screen.getByTestId("chat-voice-stop-button"));
		});

		const textarea = (await screen.findByTestId(
			"chat-input-textarea",
		)) as HTMLTextAreaElement;
		await waitFor(() => {
			expect(textarea.value).toBe("what I said out loud");
		});
		// A mishearing the host cannot see is worse than one they can fix, so
		// nothing was sent.
		expect(createAgenticRunMock).not.toHaveBeenCalled();
	});

	it("bills the transcription to the project and carries its key terms", async () => {
		runState.status = "completed";
		renderPanel();
		await startRecording();

		clock = 4000;
		await act(async () => {
			fireEvent.click(screen.getByTestId("chat-voice-stop-button"));
		});

		await waitFor(() => {
			expect(transcribeMock).toHaveBeenCalled();
		});
		const call = (
			transcribeMock.mock.calls[0] as unknown as [
				{ hotwords?: string; language?: string; projectId: string },
			]
		)[0];
		expect(call.projectId).toBe("project-1");
		expect(call.language).toBe("en");
		expect(call.hotwords).toBe("dembrane, Eindhoven");
	});

	it("gives the composer back and sends nothing when the host cancels", async () => {
		runState.status = "completed";
		renderPanel();
		await startRecording();

		clock = 4000;
		await act(async () => {
			fireEvent.click(screen.getByTestId("chat-voice-cancel-button"));
		});

		expect(await screen.findByTestId("chat-input-textarea")).toBeTruthy();
		expect(transcribeMock).not.toHaveBeenCalled();
	});

	it("refuses to record past the recording cap and offers the upgrade instead", async () => {
		usageState.uploadsLocked = true;
		runState.status = "completed";
		renderPanel();

		const mic = await screen.findByTestId("chat-voice-record-button");
		expect(mic.hasAttribute("data-disabled")).toBe(true);
		await act(async () => {
			fireEvent.click(mic);
		});

		// Up front: the mic never opens, so nothing is recorded that cannot be sent.
		expect(
			globalThis.navigator.mediaDevices.getUserMedia,
		).not.toHaveBeenCalled();
		expect(screen.queryByTestId("chat-voice-recording-bar")).toBeNull();
		expect(transcribeMock).not.toHaveBeenCalled();
		// The dead-looking button still has somewhere to send the host.
		expect(await screen.findByText(/Recording limit reached/)).toBeTruthy();
	});

	it("says the microphone is blocked rather than failing quietly", async () => {
		Object.defineProperty(globalThis.navigator, "mediaDevices", {
			configurable: true,
			value: {
				getUserMedia: vi.fn(async () => {
					throw new DOMException("no", "NotAllowedError");
				}),
			},
		});
		runState.status = "completed";
		renderPanel();
		await startRecording();

		const alert = await screen.findByTestId("chat-voice-error");
		expect(alert.textContent).toContain("blocking the microphone");
		// A denial leaves the composer exactly as it was.
		expect(screen.getByTestId("chat-input-textarea")).toBeTruthy();
	});
});

describe("enrichAgenticContent, footnote citations", () => {
	const CONVERSATION_ID = "0aa78d5a-1111-2222-3333-444455556666";

	const enrich = (content: string) =>
		enrichAgenticContent({
			content,
			conversationNames: new Map([[CONVERSATION_ID, "Maria"]]),
			language: "en-US",
			projectId: "project-1",
			workspaceId: "workspace-1",
		});

	it("turns footnote definition tags into rich transcript links", () => {
		const enriched = enrich(
			`Parking came up often[^1].\n\n[^1]: [conversation_id:${CONVERSATION_ID};chunk_id:chunk-9]`,
		);

		expect(enriched).toContain("[^1]: [Maria's transcript excerpt](");
		expect(enriched).toContain("#chunk-chunk-9");
		expect(enriched).not.toContain("conversation_id:");
	});

	// The markdown renderer moves footnote definitions into its own trailing
	// section with its own localised header, so a model-written header would
	// stay behind as an empty duplicate above it. "*Sources*" is verbatim what
	// production stored (chat 57493241, 2026-08-10); the rest are the forms
	// the prompt's wording could plausibly produce.
	it.each([
		"*Sources*",
		"## Sources",
		"**Sources**",
		"Sources:",
		"### Footnotes",
	])(
		"strips a redundant %s header above the footnote definitions",
		(header) => {
			const enriched = enrich(
				`Parking came up often[^1].\n\n${header}\n\n[^1]: [conversation_id:${CONVERSATION_ID}]`,
			);

			expect(enriched).not.toMatch(/sources|footnotes/i);
			// The definition keeps a blank line above it: a footnote definition
			// cannot interrupt a paragraph, so gluing would demote it to text.
			expect(enriched).toContain("\n\n[^1]: [Maria's conversation](");
		},
	);

	it("strips the header even when the model skips the blank line under it", () => {
		const enriched = enrich(
			`Parking came up often[^1].\n## Sources\n[^1]: [conversation_id:${CONVERSATION_ID}]`,
		);

		expect(enriched).not.toContain("Sources");
		expect(enriched).toContain("\n\n[^1]: [Maria's conversation](");
	});

	it("leaves a Sources heading alone when no footnote definitions follow", () => {
		const content = "## Sources\n\nWe drew on three interviews.";

		expect(enrich(content)).toBe(content);
	});
});
