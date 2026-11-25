// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider, Modal } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
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

// The inbox's notifications, as the app already fetches them every minute: a small store
// the test sets like react-query would answer.
const notices = vi.hoisted(() => {
	let rows: import("@/hooks/useNotifications").NotificationRow[] = [];
	// Each set is a refetch: react-query moves dataUpdatedAt.
	let updatedAt = 1;
	const listeners = new Set<() => void>();
	return {
		get: () => rows,
		set: (next: typeof rows) => {
			rows = next;
			updatedAt += 1;
			for (const l of listeners) l();
		},
		subscribe: (l: () => void) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		updatedAt: () => updatedAt,
	};
});
const mocks = vi.hoisted(() => ({
	workspaces: [] as { id: string; name: string; role: string }[],
}));
const toast = vi.hoisted(() =>
	Object.assign(() => {}, {
		dismiss: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		message: vi.fn(),
		success: vi.fn(),
		warning: vi.fn(),
	}),
);

vi.mock("@/hooks/useNotifications", async (importOriginal) => {
	const { useSyncExternalStore } = await import("react");
	return {
		...(await importOriginal<typeof import("@/hooks/useNotifications")>()),
		useNotifications: () => {
			const data = useSyncExternalStore(notices.subscribe, notices.get);
			return {
				data,
				dataUpdatedAt: notices.updatedAt(),
				isError: false,
				isLoading: false,
				isPending: false,
				isSuccess: true,
				refetch: vi.fn(),
				status: "success",
			};
		},
	};
});
vi.mock("@/hooks/useWorkspace", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useWorkspace")>()),
	useWorkspace: () => ({
		clearWorkspace: () => {},
		isError: false,
		isLoading: false,
		refetch: () => {},
		setWorkspace: () => {},
		workspace: null,
		workspaceId: null,
		workspaceName: null,
		workspaces: mocks.workspaces,
	}),
}));
vi.mock("@/components/common/Toaster", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/common/Toaster")>()),
	toast,
}));

const { default: SupportAccessRequestPrompt } = await import(
	"./SupportAccessRequestPrompt"
);
const { openSupportRequest, resetSupportRequestSeen, requestSeen } =
	await import("./supportRequestPromptState");

// ── A small dembrane server: waiting requests per workspace, answered by approve or deny ──

type Pending = {
	id: string;
	requested_by_name: string;
	message: string | null;
	created_at: string | null;
	expires_at: string | null;
};

let server: {
	pending: Record<string, Pending[]>;
	forbidden: Set<string>;
	calls: { url: string; method: string }[];
	/** Answers fail before they reach dembrane, as when the connection drops. */
	offline?: boolean;
};

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
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	server.calls.push({ method, url });

	const list = url.match(
		/\/v2\/workspaces\/([^/]+)\/support-access\/requests\/?(?:\?.*)?$/,
	);
	if (list && method === "GET") {
		const ws = list[1];
		if (server.forbidden.has(ws)) return json({ detail: "Forbidden" }, 403);
		return json({ requests: server.pending[ws] ?? [] });
	}
	const answer = url.match(
		/\/v2\/workspaces\/([^/]+)\/support-access\/requests\/([^/]+)\/(approve|deny)$/,
	);
	if (answer && method === "POST") {
		if (server.offline) throw new TypeError("Failed to fetch");
		const [, ws, id] = answer;
		const before = server.pending[ws] ?? [];
		if (!before.some((r) => r.id === id)) {
			return json({ detail: "Request not found" }, 404);
		}
		server.pending[ws] = before.filter((r) => r.id !== id);
		return json({ ok: true });
	}
	if (/\/v2\/me\/notifications\/[^/]+\/read$/.test(url) && method === "POST") {
		return json({ ok: true });
	}
	return json([], 200);
};

const posts = () => server.calls.filter((c) => c.method === "POST");
const posted = (path: string) => posts().some((c) => c.url.endsWith(path));
const fetchedRequestsOf = (ws: string) =>
	server.calls.some(
		(c) =>
			c.method === "GET" &&
			c.url.includes(`/v2/workspaces/${ws}/support-access/requests`),
	);

