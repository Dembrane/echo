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
import type { AiCostView } from "@/hooks/useAiCosts";
import { AiCostsPanel } from "./AiCostsPanel";
import { formatAiCost } from "./aiCostBreakdown";

const fetchMock = vi.fn();

const account = (
	id: string,
	over: Partial<AiCostView["accounts"][number]> = {},
): AiCostView["accounts"][number] => ({
	account_scope: "organisation",
	billing_account_id: id,
	budget_micro_eur: 5_000_000,
	by_feature: [],
	by_model: [],
	cost_micro_eur: 0,
	custom_budget: false,
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
				{
					calls: 4,
					cost_micro_eur: 600_000,
					operation: "POST /api/chats/:chat_id",
				},
				{ calls: 9, cost_micro_eur: 500_000, operation: "conversations.chunk" },
				{
					calls: 6,
					cost_micro_eur: 400_000,
					operation: "GET /api/chats/:chat_id/suggestions",
				},
				{ calls: 1, cost_micro_eur: 3_500, operation: "nightly.mystery" },
			],
			by_model: [
				{
					calls: 15,
					cost_micro_eur: 1_200_000,
					model: "gemini-flash",
					provider: "vertex",
				},
				{
					calls: 5,
					cost_micro_eur: 303_500,
					model: "claude-sonnet",
					provider: "anthropic",
				},
			],
			cost_micro_eur: 1_503_500,
			name: "Free Org",
			percent_used: 30,
		}),
		account("paid-acc", {
			budget_micro_eur: null,
			by_feature: [
				{ calls: 2, cost_micro_eur: 2_000_000, operation: "reports.generate" },
			],
			cost_micro_eur: 2_000_000,
			name: "Paid Co",
			percent_used: null,
			tier: "changemaker",
		}),
		account("open-acc", {
			account_scope: "workspace",
			budget_micro_eur: null,
			cost_micro_eur: 3_500,
			name: "Open Workspace",
			percent_used: null,
			unlimited: true,
		}),
		account("custom-acc", {
			budget_micro_eur: 20_000_000,
			cost_micro_eur: 1_000_000,
			custom_budget: true,
			name: "Custom Org",
			override_until: "2026-12-31T00:00:00.000Z",
			percent_used: 5,
		}),
		account("over-acc", {
			cost_micro_eur: 4_100,
			name: "Over Org",
			percent_used: 104,
		}),
	],
	by_provider: [
		{ cost_micro_eur: 4_100_000, provider: "vertex" },
		{ cost_micro_eur: 570_000, provider: "anthropic" },
		// Unpriced calls only: no tile.
		{ cost_micro_eur: 0, provider: "unknown" },
	],
	deleted_accounts_micro_eur: 20_000,
	internal_micro_eur: 68_900,
	period_start: "2026-11-01T00:00:00.000Z",
	unattributed_micro_eur: 70_000,
};

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
					<AiCostsPanel onOpenAccount={onOpenAccount} />
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
		"ai-cost-row-over-acc",
		"ai-cost-row-open-acc",
	]);
	expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
		/\/v2\/admin\/ai-costs\?month_offset=0$/,
	);
});

it("shows each account's cost, budget, use and top feature group", async () => {
	show();
	await screen.findByTestId("ai-cost-row-free-acc");
	const free = within(row("free-acc"));
	expect(free.getByText("Free Org")).toBeTruthy();
	expect(free.getByText("Free, organisation account")).toBeTruthy();
	expect(free.getByText("€1.50")).toBeTruthy();
	expect(free.getByText("€5.00 default")).toBeTruthy();
	expect(free.getByText("30%")).toBeTruthy();
	// Replies and suggestions are both chat: 1.0 of 1.5035.
	expect(free.getByTestId("ai-cost-top-group").textContent).toBe("Chat 67%");

	const custom = within(row("custom-acc"));
	expect(custom.getByText("€20.00 until Dec 31, 2026")).toBeTruthy();
	expect(custom.getByText("5%")).toBeTruthy();

	const open = within(row("open-acc"));
	expect(open.getByText("Free, workspace account")).toBeTruthy();
	expect(open.getByText("No limit")).toBeTruthy();
	expect(open.getByText("€0.0035")).toBeTruthy();

	const paid = within(row("paid-acc"));
	expect(paid.getByText("Changemaker, organisation account")).toBeTruthy();
	expect(paid.getByText("Paid plan")).toBeTruthy();
	expect(paid.getByTestId("ai-cost-top-group").textContent).toBe(
		"Reports 100%",
	);

	const over = within(row("over-acc"));
	expect(over.getByText("104%")).toBeTruthy();
	expect(over.getByText("€0.0041")).toBeTruthy();
});

