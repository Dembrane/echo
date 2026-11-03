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

const { createChat, fetchMock, project } = vi.hoisted(() => ({
	createChat: vi.fn(async () => {
		throw new Error("stop here");
	}),
	fetchMock: vi.fn(),
	project: { isSample: false, loaded: true },
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
		mutateAsync: vi.fn(),
	}),
	usePrefetchSuggestions: () => vi.fn(),
	useProjectChatContext: () => ({ data: { conversations: [] } }),
	useProjectChatSearch: () => ({ data: undefined }),
	useProjectChatsCount: () => ({ data: 0 }),
}));

vi.mock("@/components/project/hooks", () => ({
	useAttachChatConversationsMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
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
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
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
	createChat.mockClear();
	project.isSample = false;
	project.loaded = true;
});

afterEach(() => cleanup());

const renderRoute = async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter initialEntries={["/w/ws-1/projects/proj-1/chats/new"]}>
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
	project.isSample = true;
	await renderRoute();
	expect(screen.queryByTestId("free-allowance-banner")).toBeNull();
	await send();
	expect(createChat).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("walls nothing while is_sample is still loading", async () => {
	project.loaded = false;
	await renderRoute();
	expect(screen.queryByTestId("free-allowance-banner")).toBeNull();
	await send();
	expect(createChat).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});