// ── Fixtures ──

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const request = (over: Partial<Pending> = {}): Pending => ({
	created_at: hoursAgo(2),
	expires_at: new Date(NOW + 6 * 24 * 3600_000).toISOString(),
	id: "r-1",
	message: "We would like to check why your report does not load.",
	requested_by_name: "Sam Staff",
	...over,
});

const notice = (
	workspaceId: string,
	requestId: string,
	over: Partial<NotificationRow> = {},
): NotificationRow => ({
	action: "NAVIGATE_WORKSPACE_SETTINGS",
	actor_avatar: null,
	actor_name: null,
	actor_user_id: null,
	created_at: hoursAgo(2),
	event_code: "SUPPORT_ACCESS_REQUESTED",
	expires_at: null,
	id: `n-${requestId}`,
	message: null,
	params: { request_id: requestId, workspace_name: "Team" },
	read: false,
	refs: {
		chat_id: null,
		conversation_id: null,
		invite_id: null,
		org_id: "o-1",
		project_id: null,
		report_id: null,
		workspace_id: workspaceId,
	},
	scope: "Gemeente Utrecht › Team",
	severity: "action_required",
	title: "dembrane staff requested access to Team",
	...over,
});

const renderPrompt = (url = "/en-US/w/ws-1/home", other = false) => {
	const client = new QueryClient({
		defaultOptions: {
			mutations: { retry: false },
			queries: { retry: false },
		},
	});
	const tree = (otherOpen: boolean) => (
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={client}>
					<MemoryRouter initialEntries={[url]}>
						<SupportAccessRequestPrompt />
						{/* Another dialog of the app, open when the test says so. */}
						<Modal opened={otherOpen} onClose={() => {}} title="Rename project">
							Another dialog
						</Modal>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>
	);
	const view = render(tree(other));
	return { ...view, setOther: (open: boolean) => view.rerender(tree(open)) };
};

// By role: a closed Mantine modal can leave its empty root (and its test id) behind.
const dialog = () =>
	screen.queryByRole("dialog", { name: "Support access request" });
