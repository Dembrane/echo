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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { AiBudgetOverride, AiCostView } from "@/hooks/useAiCosts";
import { AiCostsPanel } from "./AiCostsPanel";

const fetchMock = vi.fn();

const account = (
	id: string,
	over: Partial<AiCostView["accounts"][number]> = {},
): AiCostView["accounts"][number] => ({
	billing_account_id: id,
	budget_micro_eur: 5_000_000,
	by_feature: [],
	by_model: [],
	cost_micro_eur: 0,
	name: id,
	override_until: null,
	percent_used: 0,
	tier: "free",
	unlimited: false,
	...over,
});

// Deliberately not in cost order.
const VIEW: AiCostView = {
	accounts: [
		account("free-acc", {
			by_feature: [
				{ cost_micro_eur: 1_000_000, operation: "chat.reply" },
				{ cost_micro_eur: 300_000, operation: "report.generate" },
				{ cost_micro_eur: 150_000, operation: "map.generate" },
				{ cost_micro_eur: 50_000, operation: "verify.generate" },
			],
			by_model: [
				{ cost_micro_eur: 1_200_000, model: "gemini-flash" },
				{ cost_micro_eur: 300_000, model: "claude" },
			],
			cost_micro_eur: 1_500_000,
			name: "Free Org",
			percent_used: 30,
		}),
		account("paid-acc", {
			budget_micro_eur: null,
			cost_micro_eur: 2_000_000,
			name: "Paid Co",
			percent_used: null,
			tier: "changemaker",
		}),
		account("open-acc", {
			budget_micro_eur: null,
			cost_micro_eur: 100_000,
			name: "Open Org",
			percent_used: null,
			unlimited: true,
		}),
		account("custom-acc", {
			budget_micro_eur: 20_000_000,
			cost_micro_eur: 1_000_000,
			name: "Custom Org",
			override_until: "2026-12-31T00:00:00.000Z",
			percent_used: 5,
		}),
	],
	by_provider: [
		{ cost_micro_eur: 4_100_000, provider: "vertex" },
		{ cost_micro_eur: 570_000, provider: "anthropic" },
	],
	period_start: "2026-11-01T00:00:00.000Z",
	unattributed_micro_eur: 70_000,
};

const OVERRIDES = new Map<string, AiBudgetOverride>([
	[
		"custom-acc",
		{
			amount_micro_eur: 20_000_000,
			unlimited: false,
			until: "2026-12-31T00:00:00.000Z",
		},
	],
	["open-acc", { amount_micro_eur: null, unlimited: true, until: null }],
	["free-acc", { amount_micro_eur: null, unlimited: false, until: null }],
]);

const answer = (body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status: 200,
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
	fetchMock.mockImplementation(async () => answer(VIEW));
});

afterEach(() => {
	cleanup();
});

const show = (onOpenAccount = vi.fn()) => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<AiCostsPanel onOpenAccount={onOpenAccount} overrides={OVERRIDES} />
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	return { onOpenAccount };
};

const row = (id: string) => screen.getByTestId(`ai-cost-row-${id}`);

it("lists the accounts by cost, most expensive first", async () => {
	show();
	await screen.findByTestId("ai-cost-row-paid-acc");
	expect(
		screen
			.getAllByTestId(/^ai-cost-row-/)
			.map((r) => r.getAttribute("data-testid")),
	).toEqual([
		"ai-cost-row-paid-acc",
		"ai-cost-row-free-acc",
		"ai-cost-row-custom-acc",
		"ai-cost-row-open-acc",
	]);
	expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
		/\/v2\/admin\/ai-costs\?month_offset=0$/,
	);
});

it("shows cost, budget and percentage per account", async () => {
	show();
	await screen.findByTestId("ai-cost-row-free-acc");
	const free = within(row("free-acc"));
	expect(free.getByText("Free Org")).toBeTruthy();
	expect(free.getByText("€1.50")).toBeTruthy();
	expect(free.getByText("Default")).toBeTruthy();
	expect(free.getByText("30%")).toBeTruthy();
	expect(row("free-acc").textContent).toContain("chat.reply");
	expect(row("free-acc").textContent).toContain("map.generate");
	expect(row("free-acc").textContent).not.toContain("verify.generate");

	expect(within(row("open-acc")).getByText("No limit")).toBeTruthy();
	const custom = within(row("custom-acc"));
	expect(custom.getByText("€20.00")).toBeTruthy();
	expect(custom.queryByText("Default")).toBeNull();
	expect(within(row("paid-acc")).queryByText("Default")).toBeNull();
	expect(within(row("paid-acc")).queryByText("No limit")).toBeNull();
});

it("sums the month: total, per provider and unattributed", async () => {
	show();
	await screen.findByTestId("ai-cost-row-free-acc");
	const summary = within(screen.getByTestId("ai-cost-summary"));
	expect(summary.getByTestId("ai-cost-total").textContent).toBe("€4.67");
	expect(summary.getByTestId("ai-cost-provider-vertex").textContent).toBe(
		"€4.10",
	);
	expect(summary.getByTestId("ai-cost-provider-anthropic").textContent).toBe(
		"€0.57",
	);
	expect(summary.getByTestId("ai-cost-unattributed").textContent).toBe("€0.07");
});

it("expands an account into its full feature and model breakdown", async () => {
	const { onOpenAccount } = show();
	await screen.findByTestId("ai-cost-row-free-acc");
	expect(screen.queryByTestId("ai-cost-detail-free-acc")).toBeNull();
	fireEvent.click(
		within(row("free-acc")).getByRole("button", { name: "Show breakdown" }),
	);
	const detail = within(await screen.findByTestId("ai-cost-detail-free-acc"));
	expect(detail.getByText("verify.generate")).toBeTruthy();
	expect(detail.getByText("€0.05")).toBeTruthy();
	expect(detail.getByText("gemini-flash")).toBeTruthy();
	expect(detail.getByText("€1.20")).toBeTruthy();
	expect(detail.getByText("claude")).toBeTruthy();
	expect(onOpenAccount).not.toHaveBeenCalled();
});

it("a row click opens the account", async () => {
	const { onOpenAccount } = show();
	await screen.findByTestId("ai-cost-row-custom-acc");
	fireEvent.click(within(row("custom-acc")).getByText("Custom Org"));
	expect(onOpenAccount).toHaveBeenCalledWith("custom-acc");
});

it("switches to last month", async () => {
	show();
	await screen.findByTestId("ai-cost-row-free-acc");
	fireEvent.click(screen.getByText("Last month"));
	await waitFor(() =>
		expect(
			fetchMock.mock.calls.some((c) =>
				String(c[0]).endsWith("/v2/admin/ai-costs?month_offset=1"),
			),
		).toBe(true),
	);
});

it("says no AI costs for this month, and names the month for last month", async () => {
	const empty = (period: string) => ({
		...VIEW,
		accounts: [],
		by_provider: [],
		period_start: period,
		unattributed_micro_eur: 0,
	});
	fetchMock.mockImplementation(async (url: string) =>
		answer(
			String(url).endsWith("month_offset=1")
				? empty("2026-10-01T00:00:00.000Z")
				: empty("2026-11-01T00:00:00.000Z"),
		),
	);
	show();
	await screen.findByText("No AI costs recorded this month.");
	fireEvent.click(screen.getByText("Last month"));
	await screen.findByText("No AI costs recorded for October 2026.");
	expect(screen.queryByText("No AI costs recorded this month.")).toBeNull();
});
