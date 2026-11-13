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
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { TasksSummaryT } from "../contract/contract.gen";
import { TASKS_PROMPT_SEEN_KEY } from "./tasksPromptState";
import { summarise } from "./tasksSummary";

// The organisation menu's Tasks entry and the banner read one summary, here a small store
// the test sets like react-query would answer; What's new is stood in for by a marker that
// shows whether it is being held back (the banner never holds it).
const store = vi.hoisted(() => {
	type State = {
		data: import("../contract/contract.gen").TasksSummaryT;
		status: "pending" | "success";
	};
	let state: State = { data: [], status: "success" };
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		set: (next: State) => {
			state = next;
			for (const l of listeners) l();
		},
		subscribe: (l: () => void) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
	};
});
const navigate = vi.fn();
const capture = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { capture } }));

vi.mock("./tasksSummary", async (importOriginal) => {
	const { useSyncExternalStore } = await import("react");
	return {
		...(await importOriginal<typeof import("./tasksSummary")>()),
		useTasksSummary: () => useSyncExternalStore(store.subscribe, store.get),
	};
});
vi.mock("../i18n", () => ({ useAccountsCatalog: () => true }));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/components/release/ReleaseVideoModal", () => ({
	ReleaseVideoModal: ({ held }: { held?: boolean }) => (
		<output data-testid="whats-new" data-held={String(Boolean(held))} />
	),
}));
vi.mock("@/features/sidebar/hooks/useHelpModals", () => ({
	useHelpModals: () => ({ openFeedback: vi.fn() }),
}));
// The organisation menu's own reads, stood in for: no workspaces, no profile yet.
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspaces: [] }),
}));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: undefined }) }));
vi.mock("@/features/sidebar/hooks/useSidebarView", () => ({
	useSidebarView: () => ({ params: {} }),
}));

const { HelpBlock } = await import("@/features/sidebar/blocks/HelpBlock");
const { default: SignPromptBannerConnected } = await import("./TasksPrompt");
const { RailProvider } = await import("@/features/sidebar/shell/rail");
const { OrgHomeView } = await import(
	"@/features/sidebar/views/org/OrgHomeView"
);

const row = (over: Partial<TasksSummaryT[number]>): TasksSummaryT[number] => ({
	account_stage: "prospect",
	logo_url: null,
	name: "Gemeente Testdorp",
	next_task_code: "explore_demo",
	next_task_document_id: null,
	next_task_document_kind: null,
	next_task_params: {},
	next_task_title: null,
	org_id: "0199a1bd-0000-7000-8000-000000000001",
	tasks_done: 0,
	tasks_total: 4,
	tasks_waiting: 4,
	...over,
});

const renderSidebar = (url = "/en-US/o") =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<MemoryRouter initialEntries={[url]}>
					<RailProvider inRail={false}>
						<HelpBlock />
					</RailProvider>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

/** The organisation menu and the Help block side by side, on that organisation's overview. */
const renderOrgSidebar = (orgId: string) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={[`/en-US/o/${orgId}/overview`]}>
						<RailProvider inRail={false}>
							<Routes>
								<Route
									path="/:language/o/:orgId/*"
									element={
										<>
											<OrgHomeView />
											<HelpBlock />
										</>
									}
								/>
							</Routes>
						</RailProvider>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

const link = (name: RegExp) => screen.queryByRole("link", { name });

const held = () => screen.getByTestId("whats-new").getAttribute("data-held");

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
	sessionStorage.clear();
	navigate.mockReset();
	capture.mockReset();
	store.set({ data: [], status: "success" });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("summarise", () => {
	it("counts only organisations with a task waiting on the caller", () => {
		const out = summarise([
			row({ name: "A", tasks_done: 1, tasks_total: 4, tasks_waiting: 3 }),
			row({ name: "B", tasks_done: 4, tasks_total: 4, tasks_waiting: 0 }),
			// Locked or with dembrane: nothing to do now.
			row({ name: "C", tasks_done: 0, tasks_total: 2, tasks_waiting: 0 }),
		]);
		expect(out.orgs.map((o) => o.name)).toEqual(["A"]);
		expect([out.done, out.total]).toEqual([1, 4]);
	});
});

