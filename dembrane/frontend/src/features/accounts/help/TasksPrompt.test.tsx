// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
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
import type { TasksSummaryT } from "../contract/contract.gen";
import { TASKS_PROMPT_SEEN_KEY } from "./tasksPrompt";
import { summarise } from "./tasksSummary";

// The sidebar's Tasks entry and the popup after sign-in read one summary, here a small
// store the test sets like react-query would answer; What's new is stood in for by a
// marker that shows whether it is being held back.
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
	useHelpModals: () => ({ openFeedback: vi.fn(), openReportIssue: vi.fn() }),
}));

const { HelpBlock } = await import("@/features/sidebar/blocks/HelpBlock");
const { RailProvider } = await import("@/features/sidebar/shell/rail");

const row = (over: Partial<TasksSummaryT[number]>): TasksSummaryT[number] => ({
	account_stage: "prospect",
	logo_url: null,
	name: "Gemeente Testdorp",
	next_task_code: "explore_demo",
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
	store.set({ data: [], status: "success" });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("the Tasks entry", () => {
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

	it("shows while something waits and is gone once everything is done", async () => {
		store.set({
			data: [row({ tasks_done: 3, tasks_waiting: 1 })],
			status: "success",
		});
		const { unmount } = renderSidebar();
		expect(await screen.findByTestId("help-tasks")).toBeTruthy();
		expect(screen.getByText("3/4")).toBeTruthy();
		unmount();
		sessionStorage.setItem(TASKS_PROMPT_SEEN_KEY, "1");
		store.set({
			data: [row({ tasks_done: 4, tasks_waiting: 0 })],
			status: "success",
		});
		renderSidebar();
		await waitFor(() => expect(held()).toBe("false"));
		expect(screen.queryByTestId("help-tasks")).toBeNull();
	});
});

describe("the popup after sign-in", () => {
	it("a plain signup sees no Tasks entry and no popup, and What's new is not held", async () => {
		store.set({ data: [], status: "success" });
		renderSidebar();
		await waitFor(() => expect(held()).toBe("false"));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByTestId("help-tasks")).toBeNull();
		expect(screen.queryByText("Tasks")).toBeNull();
	});

	it("comes first: What's new waits until it is closed with Later", async () => {
		store.set({ data: [], status: "pending" });
		renderSidebar();
		// Still deciding: What's new may not jump ahead.
		expect(held()).toBe("true");
		store.set({ data: [row({})], status: "success" });
		expect(
			await screen.findByText("You have 4 things to do in Gemeente Testdorp"),
		).toBeTruthy();
		expect(
			screen.getByText("Next: Check out the demo we made for you"),
		).toBeTruthy();
		expect(held()).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Later" }));
		await waitFor(() => expect(held()).toBe("false"));
		await waitFor(() =>
			expect(
				screen.queryByText("You have 4 things to do in Gemeente Testdorp"),
			).toBeNull(),
		);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("its one button leads to that organisation's tasks", async () => {
		store.set({
			data: [
				row({ name: "Klein BV", org_id: "o-small", tasks_waiting: 1 }),
				row({ name: "Groot BV", org_id: "o-big", tasks_waiting: 3 }),
			],
			status: "success",
		});
		renderSidebar();
		expect(
			await screen.findByText("You have 3 things to do in Groot BV"),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Go to your tasks" }));
		expect(navigate).toHaveBeenCalledWith("/o/o-big/account");
		await waitFor(() => expect(held()).toBe("false"));
	});

	it("shows once per sign-in", async () => {
		store.set({ data: [row({ tasks_waiting: 1 })], status: "success" });
		const { unmount } = renderSidebar();
		expect(
			await screen.findByText("You have 1 thing to do in Gemeente Testdorp"),
		).toBeTruthy();
		unmount();
		renderSidebar();
		await waitFor(() => expect(held()).toBe("false"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("stays away on that organisation's tasks page", async () => {
		store.set({ data: [row({})], status: "success" });
		renderSidebar(`/en-US/o/${row({}).org_id}/account`);
		await waitFor(() => expect(held()).toBe("false"));
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
