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
} from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AnalysisRecipe } from "@/components/analysis/hooks";
import { bff } from "@/lib/bff";
import { ProjectAnalysisRoute } from "./ProjectAnalysisRoute";

vi.mock("@/lib/bff", () => ({
	bff: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));
vi.mock("posthog-js", () => ({
	default: {
		capture: vi.fn(),
		getFeatureFlag: () => undefined,
		onFeatureFlags: () => () => {},
	},
}));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "ws-1", org_id: "org-1", role: "admin", tier: "free" },
		workspaceId: "ws-1",
	}),
}));
vi.mock("@/components/auth/hooks", () => ({
	useCurrentUser: () => ({ data: { email: "someone@example.com" } }),
}));

const recipe: AnalysisRecipe = {
	id: "deduplicated_arguments",
	inputTypes: [],
	name: "Deduplicated arguments",
	outputTypes: ["deduplicated_argument"],
	parametersSchema: null,
	purpose: "Merge arguments",
	scopeKeyPattern: "project",
	steps: [],
	validationRules: [],
	version: "1",
};
const loaded = <T,>(data: T) => ({
	data,
	error: null,
	isError: false,
	isLoading: false,
	refetch: vi.fn(),
});

vi.mock("@/components/analysis/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/analysis/hooks")>()),
	useAnalysisEvents: () => {},
	useAnalysisRecipes: () => loaded([recipe]),
	useAnalysisRuns: () => loaded({ canRun: true, runs: [] }),
	useAnalysisSources: () => loaded([]),
}));
vi.mock("@/components/popcorn/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/popcorn/hooks")>()),
	useProjectPopcorn: () => loaded(undefined),
}));

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
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
	if (!globalThis.ResizeObserver)
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		} as unknown as typeof ResizeObserver;
	globalThis.scrollTo = globalThis.scrollTo ?? (() => {});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	sessionStorage.clear();
});

const refusal = (limit: string) =>
	Object.assign(new Error("402"), {
		response: {
			data: {
				code: "billing.tier_limit",
				detail: { error: "FREE_TIER_LIMIT", limit },
				params: { limit },
			},
			status: 402,
		},
	});

// StrictMode runs mount effects twice, as the dev build does.
it.each(["map", "popcorn"])(
	"keeps the upgrade wall open after a used-up free %s",
	async (limit) => {
		vi.mocked(bff.post).mockRejectedValue(refusal(limit));
		// The results tab reads quietly in the background.
		vi.mocked(bff.get).mockResolvedValue({ items: [], openedAt: null });
		vi.mocked(bff.put).mockResolvedValue({ openedAt: null });
		const client = new QueryClient({
			defaultOptions: {
				mutations: { retry: false },
				queries: { retry: false },
			},
		});
		render(
			<StrictMode>
				<I18nProvider i18n={i18n}>
					<MantineProvider>
						<QueryClientProvider client={client}>
							<MemoryRouter
								initialEntries={["/w/ws-1/projects/p-1/analysis/recipes"]}
							>
								<Routes>
									<Route
										path="/w/:workspaceId/projects/:projectId/analysis/:tab"
										element={<ProjectAnalysisRoute />}
									/>
								</Routes>
							</MemoryRouter>
						</QueryClientProvider>
					</MantineProvider>
				</I18nProvider>
			</StrictMode>,
		);
		await act(async () => {
			fireEvent.click(await screen.findByRole("button", { name: "Prepare" }));
		});
		expect(
			await screen.findByTestId("pricing-configurator-modal"),
		).toBeTruthy();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});
		expect(screen.queryByTestId("pricing-configurator-modal")).toBeTruthy();
		// The wall answers it; no inline notice links elsewhere.
		expect(screen.queryByText("See plans")).toBeNull();
	},
);
