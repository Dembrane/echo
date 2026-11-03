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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { toast } from "@/components/common/Toaster";
import type { AiBudgetOverride } from "@/hooks/useAiCosts";

vi.mock("@/components/common/Toaster", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const { AiBudgetEditor } = await import("./AiBudgetEditor");

const fetchMock = vi.fn();
const NONE: AiBudgetOverride = {
	amount_micro_eur: null,
	unlimited: false,
	until: null,
};

const ok = () =>
	new Response(JSON.stringify({ status: "ok" }), {
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
	fetchMock.mockImplementation(async () => ok());
	vi.mocked(toast.success).mockReset();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const show = (current: AiBudgetOverride = NONE) => {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={client}>
					<AiBudgetEditor accountId="acc-1" current={current} />
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);
	return { invalidate };
};

const sent = async (method: string) => {
	await waitFor(() =>
		expect(fetchMock.mock.calls.some((c) => c[1]?.method === method)).toBe(
			true,
		),
	);
	const call = fetchMock.mock.calls.find((c) => c[1]?.method === method);
	return {
		body: call?.[1]?.body ? JSON.parse(String(call[1].body)) : undefined,
		url: String(call?.[0]),
	};
};

const amountInput = () =>
	screen.getByRole("textbox", { name: "Amount per month" });

it("shows a stored end as the last covered day and saves EUR 20 in micro-euros", async () => {
	const { invalidate } = show({
		amount_micro_eur: 10_000_000,
		unlimited: false,
		until: "2027-01-01T00:00:00.000Z",
	});
	expect(amountInput()).toHaveProperty("value", "€10.00");
	expect(screen.getByRole("button", { name: "Until" }).textContent).toBe(
		"December 31, 2026",
	);
	fireEvent.change(amountInput(), { target: { value: "20" } });
	fireEvent.click(screen.getByRole("button", { name: "Save AI budget" }));

	const put = await sent("PUT");
	expect(put.url).toMatch(/\/v2\/admin\/billing-accounts\/acc-1\/ai-budget$/);
	expect(put.body).toEqual({
		amount_micro_eur: 20_000_000,
		unlimited: false,
		until: "2027-01-01",
	});
	await waitFor(() =>
		expect(toast.success).toHaveBeenCalledWith("AI budget saved"),
	);
	const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
	expect(keys).toContainEqual(["v2", "admin", "billing-rollup"]);
	expect(keys).toContainEqual(["v2", "admin", "ai-costs"]);
});

it("covers the picked last day: 31 December ends at the start of 1 January", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 10, 3, 12));
	show();
	fireEvent.change(amountInput(), { target: { value: "20" } });
	fireEvent.click(screen.getByRole("button", { name: "Until" }));
	await screen.findByRole("button", { name: "30 November 2026" });
	const next = document.querySelector('[data-direction="next"]');
	if (!next) throw new Error("no next month control");
	fireEvent.click(next);
	fireEvent.click(
		await screen.findByRole("button", { name: "31 December 2026" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Save AI budget" }));
	expect((await sent("PUT")).body).toEqual({
		amount_micro_eur: 20_000_000,
		unlimited: false,
		until: "2027-01-01",
	});
});

it("today can be the last day", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 10, 3, 12));
	show();
	fireEvent.change(amountInput(), { target: { value: "20" } });
	fireEvent.click(screen.getByRole("button", { name: "Until" }));
	expect(
		(
			await screen.findByRole("button", { name: "2 November 2026" })
		).hasAttribute("data-disabled"),
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "3 November 2026" }));
	fireEvent.click(screen.getByRole("button", { name: "Save AI budget" }));
	expect((await sent("PUT")).body).toMatchObject({ until: "2026-11-04" });
});

it("keeps at most two decimals and allows EUR 0", async () => {
	show();
	fireEvent.change(amountInput(), { target: { value: "5.555" } });
	fireEvent.click(screen.getByRole("button", { name: "Save AI budget" }));
	expect((await sent("PUT")).body).toMatchObject({
		amount_micro_eur: 5_550_000,
	});

	cleanup();
	fetchMock.mockClear();
	show();
	fireEvent.change(amountInput(), { target: { value: "0" } });
	fireEvent.click(screen.getByRole("button", { name: "Save AI budget" }));
	expect((await sent("PUT")).body).toEqual({
		amount_micro_eur: 0,
		unlimited: false,
		until: null,
	});
});

it("refuses more than EUR 1,000", () => {
	show();
	const save = screen.getByRole("button", { name: "Save AI budget" });
	fireEvent.change(amountInput(), { target: { value: "1000" } });
	expect(save).toHaveProperty("disabled", false);
	fireEvent.change(amountInput(), { target: { value: "1000.01" } });
	expect(save).toHaveProperty("disabled", true);
});

it("No limit sends unlimited without an amount", async () => {
	show();
	fireEvent.click(screen.getByRole("switch", { name: "No limit" }));
	expect(amountInput()).toHaveProperty("disabled", true);
	fireEvent.click(screen.getByRole("button", { name: "Save AI budget" }));
	expect((await sent("PUT")).body).toEqual({
		amount_micro_eur: null,
		unlimited: true,
		until: null,
	});
});

it("Clear sends DELETE and returns the account to the default", async () => {
	const { invalidate } = show({
		amount_micro_eur: null,
		unlimited: true,
		until: null,
	});
	expect(screen.getByRole("switch", { name: "No limit" })).toHaveProperty(
		"checked",
		true,
	);
	fireEvent.click(screen.getByRole("button", { name: "Clear" }));
	const del = await sent("DELETE");
	expect(del.url).toMatch(/\/v2\/admin\/billing-accounts\/acc-1\/ai-budget$/);
	expect(del.body).toBeUndefined();
	await waitFor(() =>
		expect(toast.success).toHaveBeenCalledWith("AI budget cleared"),
	);
	const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
	expect(keys).toContainEqual(["v2", "admin", "billing-rollup"]);
	expect(keys).toContainEqual(["v2", "admin", "ai-costs"]);
});

it("an account on the default has nothing to clear", () => {
	show();
	expect(screen.getByText("Uses the free plan default.")).toBeTruthy();
	expect(screen.getByRole("button", { name: "Clear" })).toHaveProperty(
		"disabled",
		true,
	);
});
