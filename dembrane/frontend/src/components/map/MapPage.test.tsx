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
	within,
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
import { ApiRequestError } from "@/lib/errors/read";
import { fixtureMapResult } from "./data/fixture";
import { MapPage } from "./MapPage";
import { resetMapSettingsForTests } from "./state/settings";

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspace: { role: "admin" }, workspaceId: "w1" }),
}));

const bffMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/bff", () => ({ bff: bffMock }));
vi.mock("@/hooks/useServerEvents", () => ({ useServerEvents: () => {} }));

const toastMock = vi.hoisted(() => ({
	error: vi.fn(),
	info: vi.fn(),
	success: vi.fn(),
}));
vi.mock("@/components/common/Toaster", () => ({ toast: toastMock }));

vi.mock("@/components/project/hooks", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useProjectById: () => ({
		data: { id: "p1", is_sample: false },
		isSuccess: true,
	}),
}));

vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({
		aiAction,
		opened,
		resetsAt,
		wallKey,
		currentTier,
	}: {
		aiAction?: string;
		opened: boolean;
		resetsAt?: string | null;
		wallKey: string;
		currentTier: string;
	}) =>
		opened ? (
			<div
				data-testid="upgrade-modal"
				data-wall={wallKey}
				data-tier={currentTier}
				data-action={aiAction}
				data-resets={resetsAt ?? ""}
			/>
		) : null,
}));

vi.mock("@/components/workspace/FreeAllowanceBanner", () => ({
	FreeAllowanceBanner: ({
		feature,
		action,
	}: {
		feature: string;
		action?: string;
	}) => (
		<div data-testid={`allowance-banner-${feature}`} data-action={action} />
	),
}));

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

