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
		opened,
		wallKey,
		currentTier,
	}: {
		opened: boolean;
		wallKey: string;
		currentTier: string;
	}) =>
		opened ? (
			<div
				data-testid="upgrade-modal"
				data-wall={wallKey}
				data-tier={currentTier}
			/>
		) : null,
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
	it("a spent map opens the upgrade modal", async () => {
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
				params: { cap: 1, limit: "map", used: 1 },
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
		expect(modal.dataset.wall).toBe("map_cap");
		expect(modal.dataset.tier).toBe("free");
		await waitFor(() => expect(bffMock.post).toHaveBeenCalledTimes(1));
		expect(toastMock.error).not.toHaveBeenCalled();
	});
});
