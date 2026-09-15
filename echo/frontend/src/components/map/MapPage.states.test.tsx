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
import type { MapPayloadV2 } from "./hooks";
import { MapPage } from "./MapPage";
import {
	MAP_SETTINGS_STORAGE_KEY,
	readMapSettings,
	resetMapSettingsForTests,
} from "./state/settings";
import type { ObjectType } from "./types";

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
	onGenerateObjects,
}: {
	fixture?: MapFixtureId | null;
	search?: string;
	onGenerateObjects?: (type: ObjectType) => void;
}) =>
	render(
		<MantineProvider>
			<I18nProvider i18n={i18n}>
				<QueryClientProvider
					client={
						new QueryClient({ defaultOptions: { queries: { retry: false } } })
					}
				>
					<MemoryRouter initialEntries={[`/map${search}`]}>
						<MapPage
							projectId="p1"
							workspaceId="w1"
							fixture={fixture}
							onGenerateObjects={onGenerateObjects}
						/>
					</MemoryRouter>
				</QueryClientProvider>
			</I18nProvider>
		</MantineProvider>,
	);

const expectNoRequests = () => {
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(bffMock.get).not.toHaveBeenCalled();
	expect(bffMock.post).not.toHaveBeenCalled();
};

describe("MapPage budget states in fixture mode", () => {
	it("shows an empty state for zero objects", () => {
		const { container } = renderPage({ fixture: "empty" });
		expect(
			screen.getByText("There are no saved objects in this scope yet."),
		).toBeTruthy();
		expect(container.querySelector("circle.node")).toBeNull();
		expectNoRequests();
	});

	it("lets a single object be inspected without an edge", () => {
		const { container } = renderPage({ fixture: "single" });
		expect(container.querySelector("#result-list")).toBeTruthy();
		expect(container.querySelector("circle.node")).toBeNull();
		expect(container.querySelector("line")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Synthetic tension 0" }),
		);
		expect(screen.getByText("Pole A")).toBeTruthy();
		expectNoRequests();
	});

	it("puts the list first for a small result and keeps the map available", async () => {
		const { container } = renderPage({ fixture: "small" });
		expect(container.querySelector("#result-list")).toBeTruthy();
		expect(container.querySelector("#argument-tree")).toBeNull();
		fireEvent.click(screen.getByRole("radio", { name: "Map" }));
		await waitFor(() =>
			expect(
				container.querySelectorAll("#argument-tree circle.node"),
			).toHaveLength(12),
		);
		expect(container.querySelector("#result-list")).toBeNull();
		expectNoRequests();
	});

	it("does not start a layout above the node budget and raises it on request", () => {
		withoutMaps();
		const { container } = renderPage({ fixture: "oversized" });
		const nodeLimit = FIXTURE_BUDGETS.defaults.nodeLimit;
		expect(container.querySelector("#map-over-budget")).toBeTruthy();
		expect(
			screen.getByText(
				`This scope has 400 objects. The map shows up to ${nodeLimit} at once.`,
			),
		).toBeTruthy();
		expect(container.querySelector("circle.node")).toBeNull();
		expect(container.querySelector("#argument-tree")).toBeNull();
		// Still inspectable in the list.
		expect(container.querySelector("#result-list")).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Raise the budget to 400" }),
		);
		expect(readMapSettings()).toMatchObject({ nodeLimit: 400 });
		expect(container.querySelector("#map-over-budget")).toBeNull();
		expect(
			screen.getByText("Enable a visualization from the panel settings menu"),
		).toBeTruthy();
		expectNoRequests();
		// Four hundred list rows are slow to render in jsdom.
	}, 30_000);
});

describe("MapPage objects filter and URL state", () => {
	it("narrows to the types in the URL", () => {
		const { container } = renderPage({
			fixture: "mixed",
			search: "?types=tension&colorBy=valence",
		});
		const list = container.querySelector("#result-list");
		expect(list?.querySelectorAll("li")).toHaveLength(6);
		expect(screen.getByRole("button", { name: "Objects" }).textContent).toBe(
			"Objects (6)",
		);
	});

	it("never starts generation from a filter change", () => {
		const onGenerateObjects = vi.fn();
		renderPage({ fixture: "mixed", onGenerateObjects, search: "?types=" });
		expect(
			screen.getByText("Choose which objects to show in the Objects filter."),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("checkbox", { name: /^Tensions/ }));
		expect(readMapSettings().types).toEqual(["tension"]);
		expect(
			screen.getByRole("button", { name: "Synthetic tension 0" }),
		).toBeTruthy();
		expect(onGenerateObjects).not.toHaveBeenCalled();
		expectNoRequests();
	});

	it("offers the matching generate action for a checked type with no objects", () => {
		const onGenerateObjects = vi.fn();
		renderPage({
			fixture: "small",
			onGenerateObjects,
			search: "?types=popcorn",
		});
		expect(screen.getByText("No popcorn saved yet.")).toBeTruthy();
		expect(onGenerateObjects).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Generate popcorn" }));
		expect(onGenerateObjects).toHaveBeenCalledWith("popcorn");
	});

	it("keeps the filters on selection and reveals a hidden type only on request", () => {
		withoutMaps();
		const { container } = renderPage({
			fixture: "mixed",
			search: "?types=tension",
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Synthetic tension 0" }),
		);
		expect(
			screen.getAllByText("Hidden by the Objects filter").length,
		).toBeGreaterThan(0);
		expect(
			container.querySelector("#result-list")?.querySelectorAll("li"),
		).toHaveLength(6);

		fireEvent.click(
			screen.getAllByRole("button", { name: "Show Arguments" })[0],
		);
		expect(readMapSettings().types).toEqual(["argument", "tension"]);
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
		expect(
			await screen.findByText(/^This scope has 400 objects\./),
		).toBeTruthy();
		const graphCalls = bffMock.get.mock.calls.filter(
			([path]) => path === "/map/projects/p1/graph",
		);
		expect(graphCalls).toHaveLength(1);
		// Defaults are the server's: no budget parameters are sent.
		expect(graphCalls[0][1]).toEqual({});
		expect(container.querySelector("circle.node")).toBeNull();
		expect(container.querySelector("#result-list")).toBeNull();
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
