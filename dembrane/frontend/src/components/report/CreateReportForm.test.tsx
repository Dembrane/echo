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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CreateReportForm } from "./CreateReportForm";

const fetchMock = vi.fn();
const mutate = vi.fn();
const mutation: { error: unknown } = { error: null };
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

vi.mock("@/components/project/hooks", () => ({
	useProjectById: () =>
		project.loaded
			? { data: { id: "proj-1", is_sample: project.isSample }, isSuccess: true }
			: { data: undefined, isSuccess: false },
}));

vi.mock("@posthog/react", () => ({ usePostHog: () => undefined }));

vi.mock("./hooks", () => ({
	useCreateProjectReportMutation: () => ({
		error: mutation.error,
		isPending: false,
		mutate,
	}),
	useProjectConversationCounts: () => ({
		data: { finished: 3, total: 3 },
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

const reportLimit = {
	response: {
		data: { detail: { error: "FREE_TIER_LIMIT", limit: "report" } },
		status: 402,
	},
};

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
	vi.stubGlobal("fetch", fetchMock);
});

beforeEach(() => {
	fetchMock.mockReset();
	mutate.mockReset();
	mutation.error = null;
	project.isSample = false;
	project.loaded = true;
	sessionStorage.clear();
});

afterEach(() => cleanup());

const renderForm = () => {
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
								element={<CreateReportForm onSuccess={() => {}} />}
							/>
						</Routes>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	return client;
};

const settled = (client: QueryClient) =>
	waitFor(() =>
		expect(
			client.getQueryState(["workspace", "ws-1", "free-allowance"])?.status,
		).toBe("success"),
	);

it("generates while this month's report is unspent", async () => {
	fetchMock.mockResolvedValue(answer(snapshot({ limit: 1, used: 0 })));
	const client = renderForm();
	await settled(client);
	expect(screen.queryByTestId("free-allowance-banner")).toBeNull();
	const generate = screen.getAllByTestId("report-create-button")[0];
	expect(generate.hasAttribute("disabled")).toBe(false);
	fireEvent.click(generate);
	expect(mutate).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("shows the banner and opens the wall instead of submitting once spent", async () => {
	fetchMock.mockResolvedValue(answer(snapshot({ limit: 1, used: 1 })));
	renderForm();
	await screen.findByTestId("free-allowance-banner");
	fireEvent.click(screen.getAllByTestId("report-create-button")[0]);
	expect(mutate).not.toHaveBeenCalled();
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("report_cap");
	expect(modal.dataset.tier).toBe("free");
});

it("opens the wall when the server refuses the report", async () => {
	fetchMock.mockResolvedValue(answer(snapshot({ limit: 1, used: 0 })));
	mutate.mockImplementation(
		(_vars: unknown, opts?: { onError?: (e: unknown) => void }) => {
			mutation.error = reportLimit;
			opts?.onError?.(reportLimit);
		},
	);
	const client = renderForm();
	await settled(client);
	fireEvent.click(screen.getAllByTestId("report-create-button")[0]);
	expect(mutate).toHaveBeenCalledTimes(1);
	const modal = await screen.findByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("report_cap");
	expect(modal.dataset.tier).toBe("free");
});

it("leaves a sample project's report open when the month's report is spent", async () => {
	project.isSample = true;
	fetchMock.mockResolvedValue(answer(snapshot({ limit: 1, used: 1 })));
	const client = renderForm();
	await settled(client);
	expect(screen.queryByTestId("free-allowance-banner")).toBeNull();
	fireEvent.click(screen.getAllByTestId("report-create-button")[0]);
	expect(mutate).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("walls nothing while is_sample is still loading", async () => {
	project.loaded = false;
	fetchMock.mockResolvedValue(answer(snapshot({ limit: 1, used: 1 })));
	const client = renderForm();
	await settled(client);
	expect(screen.queryByTestId("free-allowance-banner")).toBeNull();
	fireEvent.click(screen.getAllByTestId("report-create-button")[0]);
	expect(mutate).toHaveBeenCalledTimes(1);
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
});

it("names the sample's own report, not a month, when the server refuses it", async () => {
	project.isSample = true;
	fetchMock.mockResolvedValue(answer(snapshot({ limit: 1, used: 0 })));
	mutation.error = reportLimit;
	const client = renderForm();
	await settled(client);
	expect(document.body.textContent).toContain(
		"This sample project includes one report.",
	);
	expect(document.body.textContent).not.toContain("one report a month");
});