describe("MapPage in fixture mode", () => {
	it("renders both linked maps and the panels for 50 nodes without requests", () => {
		const client = new QueryClient();
		const { container } = render(
			<MantineProvider>
				<I18nProvider i18n={i18n}>
					<QueryClientProvider client={client}>
						<MemoryRouter>
							<MapPage projectId="p1" workspaceId="w1" fixture="50" />
						</MemoryRouter>
					</QueryClientProvider>
				</I18nProvider>
			</MantineProvider>,
		);

		// The cluster map alone opens the page; the tree waits under Advanced.
		expect(screen.getByText("Local map")).toBeTruthy();
		expect(screen.queryByText("Argument tree (MST)")).toBeNull();
		expect(container.querySelector("#argument-tree")).toBeNull();
		expect(container.querySelectorAll("#localmap circle.node")).toHaveLength(
			50,
		);
		// The toolbar on the map: pause, the density dial, forces and the view.
		const toolbar = screen.getByRole("toolbar", { name: "Map controls" });
		for (const name of [
			"Pause physics",
			"Force settings",
			"Side by side",
			"Cluster map",
			"Argument tree",
		]) {
			expect(within(toolbar).getByRole("button", { name })).toBeTruthy();
		}
		expect(
			within(toolbar).getByRole("slider", {
				name: "Cluster density: fewer or more clusters",
			}),
		).toBeTruthy();
		fireEvent.click(
			within(toolbar).getByRole("button", { name: "Side by side" }),
		);
		expect(container.querySelector("#argument-tree")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
		expect(container.querySelector("#spotlight-panel")).toBeTruthy();
		// What was spotlit before sits under the spotlit item, in the same panel.
		expect(
			container.querySelector(
				'#spotlight-panel [aria-label="Earlier in the spotlight"]',
			) ?? screen.getByText(/What you spotlight is kept here/),
		).toBeTruthy();
		// Showcase is off by default.
		expect(container.querySelector("#showcase-panel")).toBeNull();
		// Generation controls are hidden in fixture mode.
		expect(screen.queryByRole("button", { name: "Generate map" })).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("MapPage free tier", () => {
	it("a used-up AI budget opens the AI wall for the map", async () => {
		bffMock.get.mockImplementation((path: string) => {
			if (path === "/map/projects/p1/graph") return Promise.resolve(null);
			if (path === "/map/projects/p1") {
				return Promise.resolve({
					attempt: null,
					current: null,
					source: { conversations_with_transcripts: 2 },
				});
			}
			return Promise.resolve({ fact_checks: {} });
		});
		bffMock.post.mockRejectedValue(
			new ApiRequestError(402, {
				action: "upgrade",
				code: "billing.tier_limit",
				detail: {
					error: "FREE_TIER_LIMIT",
					limit: "ai_budget",
					resets_at: "2026-12-01T00:00:00Z",
				},
				params: { limit: "ai_budget" },
			}),
		);
		render(
			<MantineProvider>
				<I18nProvider i18n={i18n}>
					<QueryClientProvider
						client={
							new QueryClient({ defaultOptions: { queries: { retry: false } } })
						}
					>
						<MemoryRouter>
							<MapPage projectId="p1" workspaceId="w1" />
						</MemoryRouter>
					</QueryClientProvider>
				</I18nProvider>
			</MantineProvider>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Generate map" }),
		);
		const modal = await screen.findByTestId("upgrade-modal");
		expect(modal.dataset.wall).toBe("ai_budget");
		expect(modal.dataset.action).toBe("map");
		expect(modal.dataset.resets).toBe("2026-12-01T00:00:00Z");
		expect(modal.dataset.tier).toBe("free");
		await waitFor(() => expect(bffMock.post).toHaveBeenCalledTimes(1));
		expect(toastMock.error).not.toHaveBeenCalled();
	});

	const renderLive = (summary: unknown, graph: () => Promise<unknown>) => {
		bffMock.get.mockImplementation((path: string) => {
			if (path === "/map/projects/p1/graph") return graph();
			if (path === "/map/projects/p1") return Promise.resolve(summary);
			return Promise.resolve({ fact_checks: {} });
		});
		return render(
			<MantineProvider>
				<I18nProvider i18n={i18n}>
					<QueryClientProvider
						client={
							new QueryClient({ defaultOptions: { queries: { retry: false } } })
						}
					>
						<MemoryRouter>
							<MapPage projectId="p1" workspaceId="w1" />
						</MemoryRouter>
					</QueryClientProvider>
				</I18nProvider>
			</MantineProvider>,
		);
	};

	it("a fact-check refused for the AI budget opens the AI wall, not the claim error", async () => {
		// Auto fact-check on, coloured by fact-check: the page starts the claims itself.
		window.localStorage.setItem(
			"dembrane-map-settings",
			JSON.stringify({
				autoFactCheckClaims: true,
				colorBy: "factCheck",
				version: 7,
			}),
		);
		resetMapSettingsForTests();
		bffMock.post.mockRejectedValue(
			new ApiRequestError(402, {
				action: "upgrade",
				code: "billing.tier_limit",
				detail: {
					error: "FREE_TIER_LIMIT",
					limit: "ai_budget",
					resets_at: "2026-12-01T00:00:00Z",
				},
				params: { limit: "ai_budget" },
			}),
		);
		renderLive({ attempt: null, current: fixtureMapResult(50).result }, () =>
			Promise.reject(Object.assign(new Error("HTTP 404"), { status: 404 })),
		);
		const modal = await screen.findByTestId("upgrade-modal");
		expect(modal.dataset.wall).toBe("ai_budget");
		expect(modal.dataset.action).toBe("map");
		expect(modal.dataset.resets).toBe("2026-12-01T00:00:00Z");
		expect(bffMock.post.mock.calls[0][0]).toMatch(/fact-checks/);
		expect(document.body.textContent).not.toContain(
			"The fact-check could not be started.",
		);
	});

	it("carries the AI banner before the first map exists", async () => {
		renderLive(
			{
				attempt: { id: "a1", progress: {}, status: "extracting" },
				current: null,
				source: { conversations_with_transcripts: 2 },
			},
			() => Promise.resolve(null),
		);
		expect(await screen.findByText("Reading conversations")).toBeTruthy();
		expect(screen.getByTestId("allowance-banner-ai").dataset.action).toBe(
			"map",
		);
	});

	it("carries the AI banner once a map exists", async () => {
		renderLive({ attempt: null, current: fixtureMapResult(50).result }, () =>
			Promise.reject(Object.assign(new Error("HTTP 404"), { status: 404 })),
		);
		expect(await screen.findByTestId("allowance-banner-ai")).toBeTruthy();
	});
});
