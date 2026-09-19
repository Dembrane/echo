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
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { MapFixtureId } from "./data/fixture";
import { FIXTURE_BUDGETS, fixtureMapResult } from "./data/fixture";
import { type MapPayloadV2, mapKeys } from "./hooks";
import { MapPage } from "./MapPage";
import {
	MAP_SETTINGS_STORAGE_KEY,
	readMapSettings,
	resetMapSettingsForTests,
} from "./state/settings";

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspace: { role: "admin" }, workspaceId: "w1" }),
}));

const bffMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/bff", () => ({ bff: bffMock }));
vi.mock("@/hooks/useServerEvents", () => ({ useServerEvents: () => {} }));

i18n.load("en-US", {});
i18n.activate("en-US");

const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in tests")));
const originalFetch = globalThis.fetch;

beforeAll(() => {
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
	globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	window.localStorage.clear();
	resetMapSettingsForTests();
});

/** Panels on, maps off: the page states render without running a layout. */
const withoutMaps = () =>
	window.localStorage.setItem(
		MAP_SETTINGS_STORAGE_KEY,
		JSON.stringify({ showClusters: false, showTree: false, version: 2 }),
	);

const renderPage = ({
	fixture = null,
	search = "",
}: {
	fixture?: MapFixtureId | null;
	search?: string;
}) => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const result = render(
		<MantineProvider>
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={client}>
					<MemoryRouter initialEntries={[`/map${search}`]}>
						<MapPage projectId="p1" workspaceId="w1" fixture={fixture} />
					</MemoryRouter>
				</QueryClientProvider>
			</I18nProvider>
		</MantineProvider>,
	);
	return { ...result, client };
};

const expectNoRequests = () => {
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(bffMock.get).not.toHaveBeenCalled();
	expect(bffMock.post).not.toHaveBeenCalled();
};

describe("MapPage budget states in fixture mode", () => {
	it("shows an empty state for zero objects", () => {
		const { container } = renderPage({ fixture: "empty" });
		expect(screen.getByText(/No arguments were found/)).toBeTruthy();
		expect(container.querySelector("circle.node")).toBeNull();
		expectNoRequests();
	});

	it("lets a single object be inspected without an edge", () => {
		const { container } = renderPage({ fixture: "single" });
		expect(container.querySelector("#argument-tree circle.node")).toBeTruthy();
		expect(container.querySelector("line")).toBeNull();
		expectNoRequests();
	});

	it("opens a small result directly as a map", async () => {
		const { container } = renderPage({ fixture: "small" });
		await waitFor(() =>
			expect(
				container.querySelectorAll("#argument-tree circle.node"),
			).toHaveLength(8),
		);
		expect(container.querySelector("#result-list")).toBeNull();
		expect(screen.queryByText("List")).toBeNull();
		expectNoRequests();
	});

	it("does not start a layout above the node budget and raises it on request", () => {
		withoutMaps();
		const { container } = renderPage({ fixture: "oversized" });
		expect(container.querySelector("#map-over-budget")).toBeTruthy();
		expect(screen.getByText(/This map has 400 arguments/)).toBeTruthy();
		expect(container.querySelector("circle.node")).toBeNull();
		expect(container.querySelector("#argument-tree")).toBeNull();
		expect(container.querySelector("#result-list")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Open map" }));
		expect(readMapSettings()).toMatchObject({ nodeLimit: null });
		expect(container.querySelector("#map-over-budget")).toBeNull();
		expect(
			screen.getByText("Enable a visualization from the panel settings menu"),
		).toBeTruthy();
		expectNoRequests();
		// Four hundred list rows are slow to render in jsdom.
	}, 30_000);

	it("forgets admission when the selected result scope changes", () => {
		withoutMaps();
		renderPage({ fixture: "oversized", search: "?scope=run-1" });
		fireEvent.click(screen.getByRole("button", { name: "Open map" }));
		expect(screen.queryByText(/This map has 400 arguments/)).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "Show current arguments" }),
		);
		expect(screen.getByText(/This map has 400 arguments/)).toBeTruthy();
		expect(readMapSettings()).toMatchObject({ nodeLimit: null });
	});
});

