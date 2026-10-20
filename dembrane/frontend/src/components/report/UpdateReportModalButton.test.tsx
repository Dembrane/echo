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
		mutateAsync: vi.fn(),
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

const snapshot = (reports: { used: number; limit: number }) => ({
	audio_seconds: { limit: 18000, used: 0 },
	chats: { limit: 2, used: 0 },
	free: true,
	maps: { limit: 1, used: 0 },
	period_start: "2026-10-01T00:00:00Z",
	popcorn_analyses: { limit: 12, used: 0 },
	projects: { limit: 1, used: 1 },
	reports,
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
	project.isSample = false;
	project.loaded = true;
});

afterEach(() => cleanup());

const renderButton = async (reports: { used: number; limit: number }) => {
	fetchMock.mockImplementation(async () => answer(snapshot(reports)));
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

it("opens the create flow while this month's report is unspent", async () => {
	await renderButton({ limit: 1, used: 0 });
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("opens the wall once this month's report is spent", async () => {
	await renderButton({ limit: 1, used: 1 });
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("report_cap");
	expect(modal.dataset.tier).toBe("free");
});

it("leaves a sample project's report open when the month's report is spent", async () => {
	project.isSample = true;
	await renderButton({ limit: 1, used: 1 });
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("walls nothing while is_sample is still loading", async () => {
	project.loaded = false;
	await renderButton({ limit: 1, used: 1 });
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});
