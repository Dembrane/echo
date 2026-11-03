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
		aiAction,
		aiUsedUp,
		resetsAt,
	}: {
		opened: boolean;
		wallKey: string;
		currentTier: string;
		aiAction?: string;
		aiUsedUp?: boolean;
		resetsAt?: string | null;
	}) =>
		opened ? (
			<div
				data-testid="upgrade-modal"
				data-wall={wallKey}
				data-tier={currentTier}
				data-action={aiAction ?? ""}
				data-resets={resetsAt ?? ""}
				data-used-up={String(aiUsedUp)}
			/>
		) : null,
}));

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});

const NOT_FREE = {
	ai: null,
	audio_seconds: null,
	free: false,
	period_start: null,
	projects: null,
	resets_at: null,
};

const ai = (percent_used: number, exhausted = false, unlimited = false) => ({
	ai: { exhausted, percent_used, unlimited },
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
	...ai(0),
	audio_seconds: { limit: 18000, used: 0 },
	free: true,
	period_start: "2026-10-01T00:00:00Z",
	projects: { limit: 1, used: 1 },
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

const renderBanner = (
	feature: "ai" | "audio",
	action?: "chat" | "report" | "map",
) => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter>
						<div data-testid="host">
							<FreeAllowanceBanner
								workspaceId="ws-1"
								feature={feature}
								action={action}
							/>
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

// The AI budget resets at 00:00 UTC on the 1st, so the banner names the day only.
const aiResetDay = "1 November 2026";

it("renders nothing for a paid account", async () => {
	fetchMock.mockResolvedValue(answer(200, NOT_FREE));
	const client = renderBanner("ai", "report");
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("renders nothing for a paid snapshot that still carries an exhausted AI meter", async () => {
	fetchMock.mockResolvedValue(answer(200, { ...NOT_FREE, ...ai(100, true) }));
	const client = renderBanner("ai", "chat");
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("renders nothing at 79% of the AI", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot(ai(79))));
	const client = renderBanner("ai", "chat");
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("renders nothing for an unlimited account, even at 100%", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot(ai(100, true, true))));
	const client = renderBanner("ai", "chat");
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("renders nothing when the snapshot has no AI meter", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot({ ai: null })));
	const client = renderBanner("ai", "chat");
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("warns at exactly 80% that AI and new recordings stop, and opens the AI wall", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot(ai(80))));
	renderBanner("ai", "chat");
	const banner = await screen.findByTestId("free-allowance-banner");
	expect(banner.textContent).toContain(
		`You've used 80% of this month's AI. When it runs out, AI features and new recordings stop until ${aiResetDay}.`,
	);
	expect(banner.textContent).toContain("recordings");
	const button = screen.getByTestId("free-allowance-banner-upgrade");
	expect(button.textContent).toBe("See upgrade options");
	fireEvent.click(button);
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("ai_budget");
	// Nothing was refused yet, so the wall names no action.
	expect(modal.dataset.action).toBe("");
	expect(modal.dataset.tier).toBe("free");
	expect(modal.dataset.resets).toBe("2026-11-01T00:00:00Z");
	// Not used up yet, so the popup must not say it is.
	expect(modal.dataset.usedUp).toBe("false");
});

it("shows the live percentage between 80 and 99", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot(ai(99))));
	renderBanner("ai", "map");
	const banner = await screen.findByTestId("free-allowance-banner");
	expect(banner.textContent).toContain("You've used 99% of this month's AI.");
});

it("says the month's AI is used up and paused until the reset day", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot(ai(100, true))));
	renderBanner("ai", "report");
	const banner = await screen.findByTestId("free-allowance-banner");
	expect(banner.textContent).toContain(
		`This month's AI is used up. AI features and new recordings are paused until ${aiResetDay}.`,
	);
	expect(banner.textContent).not.toContain("You've used");
	fireEvent.click(screen.getByTestId("free-allowance-banner-upgrade"));
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("ai_budget");
	expect(modal.dataset.action).toBe("report");
	expect(modal.dataset.usedUp).toBe("true");
});

it("reads exhausted as used up whatever the percentage says", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot(ai(42, true))));
	renderBanner("ai", "map");
	const banner = await screen.findByTestId("free-allowance-banner");
	expect(banner.textContent).toContain("This month's AI is used up.");
});

it("says the month's recording time is used and when it resets", async () => {
	fetchMock.mockResolvedValue(
		answer(200, snapshot({ audio_seconds: { limit: 18000, used: 17950 } })),
	);
	renderBanner("audio");
	const banner = await screen.findByTestId("free-allowance-banner");
	expect(banner.textContent).toContain(
		`You have used this month's free recording time. New recordings and uploads are paused until it resets on ${resetDate}.`,
	);
	fireEvent.click(screen.getByTestId("free-allowance-banner-upgrade"));
	expect(screen.getByTestId("upgrade-modal").dataset.wall).toBe(
		"free_allowance",
	);
});

it("renders nothing while recording time is left", async () => {
	fetchMock.mockResolvedValue(
		answer(200, snapshot({ audio_seconds: { limit: 18000, used: 17000 } })),
	);
	const client = renderBanner("audio");
	await settled(client);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});
