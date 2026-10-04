// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
import { MapPage } from "./MapPage";
import { resetMapSettingsForTests } from "./state/settings";

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({ workspace: { role: "admin" }, workspaceId: "w1" }),
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
		// The density dial is the map's one main control, on the map itself.
		expect(
			screen.getByRole("slider", {
				name: "Cluster density: fewer or more clusters",
			}),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Advanced" })).toBeTruthy();
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
