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
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

// A Specific Details chat: what it adds to the next turn, sending a turn
// (lock, refresh, submit), the server's history taking over, a question in
// the address, and a template that lets go once the box is emptied.
type Message = { id: string; role: string; content: string };
const s = vi.hoisted(() => ({
	context: null as null | {
		chat_mode: string | null;
		conversations: { conversation_id: string; locked: boolean }[];
		locked_conversation_id_list?: string[];
		messages?: unknown[];
	},
	history: [] as { id: string; role: string; content: string }[],
	loading: false,
	lock: vi.fn(async (_vars: unknown) => ({})),
	refetchContext: vi.fn(async () => ({})),
	refetchHistory: vi.fn(async (_opts?: unknown) => ({ data: [] as unknown })),
	submit: vi.fn(),
	track: vi.fn(),
}));

vi.mock("@ai-sdk/react", () => ({
	useChat: ({ initialMessages }: { initialMessages: Message[] }) => {
		const [messages, setMessages] = useState<Message[]>(initialMessages);
		const [input, setInput] = useState("");
		return {
			data: undefined,
			error: undefined,
			handleInputChange: (e: { target: { value: string } }) =>
				setInput(e.target.value),
			handleSubmit: s.submit,
			input,
			isLoading: s.loading,
			messages,
			reload: vi.fn(),
			setInput,
			setMessages,
			status: "ready",
			stop: vi.fn(),
		};
	},
}));
vi.mock("@/components/chat/hooks", async (original) => ({
	...(await original<object>()),
	useAddChatMessageMutation: () => ({ mutate: vi.fn() }),
	useChat: () => ({ data: { id: "c1", name: "Chat" }, isLoading: false }),
	useChatHistory: () => ({
		data: s.history,
		isLoading: false,
		refetch: s.refetchHistory,
	}),
	useInitializeChatModeMutation: () => ({ mutateAsync: vi.fn() }),
	useLockConversationsMutation: () => ({ mutateAsync: s.lock }),
	usePrefetchSuggestions: () => vi.fn(),
	useProjectChatContext: () => ({
		data: s.context,
		isLoading: false,
		refetch: s.refetchContext,
	}),
}));
vi.mock("@/components/conversation/hooks", async (original) => ({
	...(await original<object>()),
	useClearChatContextMutation: () => ({ mutate: vi.fn() }),
	useConversationsCountByProjectId: () => ({ data: 0 }),
}));
vi.mock("@/components/feedback/hooks", () => ({
	isPersistedMessageId: () => false,
	useResponseFeedback: () => ({ data: undefined }),
}));
vi.mock("@/components/project/hooks", () => ({
	useProjectById: () => ({ data: { id: "p1", workspace_id: "w1" } }),
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspace: { id: "w1", role: "admin" } }),
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ iso639_1: "en", language: "en-US" }),
}));
vi.mock("@/lib/analytics/events", () => ({ track: s.track }));
vi.mock("@/components/chat/ChatTemplatesMenuConnected", () => ({
	ChatTemplatesMenuConnected: ({
		onTemplateSelect,
	}: {
		onTemplateSelect: (t: { content: string; key: string }) => void;
	}) => (
		<button
			type="button"
			onClick={() => onTemplateSelect({ content: "Summarise", key: "summary" })}
		>
			Use template
		</button>
	),
}));
vi.mock("@/components/conversation/ProjectConversationsPanel", () => ({
	ProjectConversationsPanel: () => null,
}));
vi.mock("@/components/chat/AgenticChatPanel", () => ({
	AgenticChatPanel: () => null,
}));

import { ProjectChatRoute, useDembraneChat } from "./ProjectChatRoute";

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	window.IntersectionObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
		takeRecords() {
			return [];
		}
	} as unknown as typeof IntersectionObserver;
	Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
	s.context = {
		chat_mode: "deep_dive",
		conversations: [
			{ conversation_id: "a", locked: true },
			{ conversation_id: "b", locked: false },
		],
		locked_conversation_id_list: ["a"],
		messages: [],
	};
	s.history = [];
	s.loading = false;
	s.lock.mockReset();
	s.lock.mockResolvedValue({});
	s.refetchHistory.mockReset();
	s.refetchHistory.mockResolvedValue({ data: [] });
	s.refetchContext.mockClear();
	s.submit.mockClear();
	s.track.mockClear();
});
afterEach(cleanup);

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>
		<MemoryRouter initialEntries={["/w/w1/projects/p1/chats/c1"]}>
			<Routes>
				<Route
					path="/w/:workspaceId/projects/:projectId/chats/:chatId"
					element={children}
				/>
			</Routes>
		</MemoryRouter>
	</QueryClientProvider>
);
const useChatHook = () =>
	renderHook(() => useDembraneChat({ chatId: "c1" }), { wrapper });