it("sums the month in captioned tiles", async () => {
	show();
	await screen.findByTestId("ai-cost-row-free-acc");
	const summary = within(screen.getByTestId("ai-cost-summary"));
	expect(summary.getByTestId("ai-cost-total").textContent).toBe("€4.67");
	expect(summary.getByTestId("ai-cost-accounts").textContent).toBe("5");
	expect(summary.getByTestId("ai-cost-over-budget").textContent).toBe("1");
	expect(summary.getByTestId("ai-cost-unattributed").textContent).toBe("€0.07");
	expect(summary.getByTestId("ai-cost-provider-vertex").textContent).toBe(
		"€4.10",
	);
	expect(summary.getByTestId("ai-cost-provider-anthropic").textContent).toBe(
		"€0.57",
	);
	expect(summary.getByTestId("ai-cost-internal").textContent).toBe("€0.069");
	expect(summary.getByTestId("ai-cost-charged").textContent).toBe("€4.53");
	expect(summary.getByText("incl. €0.02 from deleted accounts")).toBeTruthy();
	expect(summary.getByText("Spend")).toBeTruthy();
	expect(summary.getByText("Accounts and providers")).toBeTruthy();
	expect(summary.getByText("88% of the total")).toBeTruthy();
	expect(summary.queryByTestId("ai-cost-provider-unknown")).toBeNull();
	expect(summary.getByText("Free accounts at 100% or more")).toBeTruthy();
	expect(summary.getByText("Accounts with AI calls")).toBeTruthy();
	expect(
		summary.getByText("Calls no account could be matched to"),
	).toBeTruthy();
	expect(summary.getByText("Samples, demos and dev tools")).toBeTruthy();
});

it("the spend tiles reconcile: total is charged to accounts plus unattributed plus internal", async () => {
	show();
	await screen.findByTestId("ai-cost-row-free-acc");
	const rows = VIEW.accounts.reduce((s, a) => s + a.cost_micro_eur, 0);
	// Charged to accounts is the rows plus accounts deleted since.
	const charged = rows + VIEW.deleted_accounts_micro_eur;
	expect(screen.getByTestId("ai-cost-charged").textContent).toBe(
		formatAiCost(charged),
	);
	const parts = charged + VIEW.unattributed_micro_eur + VIEW.internal_micro_eur;
	const providers = VIEW.by_provider.reduce((s, p) => s + p.cost_micro_eur, 0);
	expect(parts).toBe(providers);
	expect(screen.getByTestId("ai-cost-total").textContent).toBe(
		formatAiCost(parts),
	);
	expect(screen.getAllByTestId(/^ai-cost-row-/)).toHaveLength(
		VIEW.accounts.length,
	);
	expect(screen.getByTestId("ai-cost-unattributed").textContent).toBe(
		formatAiCost(VIEW.unattributed_micro_eur),
	);
	expect(screen.getByTestId("ai-cost-internal").textContent).toBe(
		formatAiCost(VIEW.internal_micro_eur),
	);
});

it("a row click expands the breakdown and never opens the account", async () => {
	const { onOpenAccount } = show();
	await screen.findByTestId("ai-cost-row-free-acc");
	expect(screen.queryByTestId("ai-cost-detail-free-acc")).toBeNull();
	fireEvent.click(within(row("free-acc")).getByText("Free Org"));
	await screen.findByTestId("ai-cost-detail-free-acc");
	expect(
		within(row("free-acc"))
			.getByRole("button", { name: "Show breakdown" })
			.getAttribute("aria-expanded"),
	).toBe("true");
	fireEvent.click(within(row("free-acc")).getByText("Free Org"));
	expect(screen.queryByTestId("ai-cost-detail-free-acc")).toBeNull();
	// The chevron toggles once, not twice through the row.
	fireEvent.click(
		within(row("free-acc")).getByRole("button", { name: "Show breakdown" }),
	);
	await screen.findByTestId("ai-cost-detail-free-acc");
	expect(onOpenAccount).not.toHaveBeenCalled();
});

it("the 3 dots open the account actions without expanding the row", async () => {
	const { onOpenAccount } = show();
	await screen.findByTestId("ai-cost-row-custom-acc");
	fireEvent.click(
		within(row("custom-acc")).getByRole("button", {
			name: "Open account actions",
		}),
	);
	expect(onOpenAccount).toHaveBeenCalledWith("custom-acc");
	expect(screen.queryByTestId("ai-cost-detail-custom-acc")).toBeNull();
});

