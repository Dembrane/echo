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
import type { NotificationRow } from "@/hooks/useNotifications";

const mocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	openSupportRequest: vi.fn(),
	rows: [] as import("@/hooks/useNotifications").NotificationRow[],
}));

vi.mock("@/components/announcement/hooks", () => ({
	useInfiniteAnnouncements: () => ({
		data: { pages: [] },
		fetchNextPage: vi.fn(),
		hasNextPage: false,
		isFetchingNextPage: false,
		isLoading: false,
	}),
	useMarkAllAsReadMutation: () => ({ isPending: false, mutate: vi.fn() }),
	useMarkAsReadMutation: () => ({ mutate: vi.fn() }),
	useMarkAsUnreadMutation: () => ({ mutate: vi.fn() }),
	useUnreadAnnouncements: () => ({ data: 0 }),
}));
vi.mock("@/hooks/useNotifications", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useNotifications")>()),
	useNotifications: () => ({
		data: mocks.rows,
		isLoading: false,
		isSuccess: true,
		status: "success",
	}),
	useUnreadNotificationCount: () => ({
		data: mocks.rows.filter((r) => !r.read).length,
	}),
}));
vi.mock("@/hooks/useI18nNavigate", () => ({
	useI18nNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ language: "en-US" }),
}));
vi.mock("@/hooks/useWorkspace", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useWorkspace")>()),
	useWorkspace: () => ({
		workspaces: [{ id: "ws-1", name: "Team", role: "admin" }],
	}),
}));
vi.mock("../hooks/usePendingActions", () => ({
	usePendingActionCount: () => 0,
	useTrainingPendingActions: () => [],
}));
vi.mock("../hooks/useSidebarView", () => ({
	useSidebarView: () => ({ backTo: "/o", params: {} }),
}));
vi.mock("react-intersection-observer", () => ({
	useInView: () => ({ inView: false, ref: () => {} }),
}));
vi.mock(
	"@/components/workspace/supportRequestPromptState",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/components/workspace/supportRequestPromptState")
		>()),
		openSupportRequest: mocks.openSupportRequest,
	}),
);

const { InboxView } = await import("./InboxView");

// The workspace's waiting requests, as the server answers them.
let pending: Record<string, { id: string }[]> = {};
let calls: { url: string; method: string }[] = [];

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	const method = (init?.method ?? "GET").toUpperCase();
	calls.push({ method, url });
	const list = url.match(
		/\/v2\/workspaces\/([^/]+)\/support-access\/requests\/?(?:\?.*)?$/,
	);
	if (list && method === "GET") {
		const now = new Date().toISOString();
		return json({
			requests: (pending[list[1]] ?? []).map((r) => ({
				created_at: now,
				expires_at: null,
				message: null,
				requested_by_name: "Sam Staff",
				...r,
			})),
		});
	}
	return json({ ok: true });
};

const requestNotice = (requestId: string): NotificationRow => ({
	action: "NAVIGATE_WORKSPACE_SETTINGS",
	actor_avatar: null,
	actor_name: null,
	actor_user_id: null,
	created_at: new Date(Date.now() - 3600_000).toISOString(),
	event_code: "SUPPORT_ACCESS_REQUESTED",
	expires_at: null,
	id: `n-${requestId}`,
	message: null,
	params: { request_id: requestId },
	read: false,
	refs: {
		chat_id: null,
		conversation_id: null,
		invite_id: null,
		org_id: "o-1",
		project_id: null,
		report_id: null,
		workspace_id: "ws-1",
	},
	scope: "Gemeente Utrecht › Team",
	severity: "action_required",
	title: "dembrane staff requested access to Team",
});

const renderInbox = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={["/en-US/w/ws-1/home?sidebar=inbox"]}>
						<InboxView />
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

const row = () =>
	screen.getByRole("button", {
		name: /dembrane staff requested access to Team/,
	});
const fetchedRequests = () =>
	calls.some(
		(c) =>
			c.method === "GET" &&
			c.url.includes("/v2/workspaces/ws-1/support-access/requests"),
	);
const settle = () => act(() => new Promise((r) => setTimeout(r, 100)));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	globalThis.ResizeObserver ||= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});

beforeEach(() => {
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockImplementation((media: string) => ({
			addEventListener: vi.fn(),
			addListener: vi.fn(),
			dispatchEvent: vi.fn(),
			matches: false,
			media,
			onchange: null,
			removeEventListener: vi.fn(),
			removeListener: vi.fn(),
		})),
	);
	pending = {};
	calls = [];
	vi.stubGlobal("fetch", vi.fn(fakeFetch));
	mocks.navigate.mockReset();
	mocks.openSupportRequest.mockReset();
	mocks.rows = [];
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("clicking a support access request in the inbox", () => {
	it("opens the consent dialog for that request while it still waits, and stays where it is", async () => {
		pending["ws-1"] = [{ id: "r-waiting" }];
		mocks.rows = [requestNotice("r-waiting")];
		renderInbox();
		await waitFor(() => expect(fetchedRequests()).toBe(true));
		await settle();
		fireEvent.click(row());
		await waitFor(() =>
			expect(mocks.openSupportRequest).toHaveBeenCalledWith("r-waiting"),
		);
		await settle();
		expect(mocks.navigate).not.toHaveBeenCalled();
		// Marked read on click, as every row is.
		expect(
			calls.some(
				(c) =>
					c.method === "POST" &&
					c.url.endsWith("/v2/me/notifications/n-r-waiting/read"),
			),
		).toBe(true);
	});

	it("goes to Access history in workspace settings once the request no longer waits", async () => {
		pending["ws-1"] = [];
		mocks.rows = [requestNotice("r-answered")];
		renderInbox();
		await settle();
		fireEvent.click(row());
		await waitFor(() =>
			expect(mocks.navigate).toHaveBeenCalledWith(
				"/w/ws-1/settings/general#support-access-requests",
			),
		);
		expect(mocks.openSupportRequest).not.toHaveBeenCalled();
	});

	it("leaves every other notification's click as it is", async () => {
		mocks.rows = [
			{
				...requestNotice("r-x"),
				action: "NAVIGATE_WS",
				event_code: "MEMBERSHIP_APPROVED",
				id: "n-other",
				params: null,
				title: "You joined Team",
			},
		];
		renderInbox();
		await settle();
		fireEvent.click(screen.getByRole("button", { name: /You joined Team/ }));
		await waitFor(() =>
			expect(mocks.navigate).toHaveBeenCalledWith("/w/ws-1/home"),
		);
		expect(mocks.openSupportRequest).not.toHaveBeenCalled();
	});
});
