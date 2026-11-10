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
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { UpdateReportModalButton } from "./UpdateReportModalButton";

const fetchMock = vi.fn();
const project = { isSample: false, loaded: true };
const mutateAsync = vi.hoisted(() => vi.fn());

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

vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "ws-1", role: "admin", tier: "free" },
	}),
}));

vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ iso639_1: "en", language: "en-US" }),
}));

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

vi.mock("@/components/project/hooks", () => ({
	useProjectById: () =>
		project.loaded
			? { data: { id: "proj-1", is_sample: project.isSample }, isSuccess: true }
			: { data: undefined, isSuccess: false },
}));

vi.mock("./hooks", () => ({
	useCreateProjectReportMutation: () => ({
		error: null,
		isPending: false,
		mutateAsync,
	}),
	useProjectReport: () => ({
		data: { language: "en", show_portal_link: false, user_instructions: "" },
	}),
}));

const answer = (body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status: 200,
	});

const snapshot = (exhausted: boolean) => ({
	ai: { exhausted, percent_used: exhausted ? 100 : 0, unlimited: false },
	audio_seconds: { limit: 18000, used: 0 },
	free: true,
	period_start: "2026-10-01T00:00:00Z",
	projects: { limit: 1, used: 1 },
	resets_at: "2026-11-01T00:00:00Z",
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
	window.ResizeObserver = class {
		disconnect() {}
		observe() {}
		unobserve() {}
	} as unknown as typeof ResizeObserver;
	vi.stubGlobal("fetch", fetchMock);
});

beforeEach(() => {
	fetchMock.mockReset();
	mutateAsync.mockReset();
	project.isSample = false;
	project.loaded = true;
});

afterEach(() => cleanup());

const renderButton = async (exhausted: boolean) => {
	fetchMock.mockImplementation(async () => answer(snapshot(exhausted)));
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter initialEntries={["/p/proj-1"]}>
						<Routes>
							<Route
								path="/p/:projectId"
								element={<UpdateReportModalButton reportId={1} />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	await waitFor(() =>
		expect(
			client.getQueryState(["workspace", "ws-1", "free-allowance"])?.status,
		).toBe("success"),
	);
	await act(async () => {
		fireEvent.click(screen.getByTestId("report-update-button"));
	});
};

it("opens the create flow while this month's AI has room", async () => {
	await renderButton(false);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	expect(await screen.findByTestId("report-generate-button")).toBeTruthy();
});

it("opens the AI wall once this month's AI is used up", async () => {
	await renderButton(true);
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("ai_budget");
	expect(modal.dataset.action).toBe("report");
	expect(modal.dataset.resets).toBe("2026-11-01T00:00:00Z");
	expect(modal.dataset.tier).toBe("free");
});

it("closes the form and opens the AI wall when the server refuses the report", async () => {
	mutateAsync.mockRejectedValueOnce({
		response: {
			data: {
				code: "billing.tier_limit",
				detail: {
					error: "FREE_TIER_LIMIT",
					limit: "ai_budget",
					resets_at: "2026-12-01T00:00:00Z",
				},
				params: { limit: "ai_budget" },
			},
			status: 402,
		},
	});
	await renderButton(false);
	const generate = await screen.findByTestId("report-generate-button");
	await act(async () => {
		fireEvent.click(generate);
	});
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("ai_budget");
	expect(modal.dataset.resets).toBe("2026-12-01T00:00:00Z");
	await waitFor(() =>
		expect(screen.queryByTestId("report-generate-button")).toBeNull(),
	);
});

it("leaves a sample project's report open when this month's AI is used up", async () => {
	project.isSample = true;
	await renderButton(true);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("walls nothing while is_sample is still loading", async () => {
	project.loaded = false;
	await renderButton(true);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});
