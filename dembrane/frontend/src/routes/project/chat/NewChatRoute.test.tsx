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
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const {
	attach,
	createChat,
	fetchMock,
	initializeMode,
	navigate,
	project,
	toastError,
} = vi.hoisted(() => ({
	attach: vi.fn(async (_vars: unknown) => ({})),
	createChat: vi.fn(async (_vars?: unknown): Promise<{ id: string }> => {
		throw new Error("stop here");
	}),
	fetchMock: vi.fn(),
	initializeMode: vi.fn(async (_vars: unknown) => ({})),
	navigate: vi.fn(),
	project: { isSample: false, loaded: true },
	toastError: vi.fn(),
}));

vi.mock("@/components/chat/hooks", () => ({
	useDeleteChatMutation: () => ({ mutate: vi.fn() }),
	useInfiniteProjectChats: () => ({
		data: { pages: [] },
		fetchNextPage: vi.fn(),
		hasNextPage: false,
		isFetchingNextPage: false,
	}),
	useInitializeChatModeMutation: () => ({
		isPending: false,
		mutateAsync: initializeMode,
	}),
	usePrefetchSuggestions: () => vi.fn(),
	useProjectChatContext: () => ({ data: { conversations: [] } }),
	useProjectChatSearch: () => ({ data: undefined }),
	useProjectChatsCount: () => ({ data: 0 }),
}));

vi.mock("@/components/project/hooks", () => ({
	useAttachChatConversationsMutation: () => ({
		isPending: false,
		mutateAsync: attach,
	}),
	useCreateChatMutation: () => ({ isPending: false, mutateAsync: createChat }),
	useProjectById: () =>
		project.loaded
			? { data: { id: "proj-1", is_sample: project.isSample }, isSuccess: true }
			: { data: undefined, isSuccess: false },
}));

vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		aiAction,
		opened,
		resetsAt,
		wallKey,
	}: {
		aiAction?: string;
		opened: boolean;
		resetsAt?: string | null;
		wallKey: string;
	}) =>
		opened ? (
			<div
				data-testid="upgrade-modal"
				data-wall={wallKey}
				data-action={aiAction}
				data-resets={resetsAt ?? ""}
			/>
		) : null,
}));
vi.mock("@/components/chat/ChatTemplatesMenuConnected", () => ({
	ChatTemplatesMenuConnected: () => null,
}));
vi.mock("@/components/chat/AgenticIntroModal", () => ({
	AgenticIntroModal: () => null,
}));
vi.mock("@/components/conversation/ProjectConversationsPanel", () => ({
	ProjectConversationsPanel: () => null,
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "ws-1", role: "admin", tier: "free" },
	}),
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ iso639_1: "en", language: "en-US" }),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/components/common/Toaster", () => ({
	toast: Object.assign(vi.fn(), { error: toastError }),
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

import { NewChatRoute } from "./NewChatRoute";

const answer = (body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status: 200,
	});

const SPENT = {
	ai: { exhausted: true, percent_used: 100, unlimited: false },
	audio_seconds: { limit: 18000, used: 0 },
	free: true,
	period_start: "2026-10-01T00:00:00Z",
	projects: { limit: 1, used: 1 },
	resets_at: "2026-11-01T00:00:00Z",
};

const ROOM = {
	...SPENT,
	ai: { exhausted: false, percent_used: 40, unlimited: false },
};

const aiRefusal = {
	response: {
		data: {
			code: "billing.tier_limit",
			detail: {
				error: "FREE_TIER_LIMIT",
				limit: "ai_budget",
				percent: 100,
				resets_at: "2026-12-01T00:00:00Z",
			},
			params: { limit: "ai_budget" },
		},
		status: 402,
	},
};

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
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
	window.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	} as unknown as typeof ResizeObserver;
	window.IntersectionObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
		takeRecords() {
			return [];
		}
	} as unknown as typeof IntersectionObserver;
	vi.stubGlobal("fetch", fetchMock);
});

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () => answer(SPENT));
	createChat.mockReset();
	createChat.mockImplementation(async () => {
		throw new Error("stop here");
	});
	attach.mockClear();
	initializeMode.mockClear();
	navigate.mockClear();
	toastError.mockClear();
	project.isSample = false;
	project.loaded = true;
});

afterEach(() => cleanup());

type Entry = string | { pathname: string; search?: string; state?: unknown };
const renderRoute = async (
	entry: Entry = "/w/ws-1/projects/proj-1/chats/new",
) => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter initialEntries={[entry]}>
						<Routes>
							<Route
								path="/w/:workspaceId/projects/:projectId/chats/new"
								element={<NewChatRoute />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	await waitFor(() =>
		expect(
			client.getQueryState(["workspace", "ws-1", "free-allowance"])?.status,
		).toBe("success"),
	);
};

const send = async () => {
	fireEvent.change(screen.getByTestId("ask-home-input"), {
		target: { value: "what came up?" },
	});
	await act(async () => {
		fireEvent.click(screen.getByTestId("ask-home-send-button"));
	});
};

it("opens the AI wall instead of a new chat once this month's AI is used up", async () => {
	await renderRoute();
	expect(screen.getByTestId("free-allowance-banner")).toBeTruthy();
	await send();
	expect(createChat).not.toHaveBeenCalled();
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("ai_budget");
	expect(modal.dataset.action).toBe("chat");
	expect(modal.dataset.resets).toBe("2026-11-01T00:00:00Z");
});