it("adds the conversations not yet locked to the next turn, and nothing without context", () => {
	const { result } = useChatHook();
	expect(result.current.contextToBeAdded).toEqual({
		conversations: [{ conversation_id: "b", locked: false }],
		locked_conversations: [{ conversation_id: "a", locked: true }],
	});
	cleanup();
	s.context = null;
	expect(useChatHook().result.current.contextToBeAdded).toBeNull();
});

it("locks, refreshes and submits a turn, with the server's history", async () => {
	const fresh = [{ content: "hi", id: "m1", role: "user" }];
	s.refetchHistory.mockResolvedValue({ data: fresh });
	const { result } = useChatHook();
	await act(async () => {
		await result.current.handleSubmit();
	});
	expect(s.lock).toHaveBeenCalledWith({ chatId: "c1" });
	expect(s.refetchContext).toHaveBeenCalled();
	expect(s.refetchHistory).toHaveBeenCalledWith({ cancelRefetch: false });
	expect(result.current.messages).toEqual(fresh);
	expect(s.submit).toHaveBeenCalledTimes(1);
	expect(s.track).toHaveBeenCalledWith("chat_message_sent", {
		chat_id: "c1",
		project_id: "p1",
		template_key: null,
	});
	expect(result.current.isSubmitting).toBe(false);
});

it("sends nothing when locking fails, and is ready again", async () => {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	s.lock.mockRejectedValue(new Error("lock failed"));
	const { result } = useChatHook();
	await act(async () => {
		await result.current.handleSubmit();
	});
	expect(s.submit).not.toHaveBeenCalled();
	expect(result.current.isSubmitting).toBe(false);
	expect(consoleError).toHaveBeenCalledWith(
		"Error in customHandleSubmit:",
		expect.any(Error),
	);
	consoleError.mockRestore();
});

it("takes the server's history when it holds more than the chat", () => {
	const { result, rerender } = useChatHook();
	expect(result.current.messages).toEqual([]);
	s.history = [
		{ content: "q", id: "m1", role: "user" },
		{ content: "a", id: "m2", role: "assistant" },
	];
	rerender();
	expect(result.current.messages).toHaveLength(2);
});

it("keeps a streaming reply in view until it is done", () => {
	s.loading = true;
	const { result, rerender } = useChatHook();
	s.history = [{ content: "q", id: "m1", role: "user" }];
	rerender();
	expect(result.current.messages).toEqual([]);
	s.loading = false;
	rerender();
	expect(result.current.messages).toHaveLength(1);
});

const showRoute = (entry: string) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter initialEntries={[entry]}>
						<Routes>
							<Route
								path="/w/:workspaceId/projects/:projectId/chats/:chatId"
								element={<ProjectChatRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
const box = () =>
	screen.getByTestId("chat-input-textarea") as HTMLTextAreaElement;

it("puts a question from the address in the box, and takes it out of the address", () => {
	showRoute("/w/w1/projects/p1/chats/c1?prefill=What%20changed%3F&x=1");
	expect(box().value).toBe("What changed?");
	expect(window.location.search).toBe("?x=1");
});

it("lets go of a template once the box is emptied, even when typing again", async () => {
	showRoute("/w/w1/projects/p1/chats/c1");
	fireEvent.click(screen.getByRole("button", { name: "Use template" }));
	expect(box().value).toBe("Summarise");
	fireEvent.change(box(), { target: { value: "" } });
	fireEvent.change(box(), { target: { value: "My own question" } });
	await act(async () => {
		fireEvent.keyDown(box(), { key: "Enter" });
	});
	await waitFor(() =>
		expect(s.track).toHaveBeenCalledWith(
			"chat_message_sent",
			expect.objectContaining({ template_key: null }),
		),
	);
});

it("sends a template's key with the turn while the template is in the box", async () => {
	showRoute("/w/w1/projects/p1/chats/c1");
	fireEvent.click(screen.getByRole("button", { name: "Use template" }));
	await act(async () => {
		fireEvent.keyDown(box(), { key: "Enter" });
	});
	await waitFor(() =>
		expect(s.track).toHaveBeenCalledWith(
			"chat_message_sent",
			expect.objectContaining({ template_key: "summary" }),
		),
	);
});
