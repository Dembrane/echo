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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FreeAllowanceBanner } from "./FreeAllowanceBanner";

const fetchMock = vi.fn();

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

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});

const NOT_FREE = {
	audio_seconds: null,
	chats: null,
	free: false,
	maps: null,
	period_start: null,
	popcorn_analyses: null,
	projects: null,
	reports: null,
	resets_at: null,
};

const snapshot = (overrides: Record<string, unknown> = {}) => ({
	audio_seconds: { limit: 18000, used: 0 },
	chats: { limit: 2, used: 0 },
	free: true,
	maps: { limit: 1, used: 0 },
	period_start: "2026-10-01T00:00:00Z",
	popcorn_analyses: { limit: 12, used: 0 },
	projects: { limit: 1, used: 1 },
	reports: { limit: 1, used: 0 },
	resets_at: "2026-11-01T00:00:00Z",
	...overrides,
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
	vi.stubGlobal("fetch", fetchMock);
});

beforeEach(() => {
	fetchMock.mockReset();
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
});

const renderBanner = (feature: "chats" | "reports" | "maps") => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter>
						<div data-testid="host">
							<FreeAllowanceBanner workspaceId="ws-1" feature={feature} />
						</div>
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

const resetDate = new Date("2026-11-01T00:00:00Z").toLocaleString("en", {
	dateStyle: "medium",
	timeStyle: "short",
});

it("renders nothing for a paid account", async () => {
	fetchMock.mockResolvedValue(answer(200, NOT_FREE));
	const client = renderBanner("reports");
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("renders nothing while the report is unspent", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot()));
	const client = renderBanner("reports");
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("says the report is used and when it resets, and opens the wall", async () => {
	fetchMock.mockResolvedValue(
		answer(200, snapshot({ reports: { limit: 1, used: 1 } })),
	);
	renderBanner("reports");
	const banner = await screen.findByTestId("free-allowance-banner");
	expect(banner.textContent).toContain(
		`You have used this month's free report. It resets on ${resetDate}.`,
	);
	const button = screen.getByTestId("free-allowance-banner-upgrade");
	expect(button.textContent).toBe("See upgrade options");
	fireEvent.click(button);
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("report_cap");
	expect(modal.dataset.tier).toBe("free");
});

it("names the chat and map walls", async () => {
	fetchMock.mockImplementation(async () =>
		answer(
			200,
			snapshot({ chats: { limit: 2, used: 2 }, maps: { limit: 1, used: 1 } }),
		),
	);
	renderBanner("chats");
	const chats = await screen.findByTestId("free-allowance-banner");
	expect(chats.textContent).toContain(
		`You have used this month's free chats. They reset on ${resetDate}.`,
	);
	fireEvent.click(screen.getByTestId("free-allowance-banner-upgrade"));
	expect(screen.getByTestId("upgrade-modal").dataset.wall).toBe("chat_cap");
	cleanup();

	renderBanner("maps");
	const maps = await screen.findByTestId("free-allowance-banner");
	expect(maps.textContent).toContain(
		`You have used this month's free map. Your current map stays here. It resets on ${resetDate}.`,
	);
	fireEvent.click(screen.getByTestId("free-allowance-banner-upgrade"));
	expect(screen.getByTestId("upgrade-modal").dataset.wall).toBe("map_cap");
});

it("states the live limit when staff allow more than one", async () => {
	fetchMock.mockImplementation(async () =>
		answer(
			200,
			snapshot({
				maps: { limit: 3, used: 3 },
				reports: { limit: 2, used: 2 },
			}),
		),
	);
	renderBanner("reports");
	const reports = await screen.findByTestId("free-allowance-banner");
	expect(reports.textContent).toContain(
		`You have used this month's 2 free reports. They reset on ${resetDate}.`,
	);
	cleanup();

	renderBanner("maps");
	const maps = await screen.findByTestId("free-allowance-banner");
	expect(maps.textContent).toContain(
		`You have used this month's 3 free maps. Your current maps stay here. They reset on ${resetDate}.`,
	);
});

it("states no number when staff set the limit to 0", async () => {
	fetchMock.mockImplementation(async () =>
		answer(
			200,
			snapshot({
				maps: { limit: 0, used: 0 },
				reports: { limit: 0, used: 0 },
			}),
		),
	);
	renderBanner("reports");
	const reports = await screen.findByTestId("free-allowance-banner");
	expect(reports.textContent).toContain(
		`You have used this month's free reports. They reset on ${resetDate}.`,
	);
	expect(reports.textContent).not.toMatch(/\b0\b/);
	cleanup();

	renderBanner("maps");
	const maps = await screen.findByTestId("free-allowance-banner");
	expect(maps.textContent).toContain(
		`You have used this month's free maps. Your current maps stay here. They reset on ${resetDate}.`,
	);
});
