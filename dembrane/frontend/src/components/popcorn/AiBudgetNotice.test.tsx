// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { AiBudgetNotice } from "./AiBudgetNotice";

const allowance: { resets_at: string | null } = {
	resets_at: "2026-11-01T00:00:00Z",
};

vi.mock("@/hooks/useFreeAllowance", () => ({
	useFreeAllowance: () => ({ data: { free: true, ...allowance } }),
}));

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

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
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
});

afterEach(() => {
	cleanup();
	allowance.resets_at = "2026-11-01T00:00:00Z";
});

const renderNotice = (status: { exhausted: boolean } | null | undefined) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter>
						<AiBudgetNotice status={status} workspaceId="w1" projectId="p1" />
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

it("renders nothing while the AI budget has room or does not apply", () => {
	for (const status of [null, undefined, { exhausted: false }]) {
		renderNotice(status);
		expect(screen.queryByTestId("popcorn-ai-budget-notice")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
		cleanup();
	}
});

it("says popcorn is paused until the reset and opens the AI wall from its button", () => {
	renderNotice({ exhausted: true });
	const text = screen.getByTestId("popcorn-ai-budget-notice").textContent ?? "";
	expect(text).toContain(
		"This month's AI is used up, so popcorn is paused until 1 November 2026.",
	);
	expect(text).not.toContain("—");
	expect(screen.queryByTestId("upgrade-modal")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "See upgrade options" }));
	const modal = screen.getByTestId("upgrade-modal");
	expect(modal.dataset.wall).toBe("ai_budget");
	expect(modal.dataset.action).toBe("popcorn");
	expect(modal.dataset.resets).toBe("2026-11-01T00:00:00Z");
	expect(modal.dataset.tier).toBe("free");
});

it("says next month when the reset is unknown", () => {
	allowance.resets_at = null;
	renderNotice({ exhausted: true });
	const text = screen.getByTestId("popcorn-ai-budget-notice").textContent ?? "";
	expect(text).toContain(
		"This month's AI is used up, so popcorn is paused until next month.",
	);
});