describe("the organisation menu's Tasks and Documents", () => {
	const ORG = row({}).org_id;

	beforeEach(() => {
		sessionStorage.setItem(TASKS_PROMPT_SEEN_KEY, "1");
		// The organisation's workspace list, which the menu fetches on its own.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("[]", { status: 200 })),
		);
	});

	it("something pending: Tasks counts what waits, Documents beside it", async () => {
		store.set({
			data: [row({ tasks_done: 1, tasks_waiting: 3 })],
			status: "success",
		});
		renderOrgSidebar(ORG);
		await waitFor(() => expect(link(/^Tasks/)).toBeTruthy());
		expect(link(/^Tasks/)?.getAttribute("href")).toBe(`/en-US/o/${ORG}/tasks`);
		expect(link(/^Tasks/)?.textContent).toContain("3");
		expect(link(/^Documents$/)?.getAttribute("href")).toBe(
			`/en-US/o/${ORG}/documents`,
		);
		// Help no longer lists tasks: they live under the organisation.
		expect(screen.getAllByText("Tasks")).toHaveLength(1);
	});

	it("nothing pending: both stay, so the documents and invoices are one click away", async () => {
		store.set({
			data: [row({ tasks_done: 4, tasks_waiting: 0 })],
			status: "success",
		});
		renderOrgSidebar(ORG);
		await waitFor(() => expect(held()).toBe("false"));
		expect(link(/^Tasks$/)).toBeTruthy();
		expect(link(/^Documents$/)).toBeTruthy();
	});

	it("a self-serve signup with no account content sees neither", async () => {
		store.set({ data: [], status: "success" });
		renderOrgSidebar(ORG);
		await waitFor(() => expect(held()).toBe("false"));
		expect(screen.getByText("Members")).toBeTruthy();
		expect(link(/^Tasks/)).toBeNull();
		expect(link(/^Documents$/)).toBeNull();
	});
});

describe("the banner for someone with tasks waiting", () => {
	const renderBanner = (url = "/en-US/o") =>
		render(
			<I18nProvider i18n={i18n}>
				<MantineProvider env="test">
					<MemoryRouter initialEntries={[url]}>
						<SignPromptBannerConnected />
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>,
		);
	const banner = () => screen.queryByTestId("sign-prompt-banner");

	it("never holds What's new back: a banner and a modal do not stack", () => {
		store.set({ data: [row({})], status: "pending" });
		renderSidebar();
		expect(held()).toBe("false");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("a plain signup sees no banner", () => {
		store.set({ data: [], status: "success" });
		renderBanner();
		expect(banner()).toBeNull();
	});

	it("is a banner, not a dialog, and names the organisation and the next task", async () => {
		store.set({ data: [], status: "pending" });
		renderBanner();
		expect(banner()).toBeNull();
		store.set({ data: [row({})], status: "success" });
		expect(
			await screen.findByText(/You have 4 things to do in Gemeente Testdorp\./),
		).toBeTruthy();
		expect(banner()?.textContent).toContain(
			"Next: Check out the demo we made for you",
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("its one button leads to that organisation's tasks", async () => {
		store.set({
			data: [
				row({ name: "Klein BV", org_id: "o-small", tasks_waiting: 1 }),
				row({ name: "Groot BV", org_id: "o-big", tasks_waiting: 3 }),
			],
			status: "success",
		});
		renderBanner();
		expect(
			await screen.findByText(/You have 3 things to do in Groot BV/),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Go to your tasks" }));
		expect(navigate).toHaveBeenCalledWith("/o/o-big/overview");
	});

	it("closed, it stays away for the session and says which document it was about", async () => {
		store.set({
			data: [
				row({
					next_task_code: "sign_offer",
					next_task_document_id: "doc-1",
					next_task_document_kind: "offer",
					tasks_waiting: 1,
				}),
			],
			status: "success",
		});
		const { unmount } = renderBanner();
		await waitFor(() => expect(banner()).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(banner()).toBeNull();
		expect(capture).toHaveBeenCalledWith("sign_prompt_dismissed", {
			document_id: "doc-1",
			document_kind: "offer",
		});
		unmount();
		// A reload in the same browser session: still closed.
		renderBanner();
		expect(banner()).toBeNull();
		cleanup();
		// The next browser session starts with empty session storage: it is back.
		sessionStorage.clear();
		renderBanner();
		await waitFor(() => expect(banner()).toBeTruthy());
	});

	it("goes once nothing waits any more", async () => {
		store.set({ data: [row({ tasks_waiting: 1 })], status: "success" });
		renderBanner();
		await waitFor(() => expect(banner()).toBeTruthy());
		store.set({
			data: [row({ tasks_done: 4, tasks_waiting: 0 })],
			status: "success",
		});
		await waitFor(() => expect(banner()).toBeNull());
	});

	it.each(["overview", "tasks", "account"])(
		"stays away on that organisation's %s page",
		(page) => {
			store.set({ data: [row({})], status: "success" });
			renderBanner(`/en-US/o/${row({}).org_id}/${page}`);
			expect(banner()).toBeNull();
		},
	);
});