const findDialog = async () => {
	await waitFor(() => expect(dialog()).toBeTruthy());
	return screen.getByRole("dialog", { name: "Support access request" });
};
/** Lets the fetches the prompt starts on its own come back before asserting it stayed away. */
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
	// Mantine reads the colour scheme and breakpoints through matchMedia.
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
	server = { calls: [], forbidden: new Set(), pending: {} };
	vi.stubGlobal("fetch", vi.fn(fakeFetch));
	sessionStorage.clear();
	resetSupportRequestSeen();
	notices.set([]);
	mocks.workspaces = [
		{ id: "ws-1", name: "Team", role: "admin" },
		{ id: "ws-2", name: "Lab", role: "admin" },
	];
	toast.success.mockReset();
	toast.error.mockReset();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("a workspace admin with a waiting support access request", () => {
	it("sees the dialog with the staff member's name, the workspace and their note", async () => {
		server.pending["ws-1"] = [request({ id: "r-show" })];
		notices.set([notice("ws-1", "r-show")]);
		renderPrompt();
		const d = await findDialog();
		expect(d.textContent).toContain("Sam Staff");
		expect(d.textContent).toContain("Team");
		expect(d.textContent).toContain(
			"We would like to check why your report does not load.",
		);
		expect(
			within(d).getByRole("button", { name: "Approve for 24 hours" }),
		).toBeTruthy();
		expect(within(d).getByRole("button", { name: "Decline" })).toBeTruthy();
	});

	it("shows no note line when the staff member wrote none", async () => {
		server.pending["ws-1"] = [request({ id: "r-nonote", message: null })];
		notices.set([notice("ws-1", "r-nonote")]);
		renderPrompt();
		const d = await findDialog();
		expect(d.textContent).toContain("Sam Staff");
		expect(within(d).queryByText(/Their note/)).toBeNull();
	});

	it("sees nothing once another admin answered the request", async () => {
		server.pending["ws-1"] = [];
		notices.set([notice("ws-1", "r-answered")]);
		renderPrompt();
		await waitFor(() => expect(fetchedRequestsOf("ws-1")).toBe(true));
		await settle();
		expect(dialog()).toBeNull();
	});

	it("sees nothing when the workspace no longer lets them see its requests", async () => {
		server.forbidden.add("ws-1");
		server.pending["ws-1"] = [request({ id: "r-403" })];
		notices.set([notice("ws-1", "r-403")]);
		renderPrompt();
		await waitFor(() => expect(fetchedRequestsOf("ws-1")).toBe(true));
		await settle();
		expect(dialog()).toBeNull();
	});

	it("approving gives access for 24 hours, marks the notification read and the dialog goes", async () => {
		server.pending["ws-1"] = [request({ id: "r-approve" })];
		notices.set([notice("ws-1", "r-approve")]);
		renderPrompt();
		const d = await findDialog();
		fireEvent.click(
			within(d).getByRole("button", { name: "Approve for 24 hours" }),
		);
		await waitFor(() =>
			expect(
				posted("/v2/workspaces/ws-1/support-access/requests/r-approve/approve"),
			).toBe(true),
		);
		await waitFor(() =>
			expect(posted("/v2/me/notifications/n-r-approve/read")).toBe(true),
		);
		await waitFor(() =>
			expect(toast.success.mock.calls.map((c) => c[0])).toContain(
				"Access granted for 24 hours.",
			),
		);
		await waitFor(() => expect(dialog()).toBeNull());
		expect(posted("/deny")).toBe(false);
		await settle();
		expect(dialog()).toBeNull();
	});

	it("declining gives nobody access, marks the notification read and the dialog goes", async () => {
		server.pending["ws-1"] = [request({ id: "r-deny" })];
		notices.set([notice("ws-1", "r-deny")]);
		renderPrompt();
		const d = await findDialog();
		fireEvent.click(within(d).getByRole("button", { name: "Decline" }));
		await waitFor(() =>
			expect(
				posted("/v2/workspaces/ws-1/support-access/requests/r-deny/deny"),
			).toBe(true),
		);
		await waitFor(() =>
			expect(posted("/v2/me/notifications/n-r-deny/read")).toBe(true),
		);
		await waitFor(() =>
			expect(toast.success.mock.calls.map((c) => c[0])).toContain(
				"Request declined.",
			),
		);
		await waitFor(() => expect(dialog()).toBeNull());
		expect(posted("/approve")).toBe(false);
		await settle();
		expect(dialog()).toBeNull();
	});

	it("closed without an answer, it sends nothing, keeps the notification unread and stays away for the session", async () => {
		server.pending["ws-1"] = [request({ id: "r-close" })];
		notices.set([notice("ws-1", "r-close")]);
		const { unmount } = renderPrompt();
		const d = await findDialog();
		fireEvent.keyDown(d, { key: "Escape" });
		await waitFor(() => expect(dialog()).toBeNull());
		await settle();
		expect(posts()).toEqual([]);
		expect(requestSeen("r-close")).toBe(true);
		unmount();
		// A reload in the same browser session: still closed.
		renderPrompt();
		await settle();
		expect(dialog()).toBeNull();
		expect(posts()).toEqual([]);
	});

	it("after closing it, asking for it from the inbox opens it again", async () => {
		server.pending["ws-1"] = [request({ id: "r-reopen" })];
		notices.set([notice("ws-1", "r-reopen")]);
		renderPrompt();
		const d = await findDialog();
		fireEvent.keyDown(d, { key: "Escape" });
		await waitFor(() => expect(dialog()).toBeNull());
		act(() => openSupportRequest("r-reopen"));
		const again = await findDialog();
		expect(again.textContent).toContain("Sam Staff");
	});

	it("does not open by itself in Present mode, but opens when asked for from the inbox", async () => {
		server.pending["ws-1"] = [request({ id: "r-present" })];
		notices.set([notice("ws-1", "r-present")]);
		renderPrompt("/en-US/w/ws-1/projects/p-1/present");
		await settle();
		await settle();
		expect(dialog()).toBeNull();
		act(() => openSupportRequest("r-present"));
		const d = await findDialog();
		expect(d.textContent).toContain("Sam Staff");
	});

	it("with two requests waiting, shows one at a time, oldest first", async () => {
		server.pending["ws-1"] = [
			request({
				created_at: hoursAgo(1),
				id: "r-newer",
				requested_by_name: "Robin Newer",
			}),
		];
		server.pending["ws-2"] = [
			request({
				created_at: hoursAgo(30),
				id: "r-older",
				requested_by_name: "Olga Older",
			}),
		];
		notices.set([
			notice("ws-1", "r-newer", { created_at: hoursAgo(1) }),
			notice("ws-2", "r-older", {
				created_at: hoursAgo(30),
				scope: "Gemeente Utrecht › Lab",
			}),
		]);
		renderPrompt();
		const first = await findDialog();
		await waitFor(() => expect(first.textContent).toContain("Olga Older"));
		expect(first.textContent).toContain("Lab");
		expect(first.textContent).not.toContain("Robin Newer");
		expect(screen.getAllByRole("dialog")).toHaveLength(1);

		fireEvent.click(
			within(first).getByRole("button", { name: "Approve for 24 hours" }),
		);
		await waitFor(() =>
			expect(
				posted("/v2/workspaces/ws-2/support-access/requests/r-older/approve"),
			).toBe(true),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")?.textContent ?? "").toContain(
				"Robin Newer",
			),
		);
		const second = screen.getByRole("dialog");
		expect(second.textContent).toContain("Team");
		expect(second.textContent).not.toContain("Olga Older");
		expect(screen.getAllByRole("dialog")).toHaveLength(1);
	});
	it("opens for a request that arrives after its workspace's list was loaded", async () => {
		// An earlier request, already answered: the workspace's list is loaded and empty.
		server.pending["ws-1"] = [];
		notices.set([notice("ws-1", "r-earlier", { read: true })]);
		renderPrompt();
		await waitFor(() => expect(fetchedRequestsOf("ws-1")).toBe(true));
		await settle();
		expect(dialog()).toBeNull();
		// A new request and its notice; nothing else refetches the list.
		server.pending["ws-1"] = [request({ id: "r-later" })];
		notices.set([
			notice("ws-1", "r-later", { created_at: hoursAgo(0) }),
			notice("ws-1", "r-earlier", { read: true }),
		]);
		const d = await findDialog();
		expect(d.textContent).toContain("Sam Staff");
	});

	it("an answer to a request that is gone shows the error, reloads the list and closes", async () => {
		server.pending["ws-1"] = [request({ id: "r-gone" })];
		notices.set([notice("ws-1", "r-gone")]);
		renderPrompt();
		const d = await findDialog();
		// Another admin answered it, or it expired, while the dialog was open.
		server.pending["ws-1"] = [];
		const listsBefore = server.calls.filter(
			(c) => c.method === "GET" && c.url.includes("/support-access/requests"),
		).length;
		fireEvent.click(
			within(d).getByRole("button", { name: "Approve for 24 hours" }),
		);
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		await waitFor(() =>
			expect(
				server.calls.filter(
					(c) =>
						c.method === "GET" && c.url.includes("/support-access/requests"),
				).length,
			).toBeGreaterThan(listsBefore),
		);
		await waitFor(() => expect(dialog()).toBeNull());
		expect(toast.success).not.toHaveBeenCalled();
		expect(posted("/v2/me/notifications/n-r-gone/read")).toBe(false);
	});

	it("after a network error the request still waits, so the dialog stays to try again", async () => {
		server.pending["ws-1"] = [request({ id: "r-offline" })];
		notices.set([notice("ws-1", "r-offline")]);
		server.offline = true;
		renderPrompt();
		const d = await findDialog();
		fireEvent.click(within(d).getByRole("button", { name: "Decline" }));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		await settle();
		expect(dialog()).toBeTruthy();
		expect(requestSeen("r-offline")).toBe(false);
	});

	it("holds back while another dialog is open, and opens once it has closed", async () => {
		server.pending["ws-1"] = [request({ id: "r-wait" })];
		notices.set([notice("ws-1", "r-wait")]);
		const view = renderPrompt("/en-US/w/ws-1/home", true);
		await waitFor(() => expect(fetchedRequestsOf("ws-1")).toBe(true));
		await settle();
		expect(screen.getByRole("dialog", { name: "Rename project" })).toBeTruthy();
		expect(dialog()).toBeNull();
		// The other dialog closes; the next inbox refetch looks again.
		view.setOther(false);
		await waitFor(() =>
			expect(
				screen.queryByRole("dialog", { name: "Rename project" }),
			).toBeNull(),
		);
		await settle();
		expect(dialog()).toBeNull();
		act(() => notices.set([notice("ws-1", "r-wait")]));
		const d = await findDialog();
		expect(d.textContent).toContain("Sam Staff");
	});
});