describe("MapPage legacy URL compatibility", () => {
	it("ignores mixed-object and list parameters", async () => {
		const { container } = renderPage({
			fixture: "mixed",
			search: "?types=tension&colorBy=type&view=list",
		});
		await waitFor(() =>
			expect(
				container.querySelectorAll("#argument-tree circle.node"),
			).toHaveLength(23),
		);
		expect(screen.getByText("24 arguments")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Objects" })).toBeNull();
		expect(screen.queryByText("List")).toBeNull();
	});
});

describe("MapPage against the server", () => {
	const overBudget: MapPayloadV2 = {
		budgets: FIXTURE_BUDGETS,
		counts: {
			argument: 400,
			deduplicated_argument: 0,
			popcorn: 0,
			stakeholder: 0,
			tension: 0,
		},
		embedding: { dims: 3, key: "k", model: "m" },
		nodes: [],
		overBudget: true,
		relations: [],
		scope: { types: ["argument"] },
		snapshot: { createdAt: "", id: "snap-1", parentId: null, stale: [] },
		unplaced: [],
		version: 2,
	};

	it("shows an over-budget scope from counts and never asks for its vectors", async () => {
		bffMock.get.mockImplementation((path: string) => {
			if (path === "/map/projects/p1/graph") return Promise.resolve(overBudget);
			if (path === "/map/projects/p1") {
				return Promise.resolve({ attempt: null, current: null });
			}
			return Promise.resolve({ fact_checks: {} });
		});
		const { container } = renderPage({});
		expect(await screen.findByText(/This map has 400 arguments/)).toBeTruthy();
		const graphCalls = bffMock.get.mock.calls.filter(
			([path]) => path === "/map/projects/p1/graph",
		);
		expect(graphCalls).toHaveLength(1);
		// Defaults are the server's: no budget parameters are sent.
		expect(graphCalls[0][1]).toEqual({});
		expect(container.querySelector("circle.node")).toBeNull();
		expect(container.querySelector("#result-list")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Open map" }));
		await waitFor(() => {
			const calls = bffMock.get.mock.calls.filter(
				([path]) => path === "/map/projects/p1/graph",
			);
			expect(calls).toHaveLength(2);
			expect(calls[1][1]).toEqual({ edge_limit: 450, node_limit: 400 });
		});
		expect(readMapSettings()).toMatchObject({
			edgeLimit: null,
			nodeLimit: null,
		});
	});

	it("requires fresh admission when the project receives a new snapshot", async () => {
		bffMock.get.mockImplementation((path: string) => {
			if (path === "/map/projects/p1/graph") return Promise.resolve(overBudget);
			if (path === "/map/projects/p1") {
				return Promise.resolve({ attempt: null, current: overBudget });
			}
			return Promise.resolve({ fact_checks: {} });
		});
		const { client } = renderPage({});
		fireEvent.click(await screen.findByRole("button", { name: "Open map" }));
		await waitFor(() =>
			expect(screen.queryByText(/This map has 400 arguments/)).toBeNull(),
		);

		act(() => {
			client.setQueryData(mapKeys.project("p1"), {
				attempt: null,
				current: {
					...overBudget,
					snapshot: { ...overBudget.snapshot, id: "snap-2" },
				},
			});
		});

		expect(await screen.findByText(/This map has 400 arguments/)).toBeTruthy();
		const graphCalls = bffMock.get.mock.calls.filter(
			([path]) => path === "/map/projects/p1/graph",
		);
		expect(graphCalls).toHaveLength(3);
		expect(graphCalls[1][1]).toEqual({ edge_limit: 450, node_limit: 400 });
		expect(graphCalls[2][1]).toEqual({});
	});

	it("falls back to the project's legacy result while the graph endpoint is missing", async () => {
		const legacy = fixtureMapResult(50).result;
		bffMock.get.mockImplementation((path: string) => {
			if (path === "/map/projects/p1/graph") {
				return Promise.reject(
					Object.assign(new Error("HTTP 404"), { status: 404 }),
				);
			}
			if (path === "/map/projects/p1") {
				return Promise.resolve({ attempt: null, current: legacy });
			}
			return Promise.resolve({ fact_checks: {} });
		});
		const { container } = renderPage({});
		await waitFor(() =>
			expect(
				container.querySelectorAll("#argument-tree circle.node"),
			).toHaveLength(50),
		);
	});
});
