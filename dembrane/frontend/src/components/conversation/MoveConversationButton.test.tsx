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
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MoveConversationButton } from "./MoveConversationButton";

const role = vi.hoisted(() => ({ current: "owner" }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("react-intersection-observer", () => ({
	useInView: () => ({ inView: false, ref: () => {} }),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: role.current, tier: "free" },
		workspaceId: "w1",
		workspaces: [
			{ id: "w1", name: "Home WS" },
			{ id: "w2", name: "Other WS" },
		],
	}),
}));
vi.mock("./hooks", () => ({
	useMoveConversationMutation: () => ({
		isPending: false,
		mutate: (_v: unknown, opts?: { onSuccess?: () => void }) =>
			opts?.onSuccess?.(),
	}),
}));

i18n.load("en-US", {});
i18n.activate("en-US");

const fetchMock = vi.fn(async (_url: string) => ({
	json: async () => [
		{ id: "p1", name: "Alpha", workspace_id: "w1" },
		{ id: "p2", name: "Beta", workspace_id: "w1" },
		{ id: "p3", name: "Gamma", workspace_id: "w2" },
	],
	ok: true,
}));

beforeAll(() => {
	vi.stubGlobal("fetch", fetchMock);
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
	window.ResizeObserver =
		window.ResizeObserver ||
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
});

afterEach(() => {
	cleanup();
	fetchMock.mockClear();
	navigate.mockClear();
	role.current = "owner";
});

const renderButton = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={["/w/w1/projects/p1/conversations/c1"]}>
						<Routes>
							<Route
								path="/w/:workspaceId/projects/:projectId/conversations/:conversationId"
								element={
									<MoveConversationButton
										conversation={
											{ id: "c1", project_id: "p1" } as Conversation
										}
									/>
								}
							/>
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

const requested = () =>
	fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://x"));

describe("MoveConversationButton", () => {
	it("lists the other projects of every reachable workspace, naming foreign ones", async () => {
		renderButton();
		fireEvent.click(screen.getByTestId("conversation-move-button"));
		await screen.findByTestId("conversation-move-project-radio-p3");
		expect(
			screen.queryByTestId("conversation-move-project-radio-p1"),
		).toBeNull();
		expect(requested()[0]?.searchParams.has("workspace_id")).toBe(false);
		expect(screen.getByText("Other WS")).toBeTruthy();
		expect(screen.queryByText("Home WS")).toBeNull();
	});

	it("opens the moved conversation in the target project's workspace", async () => {
		renderButton();
		fireEvent.click(screen.getByTestId("conversation-move-button"));
		fireEvent.click(
			await screen.findByTestId("conversation-move-project-radio-p3"),
		);
		fireEvent.click(screen.getByTestId("conversation-move-submit-button"));
		await waitFor(() =>
			expect(navigate).toHaveBeenCalledWith(
				"/w/w2/projects/p3/conversations/c1",
			),
		);
	});

	it("sends the search to the API", async () => {
		renderButton();
		fireEvent.click(screen.getByTestId("conversation-move-button"));
		fireEvent.change(
			await screen.findByTestId("conversation-move-search-input"),
			{ target: { value: "bet" } },
		);
		await waitFor(() =>
			expect(
				requested().some((u) => u.searchParams.get("search") === "bet"),
			).toBe(true),
		);
	});

	it("is hidden from read-only roles", () => {
		role.current = "observer";
		renderButton();
		expect(screen.queryByTestId("conversation-move-button")).toBeNull();
	});
});