it("opens the AI wall when the server refuses the new chat", async () => {
	fetchMock.mockImplementation(async () => answer(ROOM));
	createChat.mockRejectedValueOnce(aiRefusal);
	await renderRoute();
	await send();
	expect(createChat).toHaveBeenCalledTimes(1);
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("ai_budget");
	expect(modal.dataset.action).toBe("chat");
	expect(modal.dataset.resets).toBe("2026-12-01T00:00:00Z");
});

it("lets a sample project start a chat when this month's AI is used up", async () => {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	project.isSample = true;
	await renderRoute();
	expect(screen.queryByTestId("free-allowance-banner")).toBeNull();
	await send();
	expect(createChat).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	// The mocked createChat throws to end the test; the route logs it.
	expect(consoleError).toHaveBeenCalledWith(
		"Failed to create chat with mode:",
		expect.any(Error),
	);
	consoleError.mockRestore();
});

it("walls nothing while is_sample is still loading", async () => {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	project.loaded = false;
	await renderRoute();
	expect(screen.queryByTestId("free-allowance-banner")).toBeNull();
	await send();
	expect(createChat).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	// The mocked createChat throws to end the test; the route logs it.
	expect(consoleError).toHaveBeenCalledWith(
		"Failed to create chat with mode:",
		expect.any(Error),
	);
	consoleError.mockRestore();
});

// Arriving with the choice made (router state), or with a question in the
// address, and opening the conversation picker.
const NEW = "/w/ws-1/projects/proj-1/chats/new";

it("starts the chat on arrival in the mode handed over", async () => {
	fetchMock.mockImplementation(async () => answer(ROOM));
	createChat.mockResolvedValue({ id: "chat-1" });
	await renderRoute({ pathname: NEW, state: { preferMode: "deep_dive" } });
	await waitFor(() =>
		expect(navigate).toHaveBeenCalledWith(
			"/w/ws-1/projects/proj-1/chats/chat-1",
			{ state: undefined },
		),
	);
	expect(createChat).toHaveBeenCalledTimes(1);
	expect(initializeMode).toHaveBeenCalledWith({
		chatId: "chat-1",
		mode: "deep_dive",
		projectId: "proj-1",
	});
});

it("starts the chat on arrival with a seed question, and hands it on", async () => {
	fetchMock.mockImplementation(async () => answer(ROOM));
	createChat.mockResolvedValue({ id: "chat-2" });
	await renderRoute({
		pathname: NEW,
		state: { initialMessage: "what came up?" },
	});
	await waitFor(() =>
		expect(navigate).toHaveBeenCalledWith(
			"/w/ws-1/projects/proj-1/chats/chat-2",
			{ state: { initialMessage: "what came up?" } },
		),
	);
	expect(createChat).toHaveBeenCalledTimes(1);
});

it("puts a question from the address in the box, and takes it out of the address", async () => {
	fetchMock.mockImplementation(async () => answer(ROOM));
	await renderRoute({ pathname: NEW, search: "?prefill=Tell%20me%20more&x=1" });
	expect(
		(screen.getByTestId("ask-home-input") as HTMLTextAreaElement).value,
	).toBe("Tell me more");
	expect(window.location.search).toBe("?x=1");
	expect(createChat).not.toHaveBeenCalled();
});

it("opens the picker on a draft chat, made once", async () => {
	fetchMock.mockImplementation(async () => answer(ROOM));
	createChat.mockResolvedValue({ id: "draft-1" });
	await renderRoute();
	await act(async () => {
		fireEvent.click(screen.getByTestId("ask-home-choose-conversations"));
		fireEvent.click(screen.getByTestId("ask-home-choose-conversations"));
	});
	expect(
		await screen.findByRole("dialog", { name: "Select conversations" }),
	).toBeTruthy();
	expect(createChat).toHaveBeenCalledTimes(1);
	expect(createChat).toHaveBeenCalledWith({
		navigateToNewChat: false,
		project_id: { id: "proj-1" },
		silent: true,
	});
});

it("says so when the picker's draft cannot be made, and lets the next try make it", async () => {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	fetchMock.mockImplementation(async () => answer(ROOM));
	createChat.mockResolvedValueOnce(undefined as unknown as { id: string });
	await renderRoute();
	await act(async () => {
		fireEvent.click(screen.getByTestId("ask-home-choose-conversations"));
	});
	expect(toastError).toHaveBeenCalledWith(
		"Could not open the conversation list. Try again.",
	);
	expect(
		screen.queryByRole("dialog", { name: "Select conversations" }),
	).toBeNull();

	createChat.mockResolvedValueOnce({ id: "draft-2" });
	await act(async () => {
		fireEvent.click(screen.getByTestId("ask-home-choose-conversations"));
	});
	expect(
		await screen.findByRole("dialog", { name: "Select conversations" }),
	).toBeTruthy();
	consoleError.mockRestore();
});

it("opens the picker anyway when only carrying over the selection failed", async () => {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	fetchMock.mockImplementation(async () => answer(ROOM));
	createChat.mockResolvedValue({ id: "draft-3" });
	attach.mockRejectedValueOnce(new Error("attach failed"));
	await renderRoute({
		pathname: NEW,
		state: { selectedConversationIds: ["c1"] },
	});
	await act(async () => {
		fireEvent.click(screen.getByTestId("ask-home-choose-conversations"));
	});
	expect(attach).toHaveBeenCalledWith({
		chatId: "draft-3",
		conversationIds: ["c1"],
		projectId: "proj-1",
	});
	expect(toastError).toHaveBeenCalledWith(
		"Could not carry over your selection. Pick again below.",
	);
	expect(
		await screen.findByRole("dialog", { name: "Select conversations" }),
	).toBeTruthy();
	consoleError.mockRestore();
});
