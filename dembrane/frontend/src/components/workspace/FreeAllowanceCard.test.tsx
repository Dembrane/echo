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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FreeAllowanceCard } from "./FreeAllowanceCard";

const fetchMock = vi.fn();

// The modal itself is covered by FeatureGate tests; here we only check it opens.
vi.mock("@/components/workspace/FeatureGate", () => ({
	UpgradeModal: ({ opened, wallKey }: { opened: boolean; wallKey: string }) =>
		opened ? <div data-testid="upgrade-modal" data-wall={wallKey} /> : null,
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
	popcorn_sessions: null,
	projects: null,
	reports: null,
	resets_at: null,
};

const snapshot = (overrides: Record<string, unknown> = {}) => ({
	audio_seconds: { limit: 18000, used: 7800 },
	chats: { limit: 2, used: 1 },
	free: true,
	maps: { limit: 1, used: 0 },
	period_start: "2026-10-01T00:00:00Z",
	popcorn_sessions: { limit: 1, used: 0 },
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
	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		} as unknown as typeof ResizeObserver;
	}
	vi.stubGlobal("fetch", fetchMock);
});

beforeEach(() => {
	fetchMock.mockReset();
	sessionStorage.clear();
});

afterEach(() => {
	cleanup();
});

const renderCard = () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<MemoryRouter>
						<div data-testid="host">
							<FreeAllowanceCard workspaceId="ws-1" />
						</div>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	return { client, view };
};

const meter = (key: string) => screen.getByTestId(`free-allowance-${key}`);

it("fetches the workspace's free allowance", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot()));
	renderCard();
	await screen.findByTestId("free-allowance-card");
	expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
		/\/v2\/workspaces\/ws-1\/free-allowance$/,
	);
});

it("renders nothing when the account is not free", async () => {
	fetchMock.mockResolvedValue(answer(200, NOT_FREE));
	const { client } = renderCard();
	await waitFor(() =>
		expect(
			client.getQueryState(["workspace", "ws-1", "free-allowance"])?.status,
		).toBe("success"),
	);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("renders nothing on a 403 (member without view_usage)", async () => {
	fetchMock.mockResolvedValue(answer(403, { detail: "Forbidden" }));
	const { client } = renderCard();
	await waitFor(() =>
		expect(
			client.getQueryState(["workspace", "ws-1", "free-allowance"])?.status,
		).toBe("error"),
	);
	expect(screen.getByTestId("host").innerHTML).toBe("");
});

it("shows audio as used of limit in hours and minutes", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot()));
	renderCard();
	await screen.findByTestId("free-allowance-card");
	expect(
		within(meter("audio_seconds")).getByTestId("free-allowance-value")
			.textContent,
	).toBe("2h 10m of 5h");
});

it("shows counted meters as n of m with a progress bar each", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot()));
	renderCard();
	await screen.findByTestId("free-allowance-card");
	const value = (key: string) =>
		within(meter(key)).getByTestId("free-allowance-value").textContent;
	expect(value("chats")).toBe("1 of 2");
	expect(value("reports")).toBe("0 of 1");
	expect(value("maps")).toBe("0 of 1");
	expect(value("popcorn_sessions")).toBe("0 of 1");
	expect(value("projects")).toBe("1 of 1");
	for (const key of [
		"audio_seconds",
		"chats",
		"reports",
		"maps",
		"popcorn_sessions",
		"projects",
	]) {
		expect(within(meter(key)).getByRole("progressbar")).toBeTruthy();
	}
});

it("says the allowance is shared across the organisation", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot()));
	renderCard();
	await screen.findByTestId("free-allowance-card");
	expect(
		screen.getByText("Shared across all workspaces in this organisation"),
	).toBeTruthy();
});

it("shows the reset moment in the viewer's local date and time", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot()));
	renderCard();
	await screen.findByTestId("free-allowance-card");
	const local = new Date("2026-11-01T00:00:00Z").toLocaleString("en", {
		dateStyle: "medium",
		timeStyle: "short",
	});
	expect(screen.getByTestId("free-allowance-resets").textContent).toBe(
		`Resets on ${local}`,
	);
});

it("offers the upgrade action when a meter is at its limit", async () => {
	fetchMock.mockResolvedValue(
		answer(200, snapshot({ chats: { limit: 2, used: 2 } })),
	);
	renderCard();
	await screen.findByTestId("free-allowance-card");
	fireEvent.click(screen.getByTestId("free-allowance-upgrade"));
	expect(screen.getByTestId("upgrade-modal").dataset.wall).toBe(
		"free_allowance",
	);
});

it("hides the upgrade action while every meter has room", async () => {
	fetchMock.mockResolvedValue(
		answer(200, snapshot({ projects: { limit: 1, used: 0 } })),
	);
	renderCard();
	await screen.findByTestId("free-allowance-card");
	expect(screen.queryByTestId("free-allowance-upgrade")).toBeNull();
});

it("does not offer the upgrade action for projects at 1 of 1", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot()));
	renderCard();
	await screen.findByTestId("free-allowance-card");
	expect(screen.queryByTestId("free-allowance-upgrade")).toBeNull();
	expect(
		within(meter("projects"))
			.getByRole("progressbar")
			.closest(".mantine-Progress-root")?.innerHTML,
	).not.toContain("red");
});

it("shows projects after the monthly meters, marked as not monthly", async () => {
	fetchMock.mockResolvedValue(answer(200, snapshot()));
	renderCard();
	await screen.findByTestId("free-allowance-card");
	const resets = screen.getByTestId("free-allowance-resets");
	expect(
		resets.compareDocumentPosition(meter("projects")) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		within(meter("projects")).getByTestId("free-allowance-hint").textContent,
	).toBe("(Not monthly)");
});

it("turns the projects bar red only when used exceeds the limit", async () => {
	fetchMock.mockResolvedValue(
		answer(200, snapshot({ projects: { limit: 1, used: 2 } })),
	);
	renderCard();
	await screen.findByTestId("free-allowance-card");
	expect(
		within(meter("projects"))
			.getByRole("progressbar")
			.closest(".mantine-Progress-root")?.innerHTML,
	).toContain("red");
});

it("formats the reset moment in the app language, not the browser's", async () => {
	i18n.load("nl-NL", {});
	i18n.activate("nl-NL");
	try {
		fetchMock.mockResolvedValue(answer(200, snapshot()));
		renderCard();
		await screen.findByTestId("free-allowance-card");
		const nl = new Date("2026-11-01T00:00:00Z").toLocaleString("nl-NL", {
			dateStyle: "medium",
			timeStyle: "short",
		});
		expect(screen.getByTestId("free-allowance-resets").textContent).toContain(
			nl,
		);
	} finally {
		i18n.activate("en");
	}
});