it("breaks an account down by feature group and by model", async () => {
	show();
	await screen.findByTestId("ai-cost-row-free-acc");
	fireEvent.click(within(row("free-acc")).getByText("Free Org"));
	const detail = await screen.findByTestId("ai-cost-detail-free-acc");

	const groups = within(detail).getAllByTestId(/^ai-cost-group-/);
	expect(groups.map((g) => g.getAttribute("data-testid"))).toEqual([
		"ai-cost-group-chat",
		"ai-cost-group-recording",
		"ai-cost-group-other",
	]);
	const chat = within(groups[0] as HTMLElement);
	expect(chat.getByText("Chat")).toBeTruthy();
	expect(chat.getByText("€1.00")).toBeTruthy();
	expect(chat.getByText("67%")).toBeTruthy();
	expect(chat.getByText("10 calls")).toBeTruthy();
	// Plain names, with the raw operation kept for tracing.
	expect(chat.getByText("Replies")).toBeTruthy();
	expect(chat.getByText("POST /api/chats/:chat_id")).toBeTruthy();
	expect(chat.getByText("Suggestions")).toBeTruthy();
	expect(chat.getByText("€0.60")).toBeTruthy();
	const recording = within(groups[1] as HTMLElement);
	expect(recording.getByText("Transcription")).toBeTruthy();
	expect(recording.getByText("conversations.chunk")).toBeTruthy();
	const other = within(groups[2] as HTMLElement);
	expect(other.getAllByText("nightly.mystery")).toHaveLength(1);
	expect(other.getAllByText("€0.0035").length).toBeGreaterThan(0);
	expect(other.getAllByText("<1%")).toHaveLength(2);

	const models = within(detail).getAllByTestId(/^ai-cost-model-/);
	expect(models.map((m) => m.getAttribute("data-testid"))).toEqual([
		"ai-cost-model-vertex-gemini-flash",
		"ai-cost-model-anthropic-claude-sonnet",
	]);
	// Truncated names stay readable in full on hover.
	expect(chat.getByTitle("Replies")).toBeTruthy();
	expect(within(detail).getByTitle("gemini-flash")).toBeTruthy();
	expect(models).toHaveLength(2);
	const gemini = within(models[0] as HTMLElement);
	expect(gemini.getByText("gemini-flash")).toBeTruthy();
	expect(gemini.getByText("vertex")).toBeTruthy();
	expect(gemini.getByText("€1.20")).toBeTruthy();
	expect(gemini.getByText("80%")).toBeTruthy();
	expect(gemini.getByText("15 calls")).toBeTruthy();
	expect(within(models[1] as HTMLElement).getByText("anthropic")).toBeTruthy();
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
		deleted_accounts_micro_eur: 0,
		internal_micro_eur: 0,
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
	expect(screen.queryByTestId("ai-cost-summary")).toBeNull();
	fireEvent.click(screen.getByText("Last month"));
	await screen.findByText("No AI costs recorded for October 2026.");
	expect(screen.queryByText("No AI costs recorded this month.")).toBeNull();
});

it("with spend but no account charged, keeps the tiles and says no account was charged", async () => {
	const noAccounts = (period: string) => ({
		...VIEW,
		accounts: [],
		by_provider: [{ cost_micro_eur: 110_000, provider: "vertex" }],
		deleted_accounts_micro_eur: 0,
		internal_micro_eur: 40_000,
		period_start: period,
		unattributed_micro_eur: 70_000,
	});
	fetchMock.mockImplementation(async (url: string) =>
		answer(
			String(url).endsWith("month_offset=1")
				? noAccounts("2026-10-01T00:00:00.000Z")
				: noAccounts("2026-11-01T00:00:00.000Z"),
		),
	);
	show();
	await screen.findByText("No account was charged this month.");
	expect(screen.queryByText("No AI costs recorded this month.")).toBeNull();
	expect(screen.getByTestId("ai-cost-total").textContent).toBe("€0.11");
	expect(screen.getByTestId("ai-cost-charged").textContent).toBe("€0.00");
	// The caption must not point at rows that are not there.
	expect(screen.queryByText("The account rows below")).toBeNull();
	expect(screen.getByText("No account was charged")).toBeTruthy();
	fireEvent.click(screen.getByText("Last month"));
	await screen.findByText("No account was charged in October 2026.");
});

it("on a phone shows one card per account, with the same actions", async () => {
	const media = vi.spyOn(window, "matchMedia").mockImplementation(
		(query: string) =>
			({
				addEventListener: () => {},
				addListener: () => {},
				dispatchEvent: () => false,
				matches: query.includes("max-width"),
				media: query,
				onchange: null,
				removeEventListener: () => {},
				removeListener: () => {},
			}) as MediaQueryList,
	);
	try {
		const { onOpenAccount } = show();
		const free = within(await screen.findByTestId("ai-cost-row-free-acc"));
		expect(screen.queryByRole("table")).toBeNull();
		expect(free.getByText("Top feature group")).toBeTruthy();
		expect(free.getByText("€1.50")).toBeTruthy();
		expect(free.getByText("€5.00 default")).toBeTruthy();
		expect(free.getByTestId("ai-cost-top-group").textContent).toBe("Chat 67%");
		expect(free.getByTitle("Free Org")).toBeTruthy();
		fireEvent.click(free.getByText("Free Org"));
		await screen.findByTestId("ai-cost-detail-free-acc");
		fireEvent.click(free.getByRole("button", { name: "Open account actions" }));
		expect(onOpenAccount).toHaveBeenCalledWith("free-acc");
		expect(screen.getByTestId("ai-cost-detail-free-acc")).toBeTruthy();
	} finally {
		media.mockRestore();
	}
});
